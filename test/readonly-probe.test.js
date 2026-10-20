import test from "node:test";
import assert from "node:assert/strict";
import { getOnlyTransport, validatePaperReadOnly, safeFailureReason } from "../tools/validate-paper-readonly.mjs";

const now = new Date("2026-10-16T19:05:00Z");
const env = { ALPACA_API_KEY_ID: "fixture-key", ALPACA_API_SECRET_KEY: "fixture-secret",
  TRADING_ENABLED: "true", UNIVERSE: "TQQQ" };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("probe transport refuses every order path, mutation, redirect host and non-HTTPS host", async () => {
  const guard = getOnlyTransport(async () => assert.fail("must never reach the network"));
  for (const [url, init] of [
    ["https://paper-api.alpaca.markets/v2/orders", {}],
    ["https://paper-api.alpaca.markets/v2/account", { method: "POST", body: "{}" }],
    ["https://api.alpaca.markets/v2/account", {}],
    ["http://paper-api.alpaca.markets/v2/account", {}],
    ["https://example.org/v2/clock", {}],
    ["https://fixture:secret@paper-api.alpaca.markets/v2/account", {}],
  ]) await assert.rejects(guard(url, init), /transport-refused/);
});

test("probe checks actual GET surfaces without running the bot or exposing account identity/secrets", async () => {
  const calls = [];
  const original = globalThis.fetch;
  const result = await validatePaperReadOnly(env, { now, fetchImpl: async (url, init) => {
    const u = new URL(url); calls.push({ url: u, init });
    assert.equal(init.method, "GET"); assert.equal(init.redirect, "error");
    if (u.pathname === "/v2/account") return response({ equity: "94.16", currency: "USD",
      id: "private-account-id", account_number: "private-number" });
    if (u.pathname === "/v2/clock") return response({ is_open: true, timestamp: now.toISOString() });
    assert.equal(u.pathname, "/v2/stocks/bars");
    return response({ bars: Object.fromEntries(["TQQQ", "SPY", "QQQ"].map((symbol) =>
      [symbol, [{ t: "2026-10-16T19:00:00Z", c: 100, v: 1000 }]])) });
  } });
  assert.equal(result.result, "connected");
  assert.equal(result.effectiveTradingEnabled, false);
  assert.equal(result.submittedOrderRequests, 0);
  assert.equal(result.requests.paper, 2);
  assert.equal(result.requests.data, 1);
  assert.equal(result.marketData.symbols.length, 3);
  assert.equal(result.ordersAuthorizedByValidation, false);
  for (const value of ["private-account-id", "private-number", "fixture-secret", "fixture-key"]) {
    assert.ok(!JSON.stringify(result).includes(value));
  }
  assert.equal(globalThis.fetch, original);
});

test("probe refuses missing credentials before any request", async () => {
  await assert.rejects(validatePaperReadOnly({}, { fetchImpl: async () => assert.fail("no calls") }),
    /credentials-unconfigured/);
});

test("probe reports paper authentication failures without raw server bodies", async () => {
  await assert.rejects(validatePaperReadOnly(env, { now,
    fetchImpl: async () => response({ message: "fixture-secret" }, 401) }), /paper-request-401/);
  assert.equal(safeFailureReason(new Error("server echoed fixture-secret")), "read-only-validation-failed");
});

test("probe fails explicit missing market data and restores the default transport", async () => {
  const original = globalThis.fetch;
  await assert.rejects(validatePaperReadOnly(env, { now, fetchImpl: async (url) => {
    if (new URL(url).pathname === "/v2/account") return response({ equity: "94.16" });
    if (new URL(url).pathname === "/v2/clock") return response({ is_open: false });
    return response({ bars: {} });
  } }), /market-data-incomplete/);
  assert.equal(globalThis.fetch, original);
});

test("closed-session data is reported with its age, never presented as permission to trade", async () => {
  const result = await validatePaperReadOnly(env, { now, fetchImpl: async (url) => {
    if (new URL(url).pathname === "/v2/account") return response({ equity: "94.16" });
    if (new URL(url).pathname === "/v2/clock") return response({ is_open: false });
    return response({ bars: Object.fromEntries(["TQQQ", "SPY", "QQQ"].map((s) =>
      [s, [{ t: "2026-10-16T18:00:00Z", c: 100, v: 1000 }]])) });
  } });
  assert.equal(result.clock.isOpen, false);
  assert.ok(result.marketData.symbols.every((x) => !x.fresh));
  assert.equal(result.ordersAuthorizedByValidation, false);
});

test("public validation output contains account status only, never balances or account identifiers", async () => {
  const account = { equity: "94.16", cash: "81234.56", buying_power: "162469.12",
    last_equity: "93456.78", portfolio_value: "84567.89", account_number: "private-account-number",
    id: "private-account-identifier", email: "private-fixture@example.invalid", currency: "USD",
    account_blocked: false, trading_blocked: false };
  const result = await validatePaperReadOnly(env, { now, fetchImpl: async (url) => {
    const path = new URL(url).pathname;
    if (path === "/v2/account") return response(account);
    if (path === "/v2/clock") return response({ is_open: false, timestamp: now.toISOString() });
    return response({ bars: Object.fromEntries(["TQQQ", "SPY", "QQQ"].map((s) =>
      [s, [{ t: "2026-10-16T19:00:00Z", c: 100, v: 1000 }]])) });
  } });
  assert.deepEqual(result.account, { connected: true, accountBlocked: false, tradingBlocked: false });
  const emitted = JSON.stringify(result);
  for (const key of ["equity", "cash", "buying_power", "last_equity", "portfolio_value",
    "account_number", "id", "email", "currency"]) {
    assert.ok(!emitted.includes(JSON.stringify(key) + ":"), "Forbidden public output field: " + key);
    assert.ok(!emitted.includes(String(account[key])), "Forbidden public output value for: " + key);
  }
  assert.equal(result.submittedOrderRequests, 0);
  assert.equal(result.effectiveTradingEnabled, false);
});
