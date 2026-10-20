// Serial paper-only adapter; entry and position gates remain in the core.
import { easternParts, runBot } from './index.js';
import { runSession } from './session.js';
import { paperOnlyTransport } from './paper-restart.js';

export async function runOngoingPaper(env, { phase, now = () => new Date(),
  fetchImpl = globalThis.fetch, run = runBot, session = runSession,
  log = value => console.log(JSON.stringify(value)),
} = {}) {
  if (env.ONGOING_PAPER_APPROVED !== 'true' || env.PAPER_RESTART_APPROVED !== 'true' || env.TRADING_ENABLED !== 'true') {
    throw new Error('ongoing-paper-not-approved');
  }
  if (!['morning', 'closing'].includes(phase)) throw new Error('invalid-paper-phase');
  const at = now();
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(at);
  const { minutes } = easternParts(at);
  if (['Sat', 'Sun'].includes(day) || minutes < 580 || minutes >= 960) {
    log({ event: 'ongoing-paper-skipped', paperOnly: true, reason: 'outside-session' });
    return;
  }
  if (!env.ALPACA_API_KEY_ID || !env.ALPACA_API_SECRET_KEY) throw new Error('credentials-unconfigured');
  const original = globalThis.fetch;
  globalThis.fetch = paperOnlyTransport(fetchImpl);
  try {
    const response = await globalThis.fetch('https://paper-api.alpaca.markets/v2/clock', { headers: {
      'APCA-API-KEY-ID': env.ALPACA_API_KEY_ID, 'APCA-API-SECRET-KEY': env.ALPACA_API_SECRET_KEY,
    } });
    if (!response.ok) throw new Error('paper-clock-unavailable');
    const clock = await response.json();
    const age = now().getTime() - Date.parse(clock.timestamp);
    if (clock.is_open !== true || !Number.isFinite(age) || Math.abs(age) > 60_000) throw new Error('market-clock-not-ready');
    // Verify current account access without mutations. Missing entry data must
    // not suppress account/time/loss exits or protective stops in the session.
    const check = await run({ ...env, TRADING_ENABLED: 'false' }, now());
    if (['blocked-account', 'market-closed'].includes(check.action)) throw new Error('account-or-market-not-ready');
    const currentClockAge = now().getTime() - Date.parse(clock.timestamp);
    if (Math.abs(currentClockAge) > 60_000) throw new Error('market-clock-not-ready');
    log({ event: 'ongoing-paper-preflight', paperOnly: true, phase, action: check.action });
    globalThis.fetch = paperOnlyTransport(fetchImpl, { allowOrders: true });
    // runBot enforces 09:40–14:30 entries, per-symbol/benchmark data gates, and
    // position safeguards on EVERY check. After 14:30 this is management-only.
    return await session(env, { sessionMinutes: env.PAPER_SUPERVISED_TEST === 'true' ? 5 : phase === 'morning' ? 210 : 340,
      now, run, log });
  } finally {
    globalThis.fetch = original;
  }
}
