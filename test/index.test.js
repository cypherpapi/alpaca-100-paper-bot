import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKET_DATA_BASE_URL,
  PAPER_TRADING_BASE_URL,
  accountDailyReturn,
  canRiskAnotherEntry,
  cooldownRemainingMinutes,
  countDailyEntries,
  detectMarketRegime,
  easternParts,
  evaluateTrendCandidate,
  getConfig,
  healthPayload,
  latestBotExitTime,
  latestPositionEntryOrder,
  momentumMetrics,
  paperAccountSummary,
  peakReturnSinceEntry,
  positionExitReason,
  protectiveStopRequest,
  rankTrendCandidates,
  roundOrderPrice,
  selectMomentumCandidate,
} from "../src/index.js";

function risingBars({ start = 100, step = 0.15, volume = 1000 } = {}) {
  return Array.from({ length: 20 }, (_, index) => {
    const close = start + index * step;
    const spread = Math.max(Math.abs(step) * 3, 0.1);
    return {
      c: close,
      h: close + spread,
      l: close - spread,
      o: close - step * 0.25,
      t: new Date(Date.UTC(2026, 8, 3, 14, index * 5)).toISOString(),
      v: volume + index * 10,
      vw: close,
    };
  });
}

const baseEnv = {
  ALLOCATION_PCT: "0.99",
  DAILY_LOSS_LIMIT_PCT: "0.10",
  ENTRY_END_ET: "14:30",
  ENTRY_START_ET: "09:45",
  FORCE_EXIT_ET: "15:50",
  MAX_CHASE_DAY_RETURN_PCT: "0.06",
  MAX_ENTRIES_PER_DAY: "8",
  MAX_HIGH_DISTANCE_PCT: "0.01",
  MAX_VWAP_EXTENSION_ATR: "1.75",
  MIN_HOLD_MINUTES: "20",
  MIN_RETURN_15M: "0.0015",
  MIN_RETURN_60M: "0.003",
  MIN_TREND_SCORE: "55",
  MIN_VOLUME_RATIO: "0.65",
  PROFIT_LOCK_FLOOR_PCT: "0.01",
  PROFIT_LOCK_TRIGGER_PCT: "0.03",
  PROFIT_TRAIL_DRAWDOWN_PCT: "0.02",
  PROFIT_TRAIL_TRIGGER_PCT: "0.06",
  REENTRY_COOLDOWN_MINUTES: "5",
  ROTATION_SCORE_GAP: "20",
  REVERSAL_RETURN_15M: "0.0025",
  STOP_LOSS_PCT: "0.04",
  TAKE_PROFIT_PCT: "0.12",
  TRADING_ENABLED: "false",
  UNIVERSE: "TQQQ,SQQQ",
};

test("all trading traffic is pinned to Alpaca paper trading", () => {
  assert.equal(PAPER_TRADING_BASE_URL, "https://paper-api.alpaca.markets");
  assert.equal(MARKET_DATA_BASE_URL, "https://data.alpaca.markets");
  assert.equal(healthPayload(baseEnv).paperOnly, true);
  assert.equal(healthPayload(baseEnv).mode, "paper-dry-run");
  assert.equal(healthPayload(baseEnv).allocationPct, 0.99);
  assert.equal(healthPayload(baseEnv).maxEntriesPerDay, 8);
  assert.equal(healthPayload(baseEnv).strategyVersion, "trend-hunter-v2");
});

test("configuration rejects unsafe percentage values", () => {
  assert.throws(() => getConfig({ ...baseEnv, STOP_LOSS_PCT: "2" }), /greater than 0/);
  assert.throws(() => getConfig({ ...baseEnv, ALLOCATION_PCT: "0" }), /greater than 0/);
  assert.throws(
    () => getConfig({ ...baseEnv, MAX_ENTRIES_PER_DAY: "4.5" }),
    /integer from 1 through 10/,
  );
  assert.throws(
    () => getConfig({ ...baseEnv, REENTRY_COOLDOWN_MINUTES: "121" }),
    /integer from 0 through 120/,
  );
  assert.throws(
    () => getConfig({ ...baseEnv, MIN_VOLUME_RATIO: "0.05" }),
    /from 0.1 through 5/,
  );
});

test("Eastern time conversion handles daylight saving time", () => {
  const summer = easternParts(new Date("2026-09-03T13:45:00Z"));
  const winter = easternParts(new Date("2026-12-03T14:45:00Z"));
  assert.deepEqual(summer, { dateTag: "20260903", minutes: 9 * 60 + 45 });
  assert.deepEqual(winter, { dateTag: "20261203", minutes: 9 * 60 + 45 });
});

test("momentum selector chooses the stronger qualified symbol", () => {
  const weak = risingBars({ step: 0.08 });
  const strong = risingBars({ step: 0.3 });
  const selected = selectMomentumCandidate({ SQQQ: weak, TQQQ: strong }, ["TQQQ", "SQQQ"]);
  assert.equal(selected.symbol, "TQQQ");
  assert.ok(selected.metrics.return15m > 0.0015);
  assert.ok(selected.metrics.return60m > 0.003);
});

test("momentum selector skips falling markets", () => {
  const falling = risingBars({ start: 105, step: -0.2 });
  assert.equal(selectMomentumCandidate({ TQQQ: falling }, ["TQQQ"]), null);
  assert.ok(momentumMetrics(falling).price < momentumMetrics(falling).sma9);
});

test("trend scoring rejects a late chase near the daily high", () => {
  const metrics = {
    atr14: 1,
    atrPct: 0.01,
    breakout: true,
    dayReturn: 0.085,
    distanceFromHighPct: -0.003,
    ema13: 99,
    ema5: 100,
    emaSpreadPct: 0.01,
    price: 101,
    pullbackRecovery: false,
    return15m: 0.01,
    return60m: 0.03,
    rsi14: 70,
    sessionReturn: 0.08,
    sma9: 100,
    volumeRatio: 1.5,
    vwap: 100,
    vwapExtensionAtr: 1,
  };
  const evaluation = evaluateTrendCandidate("TQQQ", metrics, getConfig(baseEnv), "bullish");
  assert.equal(evaluation.qualified, false);
  assert.ok(evaluation.reasons.includes("extended-near-day-high"));
});

test("rankings expose scores and market regime rewards aligned symbols", () => {
  const rising = risingBars({ step: 0.3 });
  const falling = risingBars({ start: 105, step: -0.3 });
  assert.equal(detectMarketRegime({ QQQ: rising, SPY: rising }), "bullish");
  assert.equal(detectMarketRegime({ QQQ: falling, SPY: falling }), "bearish");

  const rankings = rankTrendCandidates(
    { SQQQ: rising, TQQQ: rising },
    ["TQQQ", "SQQQ"],
    getConfig(baseEnv),
    {},
    "bullish",
  );
  assert.equal(rankings[0].symbol, "TQQQ");
  assert.ok(rankings[0].score > rankings[1].score);
  assert.equal(typeof rankings[0].score, "number");
});

test("risk controls force exits for loss, profit, reversal, and closing time", () => {
  const config = getConfig(baseEnv);
  const account = { equity: "100", last_equity: "100" };
  const position = { unrealized_plpc: "-0.041" };
  const midday = new Date("2026-09-03T17:00:00Z");
  assert.equal(positionExitReason({ account, config, metrics: null, now: midday, position }), "position-stop");

  assert.equal(
    positionExitReason({
      account,
      config,
      metrics: null,
      now: midday,
      position: { unrealized_plpc: "0.121" },
    }),
    "take-profit",
  );

  assert.equal(
    positionExitReason({
      account,
      config,
      metrics: { price: 99, return15m: 0.001, sma9: 100 },
      now: midday,
      position: { unrealized_plpc: "0" },
    }),
    null,
  );

  assert.equal(
    positionExitReason({
      account,
      config,
      metrics: { price: 101, return15m: -0.002, sma9: 100 },
      now: midday,
      position: { unrealized_plpc: "0" },
    }),
    null,
  );

  assert.equal(
    positionExitReason({
      account,
      config,
      metrics: { price: 99, return15m: -0.003, sma9: 100 },
      now: midday,
      position: { unrealized_plpc: "0" },
    }),
    "momentum-reversal",
  );

  const closeTime = new Date("2026-09-03T19:50:00Z");
  assert.equal(
    positionExitReason({
      account,
      config,
      metrics: null,
      now: closeTime,
      position: { unrealized_plpc: "0" },
    }),
    "scheduled-close",
  );
});

test("daily loss limit takes priority and order prices use valid precision", () => {
  const config = getConfig(baseEnv);
  assert.ok(accountDailyReturn({ equity: "89", last_equity: "100" }) < -0.1);
  assert.equal(
    positionExitReason({
      account: { equity: "89", last_equity: "100" },
      config,
      metrics: null,
      now: new Date("2026-09-03T17:00:00Z"),
      position: { unrealized_plpc: "0" },
    }),
    "daily-loss-limit",
  );
  assert.equal(roundOrderPrice(12.3456), "12.35");
  assert.equal(roundOrderPrice(0.123456), "0.1235");
});

test("profit protection, stalled exits, and stronger-trend rotation release capital", () => {
  const config = getConfig(baseEnv);
  const account = { equity: "100", last_equity: "100" };
  const midday = new Date("2026-09-03T17:00:00Z");
  const positiveMetrics = { price: 101, return15m: 0.004, sma9: 100 };

  assert.equal(
    positionExitReason({
      account,
      config,
      metrics: positiveMetrics,
      now: midday,
      peakReturn: 0.07,
      position: { unrealized_plpc: "0.045" },
    }),
    "profit-trailing-exit",
  );
  assert.equal(
    positionExitReason({
      account,
      config,
      metrics: positiveMetrics,
      now: midday,
      peakReturn: 0.035,
      position: { unrealized_plpc: "0.008" },
    }),
    "profit-lock-exit",
  );
  assert.equal(
    positionExitReason({
      account,
      config,
      currentEvaluation: { qualified: false },
      metrics: { price: 100, return15m: -0.001, sma9: 100 },
      minutesHeld: 30,
      now: midday,
      position: { unrealized_plpc: "-0.002" },
    }),
    "stalled-trend-exit",
  );
  assert.equal(
    positionExitReason({
      account,
      config,
      currentEvaluation: { qualified: true },
      metrics: positiveMetrics,
      minutesHeld: 30,
      now: midday,
      position: { unrealized_plpc: "0.002" },
      rotationCandidate: { scoreGap: 25, symbol: "SOXL" },
    }),
    "stronger-trend-rotation",
  );
});

test("position history and observed bar highs support profit tracking", () => {
  const orders = [
    {
      client_order_id: "cdbot-entry-20260903-1",
      filled_at: "2026-09-03T15:00:00Z",
      side: "buy",
      status: "filled",
      symbol: "TQQQ",
    },
    {
      client_order_id: "cdbot-entry-20260904-1",
      filled_at: "2026-09-04T15:00:00Z",
      side: "buy",
      status: "filled",
      symbol: "TQQQ",
    },
  ];
  assert.equal(latestPositionEntryOrder(orders, "TQQQ").filled_at, "2026-09-04T15:00:00Z");
  assert.ok(
    Math.abs(
      peakReturnSinceEntry(
        [
          { c: 99, h: 100, t: "2026-09-04T14:55:00Z" },
          { c: 102, h: 107, t: "2026-09-04T15:05:00Z" },
        ],
        100,
        "2026-09-04T15:00:00Z",
      ) - 0.07,
    ) < Number.EPSILON,
  );
});

test("multiple daily entries use order history and enforce a reentry cooldown", () => {
  const dateTag = "20260904";
  const orders = [
    {
      client_order_id: "cdbot-entry-20260904",
      side: "buy",
      status: "filled",
      symbol: "SOXL",
    },
    {
      client_order_id: "cdbot-entry-20260904-2",
      side: "buy",
      status: "filled",
      symbol: "TQQQ",
    },
    {
      client_order_id: "cdbot-exit-20260904-2",
      filled_at: "2026-09-04T15:00:00Z",
      side: "sell",
      status: "filled",
      symbol: "TQQQ",
    },
    {
      client_order_id: "cdbot-entry-20260903",
      side: "buy",
      status: "filled",
      symbol: "TQQQ",
    },
  ];

  assert.equal(countDailyEntries(orders, dateTag), 2);
  assert.equal(latestBotExitTime(orders, dateTag).toISOString(), "2026-09-04T15:00:00.000Z");
  assert.equal(
    cooldownRemainingMinutes(
      new Date("2026-09-04T15:10:00Z"),
      latestBotExitTime(orders, dateTag),
      15,
    ),
    5,
  );
  assert.equal(
    cooldownRemainingMinutes(
      new Date("2026-09-04T15:16:00Z"),
      latestBotExitTime(orders, dateTag),
      15,
    ),
    0,
  );
});

test("new entries stop when the next planned stop could breach the daily loss cap", () => {
  const config = getConfig(baseEnv);
  assert.equal(canRiskAnotherEntry({ equity: "100", last_equity: "100" }, config), true);
  assert.equal(canRiskAnotherEntry({ equity: "94.10", last_equity: "100" }, config), true);
  assert.equal(canRiskAnotherEntry({ equity: "93.90", last_equity: "100" }, config), false);
});

test("fractional positions receive a four percent broker-side stop", () => {
  const request = protectiveStopRequest(
    getConfig(baseEnv),
    { avg_entry_price: "100", qty: "0.97", symbol: "TQQQ" },
    "20260904",
    2,
  );
  assert.deepEqual(request, {
    client_order_id: "cdbot-stop-20260904-2",
    qty: "0.97",
    side: "sell",
    stop_price: "96.00",
    symbol: "TQQQ",
    time_in_force: "day",
    type: "stop",
  });
});

test("paper account summaries make daily results visible without exposing credentials", () => {
  assert.deepEqual(
    paperAccountSummary({ cash: "100.22", equity: "100.22", last_equity: "100" }),
    {
      cash: 100.22,
      dailyPl: 0.22,
      dailyReturnPct: 0.22,
      equity: 100.22,
      lastEquity: 100,
    },
  );
});
