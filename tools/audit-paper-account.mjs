import { pathToFileURL } from 'node:url';
import { appendFileSync } from 'node:fs';

export function auditOnlyTransport(fetchImpl) {
  return async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = (init.method || input?.method || 'GET').toUpperCase();
    if (url.protocol !== 'https:' || url.hostname !== 'paper-api.alpaca.markets' ||
        url.username || url.password || url.port || method !== 'GET' || init.body || input?.body ||
        !['/v2/positions', '/v2/orders', '/v2/clock'].includes(url.pathname)) {
      throw new Error('audit-transport-refused');
    }
    return fetchImpl(input, { ...init, method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000) });
  };
}
const iso = value => {
  const date = new Date(value);
  if (typeof value !== 'string' || !Number.isFinite(date.getTime())) throw new Error('invalid-audit-payload');
  return date.toISOString();
};
const symbol = value => {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9.\/-]{0,14}$/.test(value)) throw new Error('invalid-audit-payload');
  return value;
};
const quantity = value => {
  if (!['string', 'number'].includes(typeof value) || !Number.isFinite(Number(value))) throw new Error('invalid-audit-payload');
  return String(value);
};
const allowed = (value, values) => values.includes(value) ? value : 'other';
function orderSummary(order) {
  return { symbol: symbol(order.symbol), side: allowed(order.side, ['buy', 'sell']),
    type: allowed(order.type, ['market', 'limit', 'stop', 'stop_limit', 'trailing_stop']),
    status: allowed(order.status, ['new', 'partially_filled', 'filled', 'done_for_day', 'canceled',
      'expired', 'replaced', 'pending_cancel', 'pending_replace', 'accepted', 'pending_new', 'accepted_for_bidding',
      'stopped', 'rejected', 'suspended', 'calculated', 'held']),
    submittedAt: iso(order.submitted_at) };
}
export async function auditPaperAccount(env, { after, now = new Date(), fetchImpl = globalThis.fetch } = {}) {
  if (!env.ALPACA_API_KEY_ID || !env.ALPACA_API_SECRET_KEY) throw new Error('credentials-unconfigured');
  const since = iso(after);
  const age = now.getTime() - Date.parse(since);
  if (age < 0 || age > 24 * 60 * 60_000) throw new Error('invalid-audit-window');
  const fetch = auditOnlyTransport(fetchImpl);
  const get = async path => {
    const response = await fetch('https://paper-api.alpaca.markets' + path, { headers: {
      'APCA-API-KEY-ID': env.ALPACA_API_KEY_ID, 'APCA-API-SECRET-KEY': env.ALPACA_API_SECRET_KEY,
    } });
    if (!response.ok) throw new Error('paper-request-' + response.status);
    return response.json();
  };
  const query = status => new URLSearchParams({ status, limit: '500', direction: 'asc', nested: 'false',
    ...(status === 'all' ? { after: since, until: now.toISOString() } : {}) });
  const [positions, openOrders, recentOrders, clock] = await Promise.all([
    get('/v2/positions'), get('/v2/orders?' + query('open')), get('/v2/orders?' + query('all')), get('/v2/clock'),
  ]);
  if (![positions, openOrders, recentOrders].every(Array.isArray) || typeof clock?.is_open !== 'boolean') {
    throw new Error('invalid-audit-payload');
  }
  // Never call a capped response an exact account-wide count.
  const complete = openOrders.length < 500 && recentOrders.length < 500;
  return { event: 'read-only-paper-account-audit', paperOnly: true, effectiveTradingEnabled: false,
    submittedOrderRequests: 0, window: { after: since, until: now.toISOString() },
    completedAt: new Date().toISOString(), marketClock: { isOpen: clock.is_open, timestamp: iso(clock.timestamp) },
    positions: positions.map(p => ({ symbol: symbol(p.symbol), quantity: quantity(p.qty), side: allowed(p.side, ['long', 'short']) })),
    positionCount: positions.length, openOrderCount: openOrders.length, recentPaperOrderCount: recentOrders.length,
    countsComplete: complete, openOrders: openOrders.map(orderSummary), recentOrders: recentOrders.map(orderSummary) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = JSON.stringify(await auditPaperAccount(process.env, { after: process.env.AUDIT_AFTER }));
    console.log(result);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      '\nGET-only paper account audit:\n\n```json\n' + result + '\n```\n');
  } catch (error) {
    const reason = /^(credentials-unconfigured|audit-transport-refused|invalid-audit-payload|invalid-audit-window|paper-request-\d{3})$/.test(error?.message)
      ? error.message : 'paper-audit-failed';
    console.error(JSON.stringify({ event: 'read-only-paper-audit-failed', paperOnly: true, reason }));
    process.exitCode = 1;
  }
}
