import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getConfig } from '../src/index.js';
import { assertRestartGate, paperOnlyTransport, runGatedPaper } from '../src/paper-restart.js';

const now = new Date('2026-10-20T13:45:00Z');
function ready() {
  return { result: 'connected', paperOnly: true, effectiveTradingEnabled: false, submittedOrderRequests: 0,
    account: { connected: true, accountBlocked: false, tradingBlocked: false },
    clock: { isOpen: true, timestamp: now.toISOString() },
    marketData: { symbols: [...getConfig({}).universe, 'SPY', 'QQQ'].map(symbol => ({
      symbol, count: 20, fresh: true, latestBarAt: '2026-10-20T13:40:00Z',
    })) } };
}

test('restart gate rejects closed, blocked, incomplete and stale inputs despite a successful connection', () => {
  assert.doesNotThrow(() => assertRestartGate(ready(), {}, now));
  for (const change of [
    r => r.clock.isOpen = false,
    r => r.account.tradingBlocked = true,
    r => r.account.accountBlocked = true,
    r => r.clock.timestamp = '2026-10-20T13:40:00Z',
    r => r.marketData.symbols.pop(),
    r => r.marketData.symbols.find(item => item.symbol === 'SPY').count = 14,
    r => r.marketData.symbols.find(item => item.symbol === 'SPY').latestBarAt = '2026-10-20T13:30:00Z',
    r => r.marketData.symbols.find(item => item.symbol === 'SPY').latestBarAt = '2026-10-20T13:50:00Z',
    r => r.marketData.symbols.find(item => item.symbol === 'SPY').fresh = false,
    r => r.submittedOrderRequests = 1,
  ]) {
    const result = ready(); change(result);
    assert.throws(() => assertRestartGate(result, {}, now));
  }
  assert.throws(() => assertRestartGate(ready(), {}, new Date('2026-10-20T19:00:00Z')), /outside-entry-window/);
});

test('paper transport blocks live hosts, cross-host mutations and redirects; preflight cannot mutate', async () => {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return new Response('{}'); };
  for (const allowOrders of [false, true]) {
    const transport = paperOnlyTransport(fetch, { allowOrders });
    for (const url of ['https://api.alpaca.markets/v2/orders', 'https://data.alpaca.markets/v2/orders',
      'http://paper-api.alpaca.markets/v2/orders', 'https://user@paper-api.alpaca.markets/v2/orders',
      'https://paper-api.alpaca.markets:8443/v2/orders', 'https://paper-api.alpaca.markets/v2/account']) {
      await assert.rejects(transport(url, { method: 'POST', body: '{}' }), /paper-transport-refused/);
    }
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      if (allowOrders) await transport('https://paper-api.alpaca.markets/v2/orders/123', { method });
      else await assert.rejects(transport('https://paper-api.alpaca.markets/v2/orders/123', { method }));
    }
  }
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.init.redirect === 'error'));
});

test('scheduled validation forces false even if enabled in inherited settings and restores transport', async () => {
  const original = globalThis.fetch;
  let checks = 0;
  await runGatedPaper({ TRADING_ENABLED: 'true', PAPER_RESTART_APPROVED: 'true' }, {
    now: () => now, validate: async env => {
      assert.equal(env.TRADING_ENABLED, 'false');
      await assert.rejects(globalThis.fetch('https://paper-api.alpaca.markets/v2/orders', { method: 'POST' }));
      return ready();
    },
    run: async env => {
      checks++; assert.equal(env.TRADING_ENABLED, 'false');
      return { action: 'no-signal', data: { symbols: ready().marketData.symbols } };
    }, session: async () => assert.fail('must not start orders'), log: () => {},
  });
  assert.equal(checks, 1);
  assert.equal(globalThis.fetch, original);
});

test('failed or expired validation prevents both strategy check and order session', async () => {
  const original = globalThis.fetch;
  const env = { TRADING_ENABLED: 'true', PAPER_RESTART_APPROVED: 'true' };
  for (const allowOrders of [false, true]) {
    await assert.rejects(runGatedPaper(env, { allowOrders, now: () => now,
      validate: async () => { const r = ready(); r.clock.isOpen = false; return r; },
      run: async () => assert.fail('must not run'), session: async () => assert.fail('must not start'), log: () => {},
    }), /account-or-market-not-ready/);
    assert.equal(globalThis.fetch, original);
  }
});

test('paper session requires explicit approval and a new successful current gate', async () => {
  let sessions = 0;
  for (const env of [{}, { TRADING_ENABLED: 'true' }, { PAPER_RESTART_APPROVED: 'true' }]) {
    await assert.rejects(runGatedPaper(env, { allowOrders: true,
      validate: async () => assert.fail('approval must precede credentials') }), /paper-orders-not-approved/);
  }
  await runGatedPaper({ TRADING_ENABLED: 'true', PAPER_RESTART_APPROVED: 'true', SESSION_MAX_MINUTES: '15' }, {
    allowOrders: true, now: () => now, validate: async () => ready(), log: () => {},
    fetchImpl: async (url, init) => { assert.equal(new URL(url).hostname, 'paper-api.alpaca.markets');
      assert.equal(init.redirect, 'error'); return new Response('{}'); },
    session: async (env, options) => {
      sessions++; assert.equal(env.TRADING_ENABLED, 'true'); assert.equal(options.sessionMinutes, 15);
      await globalThis.fetch('https://paper-api.alpaca.markets/v2/orders', { method: 'POST', body: '{}' });
      await assert.rejects(globalThis.fetch('https://api.alpaca.markets/v2/orders', { method: 'POST' }));
    },
  });
  assert.equal(sessions, 1);
});

test('bounded workflow defaults to read-only and requires explicit main-branch manual paper test', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/paper-window-validation.yml', import.meta.url), 'utf8');
  assert.match(workflow, /45 13 20 10 \*/);
  assert.match(workflow, /== 2026-10-20/);
  assert.match(workflow, /TRADING_ENABLED: 'false'/);
  assert.match(workflow, /timeout-minutes: 10/);
  assert.match(workflow, /group: alpaca-paper-bot/);
  assert.match(workflow, /default: false/);
  assert.match(workflow, /\$PAPER_TEST.*true.*\$EVENT_NAME.*workflow_dispatch.*\$REF.*refs\/heads\/main/);
  assert.match(workflow, /TRADING_ENABLED=true PAPER_RESTART_APPROVED=true SESSION_MAX_MINUTES=5 node tools\/run-paper-restart.mjs --paper-orders/);
  assert.match(workflow, /else\s+node tools\/run-paper-restart.mjs\s+fi/);
});


test('rejected stale preflight preserves sanitized bar evidence without running strategy or orders', async () => {
  const evidence = ready();
  const index = evidence.marketData.symbols.findIndex(item => item.symbol === 'SPY');
  evidence.marketData.symbols[index] = { ...evidence.marketData.symbols[index],
    fresh: false, latestBarAt: '2026-10-20T13:20:00Z', ageSeconds: 1500, reason: 'stale-bars' };
  const logs = [];
  await assert.rejects(runGatedPaper({}, { now: () => now, validate: async () => evidence,
    log: value => logs.push(value), run: async () => assert.fail('must not run strategy'),
    session: async () => assert.fail('must not start orders'),
  }), /entry-data-not-fresh/);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'read-only-preflight');
  assert.equal(logs[0].effectiveTradingEnabled, false);
  assert.equal(logs[0].submittedOrderRequests, 0);
  assert.deepEqual(logs[0].marketData.symbols[index], evidence.marketData.symbols[index]);
  assert.equal(logs[0].ordersAuthorizedByValidation, false);
});


test('restart accepts healthy candidates with unhealthy peers but still requires both benchmarks', () => {
  for (const issue of ['stale', 'sparse', 'missing']) {
    const r = ready();
    const nvdd = r.marketData.symbols.find(item => item.symbol === 'NVDD');
    if (issue === 'stale') { nvdd.fresh = false; nvdd.latestBarAt = '2026-10-20T13:20:00Z'; }
    if (issue === 'sparse') nvdd.count = 5;
    if (issue === 'missing') r.marketData.symbols = r.marketData.symbols.filter(item => item !== nvdd);
    assert.doesNotThrow(() => assertRestartGate(r, {}, now));
    r.marketData.symbols.find(item => item.symbol === 'QQQ').count = 14;
    assert.throws(() => assertRestartGate(r, {}, now), /entry-data-not-fresh/);
  }
  assert.throws(() => assertRestartGate(ready(), { UNIVERSE: 'UNKNOWN' }, now), /entry-data-not-fresh/);
});
