import { pathToFileURL } from "node:url";
import { fetchBars, barFreshness, dataEligibility, getConfig, PAPER_TRADING_BASE_URL } from "../src/index.js";

export function getOnlyTransport(fetchImpl, counts = { paper: 0, data: 0 }) {
  return async (input, init = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = (init.method || input?.method || "GET").toUpperCase();
    const paper = url.hostname === "paper-api.alpaca.markets" &&
      ["/v2/account", "/v2/clock"].includes(url.pathname);
    const data = url.hostname === "data.alpaca.markets" && url.pathname === "/v2/stocks/bars";
    if (method !== "GET" || init.body || input?.body ||
        url.protocol !== "https:" || url.username || url.password || url.port || (!paper && !data)) {
      throw new Error("read-only-transport-refused");
    }
    counts[paper ? "paper" : "data"] += 1;
    return fetchImpl(input, { ...init, method: "GET", redirect: "error", signal: AbortSignal.timeout(20_000) });
  };
}

export async function validatePaperReadOnly(env, { now = new Date(), fetchImpl = globalThis.fetch } = {}) {
  if (!env.ALPACA_API_KEY_ID || !env.ALPACA_API_SECRET_KEY) throw new Error("credentials-unconfigured");
  const counts = { paper: 0, data: 0 };
  const original = globalThis.fetch;
  const transport = getOnlyTransport(fetchImpl, counts);
  globalThis.fetch = transport;
  try {
    const safeEnv = { ...env, TRADING_ENABLED: "false" };
    const headers = { "APCA-API-KEY-ID": env.ALPACA_API_KEY_ID,
      "APCA-API-SECRET-KEY": env.ALPACA_API_SECRET_KEY };
    const get = async (path) => {
      const response = await transport(PAPER_TRADING_BASE_URL + path, { headers });
      if (!response.ok) throw new Error("paper-request-" + response.status);
      return response.json();
    };
    const [account, clock] = await Promise.all([get("/v2/account"), get("/v2/clock")]);
    if (!Number.isFinite(Number(account?.equity))) throw new Error("invalid-account-payload");
    if (typeof clock?.is_open !== "boolean") throw new Error("invalid-clock-payload");
    const symbols = [...new Set([...getConfig(safeEnv).universe, "SPY", "QQQ"])];
    const stats = {};
    const bars = await fetchBars(safeEnv, symbols, now, stats);
    const summary = barFreshness(bars, symbols, now);
    if (summary.filter(item => ["SPY", "QQQ"].includes(item.symbol)).some((item) => !item.count || !item.latestBarAt ||
        ["invalid-timestamp", "future-bar"].includes(item.reason))) {
      throw new Error("market-data-incomplete");
    }
    return {
      event: "read-only-validation", timestamp: now.toISOString(), result: "connected",
      paperOnly: true, effectiveTradingEnabled: false, submittedOrderRequests: 0,
      requests: counts,
      account: { connected: true,
        accountBlocked: Boolean(account.account_blocked), tradingBlocked: Boolean(account.trading_blocked) },
      clock: { isOpen: clock.is_open, timestamp: clock.timestamp || null },
      marketData: { feed: "iex", timeframe: "5Min", pages: stats.pages, symbols: summary,
        eligibility: dataEligibility(summary, getConfig(safeEnv).universe, now) },
      readyForPaperOrders: false,
    };
  } finally {
    globalThis.fetch = original;
  }
}

export function safeFailureReason(error) {
  return /^(credentials-unconfigured|read-only-transport-refused|invalid-account-payload|invalid-clock-payload|market-data-incomplete|bar-pagination-limit|bar-pagination-cycle|invalid-bars-response|paper-request-\d{3})$/.test(error.message)
    ? error.message : "read-only-validation-failed";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await validatePaperReadOnly(process.env)));
  } catch (error) {
    console.error(JSON.stringify({ event: "read-only-validation-failed",
      paperOnly: true, submittedOrderRequests: 0, reason: safeFailureReason(error) }));
    process.exitCode = 1;
  }
}
