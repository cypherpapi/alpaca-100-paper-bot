import { dataEligibility, easternParts, getConfig, runBot } from './index.js';
import { runSession } from './session.js';
import { validatePaperReadOnly } from '../tools/validate-paper-readonly.mjs';

// This transport is installed before credentials can reach any request. Redirects
// are errors, including redirects from an otherwise approved paper endpoint.
export function paperOnlyTransport(fetchImpl, { allowOrders = false } = {}) {
  return async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = (init.method || input?.method || 'GET').toUpperCase();
    const paper = url.hostname === 'paper-api.alpaca.markets';
    const data = url.hostname === 'data.alpaca.markets';
    const orderPath = /^\/v2\/orders(?:\/[^/]+)?$/.test(url.pathname);
    const permitted = method === 'GET' ? (paper || data)
      : allowOrders && paper && orderPath && ['POST', 'PATCH', 'DELETE'].includes(method);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !permitted ||
        (method === 'GET' && (init.body || input?.body))) {
      throw new Error('paper-transport-refused');
    }
    return fetchImpl(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  };
}

export function assertRestartGate(result, env, now = new Date()) {
  const config = getConfig(env);
  const { minutes } = easternParts(now);
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(now);
  if (['Sat', 'Sun'].includes(day) || minutes < config.entryStartMinutes || minutes > config.entryEndMinutes) {
    throw new Error('outside-entry-window');
  }
  if (result.result !== 'connected' || result.paperOnly !== true ||
      result.effectiveTradingEnabled !== false || result.submittedOrderRequests !== 0 ||
      result.account?.connected !== true || result.account.accountBlocked !== false ||
      result.account.tradingBlocked !== false || result.clock?.isOpen !== true) {
    throw new Error('account-or-market-not-ready');
  }
  const clockAge = now.getTime() - Date.parse(result.clock.timestamp);
  if (!Number.isFinite(clockAge) || Math.abs(clockAge) > 60_000) throw new Error('invalid-market-clock');
  const eligibility = dataEligibility(result.marketData?.symbols || [], config.universe, now);
  if (!eligibility.benchmarksHealthy || eligibility.eligibleSymbols.length === 0) {
    throw new Error('entry-data-not-fresh');
  }
}

// No activation switch is persisted by validation. A future order process must
// explicitly opt in and pass a new gate using actual current account/data.
export async function runGatedPaper(env, {
  allowOrders = false, now = () => new Date(), validate = validatePaperReadOnly,
  run = runBot, session = runSession, fetchImpl = globalThis.fetch,
  log = value => console.log(JSON.stringify(value)),
} = {}) {
  if (allowOrders && (env.PAPER_RESTART_APPROVED !== 'true' || env.TRADING_ENABLED !== 'true')) {
    throw new Error('paper-orders-not-approved');
  }
  const original = globalThis.fetch;
  globalThis.fetch = paperOnlyTransport(fetchImpl); // GET-only throughout preflight.
  try {
    const result = await validate({ ...env, TRADING_ENABLED: 'false' }, { now: now(), fetchImpl: globalThis.fetch });
    // Validation already strips account identity, balances, credentials, and raw payloads.
    // Preserve bar timestamps/counts even when the readiness gate rejects them.
    log({ ...result, event: 'read-only-preflight', readyForPaperOrders: false });
    assertRestartGate(result, env, now());
    log({ ...result, event: 'entry-window-gate-passed', readyForPaperOrders: false });
    if (!allowOrders) {
      const check = await run({ ...env, TRADING_ENABLED: 'false' }, now());
      if (['blocked-account', 'market-closed'].includes(check.action) || check.dataError ||
          !check.data?.symbols?.length ||
          !dataEligibility(check.data.symbols, getConfig(env).universe, now()).benchmarksHealthy ||
          dataEligibility(check.data.symbols, getConfig(env).universe, now()).eligibleSymbols.length === 0) {
        throw new Error('dry-run-check-not-ready');
      }
      log({ event: 'read-only-strategy-check', paperOnly: true, effectiveTradingEnabled: false,
        action: check.action, rankings: check.rankings, data: check.data, submittedOrderRequests: 0 });
      return check;
    }
    const sessionMinutes = Number(env.SESSION_MAX_MINUTES || 15);
    if (!Number.isInteger(sessionMinutes) || sessionMinutes < 1 || sessionMinutes > 350) {
      throw new Error('invalid-session-duration');
    }
    globalThis.fetch = paperOnlyTransport(fetchImpl, { allowOrders: true });
    return await session({ ...env, TRADING_ENABLED: 'true' }, { sessionMinutes, now, log });
  } finally {
    globalThis.fetch = original;
  }
}
