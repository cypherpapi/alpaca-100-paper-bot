import test from "node:test";
import assert from "node:assert/strict";
import worker, { fetchBars, barFreshness, MAX_BAR_AGE_MS, runBot } from "../src/index.js";
import { runSession } from "../src/session.js";

const now = new Date("2026-10-15T15:00:00Z");
const env = { ALPACA_API_KEY_ID: "mock-key", ALPACA_API_SECRET_KEY: "mock-secret", TRADING_ENABLED: "false", UNIVERSE: "TQQQ" };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const bar = (t, c = 100) => ({ t, c, o: c, h: c + 1, l: c - 1, v: 1000 });
async function mockFetch(fn, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  try { return await run(); } finally { globalThis.fetch = original; }
}

test("pagination retains every symbol, encodes tokens, deduplicates and sorts", async () => {
  const urls = [];
  await mockFetch(async (url) => {
    urls.push(new URL(url));
    return response(urls.length === 1
      ? { bars: { TQQQ: [bar("2026-10-15T14:55:00Z"), bar("2026-10-15T14:50:00Z")] }, next_page_token: "a+/=" }
      : { bars: { TQQQ: [bar("2026-10-15T14:55:00Z", 101)], SPY: [bar("2026-10-15T14:55:00Z")] }, next_page_token: null });
  }, async () => {
    const stats = {};
    const result = await fetchBars(env, ["TQQQ", "SPY"], now, stats);
    assert.equal(stats.pages, 2);
    assert.equal(result.TQQQ.length, 2);
    assert.equal(result.TQQQ.at(-1).c, 101);
    assert.equal(result.SPY.length, 1);
    assert.equal(urls[1].searchParams.get("page_token"), "a+/=");
    for (const key of ["start", "end", "symbols", "feed", "timeframe"]) {
      assert.equal(urls[0].searchParams.get(key), urls[1].searchParams.get(key));
    }
  });
});

test("repeated page tokens fail without returning a partial dataset", async () => {
  let calls = 0;
  await mockFetch(async () => { calls++; return response({ bars: {}, next_page_token: "again" }); },
    () => assert.rejects(fetchBars(env, ["SPY"], now), /pagination-cycle/));
  assert.equal(calls, 2);
});

test("excessive pagination is bounded", async () => {
  let calls = 0;
  await mockFetch(async () => response({ bars: {}, next_page_token: String(++calls) }),
    () => assert.rejects(fetchBars(env, ["SPY"], now), /pagination-limit/));
  assert.equal(calls, 100);
});

test("a later page failure fails the complete fetch", async () => {
  let calls = 0;
  await mockFetch(async () => ++calls === 1
    ? response({ bars: { SPY: [bar(now.toISOString())] }, next_page_token: "next" })
    : response({ message: "mock-secret must never be logged" }, 503),
    () => assert.rejects(fetchBars(env, ["SPY"], now), (error) => {
      assert.equal(error.message, "Alpaca request failed (503)");
      return true;
    }));
});

test("malformed bar containers fail explicitly", async () => {
  for (const payload of [{}, { bars: [] }, { bars: { SPY: null } }]) {
    await mockFetch(async () => response(payload),
      () => assert.rejects(fetchBars(env, ["SPY"], now), /invalid-bars-response/));
  }
});

test("freshness distinguishes missing, stale, invalid, future and boundary bars", () => {
  const at = (offset) => bar(new Date(now.getTime() + offset).toISOString());
  const result = barFreshness({
    fresh: [at(-300_000)], boundary: [at(-MAX_BAR_AGE_MS)],
    stale: [at(-MAX_BAR_AGE_MS - 1)], future: [at(1)],
    invalid: [bar("broken")], priorDay: [bar("2026-10-14T19:55:00Z")],
  }, ["fresh", "boundary", "stale", "future", "invalid", "priorDay", "missing"], now);
  assert.deepEqual(result.map((x) => x.reason),
    [null, null, "stale-bars", "future-bar", "invalid-timestamp", "stale-bars", "missing-bars"]);
  assert.equal(result[0].latestBarAt, "2026-10-15T14:55:00.000Z");
});

function brokerMock({ stale = false, position = null, failData = false, existingStop = false } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, method: init.method || "GET" });
    assert.equal(init.method || "GET", "GET", "unexpected mutation in mock-only diagnostic");
    if (u.hostname === "data.alpaca.markets") {
      if (failData) return response({}, 503);
      if (u.pathname.endsWith("/snapshots")) return response({});
      const bars = Array.from({ length: 20 }, (_, i) =>
        bar(new Date(now.getTime() - (20 - i) * 300_000 - (stale ? 86_400_000 : 0)).toISOString(), 100));
      return response({ bars: { TQQQ: bars, SPY: bars, QQQ: bars } });
    }
    assert.equal(u.hostname, "paper-api.alpaca.markets");
    if (u.pathname === "/v2/clock") return response({ is_open: true });
    if (u.pathname === "/v2/account") return response({ equity: "100", last_equity: "100", cash: "100", buying_power: "100" });
    if (u.pathname === "/v2/positions") return response(position ? [position] : []);
    if (u.pathname === "/v2/orders") return response(existingStop && u.searchParams.get("status") === "open"
      ? [{ id: "stop", symbol: "TQQQ", side: "sell", type: "stop", stop_price: "98.00" }] : []);
    assert.fail("unexpected request " + u.pathname);
  };
  return { fn, calls };
}

test("stale bars block new entries and expose per-symbol timestamps", async () => {
  const mock = brokerMock({ stale: true });
  await mockFetch(mock.fn, async () => {
    const result = await runBot(env, now);
    assert.equal(result.action, "data-not-fresh");
    assert.equal(result.paperOnly, true);
    assert.equal(result.data.symbols.length, 3);
    assert.ok(result.data.symbols.every((x) => !x.fresh && x.latestBarAt));
    assert.ok(!JSON.stringify(result).includes("mock-secret"));
  });
});

test("fresh data preserves ordinary no-signal decisions", async () => {
  const mock = brokerMock();
  await mockFetch(mock.fn, async () => {
    const result = await runBot(env, now);
    assert.equal(result.action, "no-signal");
    assert.ok(result.data.symbols.every((x) => x.fresh));
  });
});

test("market data failures produce explicit blocked entry diagnostics", async () => {
  const mock = brokerMock({ failData: true });
  await mockFetch(mock.fn, async () => {
    const result = await runBot(env, now);
    assert.equal(result.action, "data-not-fresh");
    assert.equal(result.dataError, "market-data-unavailable");
  });
});

test("stale data does not suppress account/time/position loss exits", async () => {
  for (const [at, loss, reason] of [
    [now, "-0.03", "position-stop"],
    [new Date("2026-10-15T19:55:00Z"), "0", "scheduled-close"],
  ]) {
    const mock = brokerMock({ stale: true, position: { symbol: "TQQQ", avg_entry_price: "100", qty: "1", unrealized_plpc: loss } });
    await mockFetch(mock.fn, async () => {
      const result = await runBot(env, at);
      assert.equal(result.action, "dry-run-position");
      assert.equal(result.reason, reason);
    });
  }
});

test("stale data retains an existing protective stop with paper enabled", async () => {
  const mock = brokerMock({ stale: true, existingStop: true,
    position: { symbol: "TQQQ", avg_entry_price: "100", qty: "1", unrealized_plpc: "0.001" } });
  await mockFetch(mock.fn, async () => {
    const result = await runBot({ ...env, TRADING_ENABLED: "true" }, now);
    assert.equal(result.action, "stop-already-active");
    assert.equal(result.orderId, "stop");
  });
});

test("skipped sessions emit startup and explicit zero-check reason without running", async () => {
  const logs = [];
  await runSession({}, { now: () => new Date("2026-10-15T23:00:00Z"),
    run: async () => assert.fail("must not run"), log: (x) => logs.push(x) });
  assert.deepEqual(logs.map((x) => x.event), ["session-started", "session-skipped"]);
  assert.equal(logs[1].checks, 0);
});

test("heartbeat and failure report activity without retrying uncertain checks", async () => {
  let time = now.getTime(), calls = 0;
  const logs = [];
  await assert.rejects(runSession({}, { now: () => new Date(time),
    wait: async (ms) => { time += ms; }, log: (x) => logs.push(x),
    run: async () => { if (++calls === 2) throw new Error("uncertain"); return { action: "no-signal" }; },
  }), /uncertain/);
  assert.equal(calls, 2);
  assert.equal(logs.find((x) => x.event === "session-heartbeat").nextCheckAt, "2026-10-15T15:05:00.000Z");
  assert.equal(logs.at(-1).reason, "check-failed");
});

test("Cloudflare scheduled errors reject waitUntil instead of being swallowed", async () => {
  const originalLog = console.log, originalError = console.error;
  const logs = [];
  console.log = (x) => logs.push(JSON.parse(x));
  console.error = (x) => logs.push(JSON.parse(x));
  try {
    let task;
    await worker.scheduled({ scheduledTime: Date.now() - 60_000 }, {}, { waitUntil: (x) => { task = x; } });
    await assert.rejects(task, /paper-bot-check-failed/);
    assert.equal(logs[0].event, "check-started");
    assert.ok(logs[0].schedulerLagSeconds >= 60);
    assert.equal(logs.at(-1).event, "check-failed");
  } finally { console.log = originalLog; console.error = originalError; }
});

test("invalid timestamps still allow account-based position safeguards", async () => {
  const mock = brokerMock({ position: { symbol: "TQQQ", avg_entry_price: "100", qty: "1", unrealized_plpc: "-0.03" } });
  const fn = async (url, init) => new URL(url).pathname.endsWith("/bars")
    ? response({ bars: { TQQQ: [bar("invalid")], SPY: [bar("invalid")], QQQ: [bar("invalid")] } })
    : mock.fn(url, init);
  await mockFetch(fn, async () => {
    const result = await runBot(env, now);
    assert.equal(result.reason, "position-stop");
    assert.equal(result.data.symbols[0].reason, "invalid-timestamp");
  });
});


function perSymbolMock({ unhealthy = 'NVDD', sparse = false, position = null, existingStop = false } = {}) {
  const base = brokerMock({ position, existingStop });
  return async (url, init) => {
    if (!new URL(url).pathname.endsWith('/bars')) return base.fn(url, init);
    const bars = Object.fromEntries(['TQQQ', 'NVDD', 'SPY', 'QQQ'].map(symbol => [symbol,
      Array.from({ length: symbol === unhealthy && sparse ? 5 : 20 }, (_, i) =>
        bar(new Date(now.getTime() - (20 - i) * 300_000 -
          (symbol === unhealthy && !sparse ? 86_400_000 : 0)).toISOString(), 100))]));
    return response({ bars });
  };
}

test('unhealthy individual candidates are excluded, with eligibility restored only on fresh sufficient history', async () => {
  for (const sparse of [false, true]) {
    await mockFetch(perSymbolMock({ sparse }), async () => {
      const result = await runBot({ ...env, UNIVERSE: 'TQQQ,NVDD' }, now);
      assert.equal(result.action, 'no-signal');
      assert.deepEqual(result.data.eligibility.eligibleSymbols, ['TQQQ']);
      assert.deepEqual(result.data.eligibility.excludedSymbols, ['NVDD']);
      assert.deepEqual(result.rankings.find(x => x.symbol === 'NVDD').reasons, ['insufficient-data']);
      assert.notDeepEqual(result.rankings.find(x => x.symbol === 'TQQQ').reasons, ['insufficient-data']);
    });
  }
  await mockFetch(perSymbolMock({ unhealthy: null }), async () => {
    const result = await runBot({ ...env, UNIVERSE: 'TQQQ,NVDD' }, now);
    assert.deepEqual(result.data.eligibility.eligibleSymbols, ['TQQQ', 'NVDD']);
    assert.notDeepEqual(result.rankings.find(x => x.symbol === 'NVDD').reasons, ['insufficient-data']);
  });
});

test('either stale or insufficient benchmark blocks all entries', async () => {
  for (const unhealthy of ['SPY', 'QQQ']) for (const sparse of [false, true]) {
    await mockFetch(perSymbolMock({ unhealthy, sparse }), async () => {
      const result = await runBot(env, now);
      assert.equal(result.action, 'data-not-fresh');
      assert.equal(result.data.eligibility.benchmarksHealthy, false);
    });
  }
});

test('unhealthy held data never enables rotation and preserves stops and account-loss exits', async () => {
  const position = { symbol: 'TQQQ', avg_entry_price: '100', qty: '1', unrealized_plpc: '0.001' };
  for (const unhealthy of ['TQQQ', 'SPY']) {
    await mockFetch(perSymbolMock({ unhealthy, position, existingStop: true }), async () => {
      const result = await runBot({ ...env, UNIVERSE: 'TQQQ,NVDD', TRADING_ENABLED: 'true' }, now);
      assert.equal(result.action, 'stop-already-active');
      assert.equal(result.positionManagement.rotationCandidate, null);
    });
  }
  await mockFetch(perSymbolMock({ unhealthy: 'TQQQ', position: { ...position, unrealized_plpc: '-0.03' } }), async () => {
    const result = await runBot(env, now);
    assert.equal(result.reason, 'position-stop');
  });
  await mockFetch(perSymbolMock({ unhealthy: 'NVDD', position }), async () => {
    const result = await runBot({ ...env, UNIVERSE: 'TQQQ,NVDD' }, now);
    assert.equal(result.positionManagement.rotationCandidate, null);
    assert.deepEqual(result.rankings.find(x => x.symbol === 'NVDD').reasons, ['insufficient-data']);
  });
});

test('stale strong candidates cannot enter or rotate, and restored healthy candidates can', async () => {
  for (const stale of [true, false]) for (const held of [false, true]) {
    const position = held ? { symbol: 'TQQQ', avg_entry_price: '100', qty: '1', unrealized_plpc: '0.006' } : null;
    const base = perSymbolMock({ unhealthy: null, position });
    const fn = async (url, init) => {
      const path = new URL(url).pathname;
      if (path.startsWith('/v2/assets/')) return response({ tradable: true, fractionable: true, status: 'active' });
      if (!path.endsWith('/bars')) return base(url, init);
      const bars = Object.fromEntries(['TQQQ', 'NVDD', 'SPY', 'QQQ'].map(symbol => [symbol,
        Array.from({ length: 20 }, (_, i) => {
          const close = symbol === 'NVDD' ? 100 + i * 0.3 : 100;
          return { t: new Date(now.getTime() - (20 - i) * 300_000 -
            (symbol === 'NVDD' && stale ? 86_400_000 : 0)).toISOString(),
            c: close, o: close - 0.075, h: close + 0.9, l: close - 0.9, v: 1000 + i * 10 };
        })]));
      return response({ bars });
    };
    await mockFetch(fn, async () => {
      const result = await runBot({ ...env, UNIVERSE: 'TQQQ,NVDD' }, now);
      if (held) {
        assert.equal(result.positionManagement.rotationCandidate?.symbol || null, stale ? null : 'NVDD');
      } else {
        assert.equal(result.action, stale ? 'no-signal' : 'dry-run-entry');
        if (!stale) assert.equal(result.symbol, 'NVDD');
      }
    });
  }
});
