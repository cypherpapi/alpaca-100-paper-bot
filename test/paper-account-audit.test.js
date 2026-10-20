import test from 'node:test';
import assert from 'node:assert/strict';
import { auditOnlyTransport, auditPaperAccount } from '../tools/audit-paper-account.mjs';
const now = new Date('2026-10-20T17:50:00Z');
const after = '2026-10-20T17:35:24Z';
const env = { ALPACA_API_KEY_ID: 'fixture-key', ALPACA_API_SECRET_KEY: 'fixture-secret', TRADING_ENABLED: 'true' };
const order = { symbol: 'TQQQ', side: 'sell', type: 'stop', status: 'new', submitted_at: after,
  id: 'private-id', account_id: 'private-account', limit_price: 'private-price' };
const response = body => new Response(JSON.stringify(body));
function fixture({ capped = false } = {}) {
  const calls = [];
  return { calls, fetch: async (input, init) => {
    const url = new URL(input); calls.push({ url, init });
    if (url.pathname === '/v2/clock') return response({ is_open: true, timestamp: now.toISOString() });
    if (url.pathname === '/v2/positions') return response([{ symbol: 'TQQQ', qty: '0.25', side: 'long', market_value: 'private-balance' }]);
    if (url.searchParams.get('status') === 'open') return response([order]);
    return response(Array.from({ length: capped ? 500 : 2 }, () => order));
  } };
}
test('audit permits only fixed paper GET surfaces and rejects mutation, live hosts, redirects and bodies', async () => {
  const transport = auditOnlyTransport(async () => assert.fail('must not fetch'));
  for (const [url, init] of [
    ['https://paper-api.alpaca.markets/v2/orders', { method: 'POST' }],
    ['https://paper-api.alpaca.markets/v2/orders/123', {}],
    ['https://api.alpaca.markets/v2/positions', {}],
    ['https://data.alpaca.markets/v2/positions', {}],
    ['http://paper-api.alpaca.markets/v2/orders', {}],
    ['https://user@paper-api.alpaca.markets/v2/orders', {}],
    ['https://paper-api.alpaca.markets/v2/orders', { body: '{}' }],
  ]) await assert.rejects(transport(url, init), /audit-transport-refused/);
});
test('audit reports timestamped positions and counts without account identity, balances, order IDs or credentials', async () => {
  const mock = fixture();
  const result = await auditPaperAccount(env, { after, now, fetchImpl: mock.fetch });
  assert.equal(result.positionCount, 1); assert.equal(result.openOrderCount, 1);
  assert.equal(result.recentPaperOrderCount, 2); assert.equal(result.countsComplete, true);
  assert.deepEqual(result.positions, [{ symbol: 'TQQQ', quantity: '0.25', side: 'long' }]);
  assert.equal(result.effectiveTradingEnabled, false); assert.equal(result.submittedOrderRequests, 0);
  assert.ok(mock.calls.every(c => c.init.method === 'GET' && c.init.redirect === 'error'));
  const recent = mock.calls.find(c => c.url.searchParams.get('status') === 'all').url;
  assert.equal(recent.searchParams.get('after'), new Date(after).toISOString());
  assert.equal(recent.searchParams.get('until'), now.toISOString());
  for (const secret of ['private-id', 'private-account', 'private-balance', 'private-price', 'fixture-secret', 'fixture-key']) {
    assert.ok(!JSON.stringify(result).includes(secret));
  }
});
test('capped responses are explicitly incomplete and invalid windows make no requests', async () => {
  const result = await auditPaperAccount(env, { after, now, fetchImpl: fixture({ capped: true }).fetch });
  assert.equal(result.countsComplete, false);
  for (const invalid of ['invalid', '2026-10-19T10:00:00Z', '2026-10-20T18:00:00Z']) {
    await assert.rejects(auditPaperAccount(env, { after: invalid, now, fetchImpl: async () => assert.fail('no request') }));
  }
});
