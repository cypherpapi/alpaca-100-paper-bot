import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKET_DATA_BASE_URL,
  PAPER_TRADING_BASE_URL,
  accountDailyReturn,
  easternParts,
  getConfig,
  healthPayload,
  momentumMetrics,
  positionExitReason,
  roundOrderPrice,
  selectMomentumCandidate,
} from "../src/index.js";

function risingBars({ start = 100, step = 0.15, volume = 1000 } = {}) {
  return Array.from({ length: 20 }, (_, index) => ({
    c: start + index * step,
    t: new Date(Date.UTC(2026, 8, 3, 14, index * 5)).toISOString(),
    v: volume + index * 10,
  }));
}

const baseEnv = {
  ALLOCATION_PCT: "0.90",
  DAILY_LOSS_LIMIT_PCT: "0.04",
  ENTRY_END_ET: "14:30",
  ENTRY_START_ET: "09:45",
  FORCE_EXIT_ET: "15:50",
  STOP_LOSS_PCT: "0.02",
  TAKE_PROFIT_PCT: "0.03",
  TRADING_ENABLED: "false",
  UNIVERSE: "TQQQ,SQQQ",
};

test("all trading traffic is pinned to Alpaca paper trading", () => {
  assert.equal(PAPER_TRADING_BASE_URL, "https://paper-api.alpaca.markets");
  assert.equal(MARKET_DATA_BASE_URL, "https://data.alpaca.markets");
  assert.equal(healthPayload(baseEnv).paperOnly, true);
  assert.equal(healthPayload(baseEnv).mode, "paper-dry-run");
});

test("configuration rejects unsafe percentage values", () => {
  assert.throws(() => getConfig({ ...baseEnv, STOP_LOSS_PCT: "2" }), /greater than 0/);
  assert.throws(() => getConfig({ ...baseEnv, ALLOCATION_PCT: "0" }), /greater than 0/);
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
  assert.ok(selected.metrics.return15m > 0.0025);
  assert.ok(selected.metrics.return60m > 0.004);
});

test("momentum selector skips falling markets", () => {
  const falling = risingBars({ start: 105, step: -0.2 });
  assert.equal(selectMomentumCandidate({ TQQQ: falling }, ["TQQQ"]), null);
  assert.ok(momentumMetrics(falling).price < momentumMetrics(falling).sma9);
});

test("risk controls force exits for loss, profit, reversal, and closing time", () => {
  const config = getConfig(baseEnv);
  const account = { equity: "100", last_equity: "100" };
  const position = { unrealized_plpc: "-0.021" };
  const midday = new Date("2026-09-03T17:00:00Z");
  assert.equal(positionExitReason({ account, config, metrics: null, now: midday, position }), "position-stop");

  assert.equal(
    positionExitReason({
      account,
      config,
      metrics: null,
      now: midday,
      position: { unrealized_plpc: "0.031" },
    }),
    "take-profit",
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
  assert.ok(accountDailyReturn({ equity: "95", last_equity: "100" }) < -0.04);
  assert.equal(
    positionExitReason({
      account: { equity: "95", last_equity: "100" },
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
