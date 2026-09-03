const PAPER_TRADING_BASE_URL = "https://paper-api.alpaca.markets";
const MARKET_DATA_BASE_URL = "https://data.alpaca.markets";
const NEW_YORK_TIME_ZONE = "America/New_York";
const ORDER_PREFIX = "cdbot";

function numberFromEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function percentFromEnv(value, fallback) {
  const parsed = numberFromEnv(value, fallback);
  if (parsed <= 0 || parsed >= 1) {
    throw new Error("Risk percentages must be greater than 0 and less than 1.");
  }
  return parsed;
}

function parseClock(value, fallback) {
  const candidate = value || fallback;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(candidate)) {
    throw new Error(`Invalid Eastern-time clock value: ${candidate}`);
  }
  const [hour, minute] = candidate.split(":").map(Number);
  return hour * 60 + minute;
}

function getConfig(env) {
  const universe = (env.UNIVERSE || "TQQQ,SQQQ,SOXL,SOXS,TNA,TZA")
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);

  if (universe.length === 0) {
    throw new Error("UNIVERSE must contain at least one symbol.");
  }

  const allocationPct = percentFromEnv(env.ALLOCATION_PCT, 0.9);
  const stopLossPct = percentFromEnv(env.STOP_LOSS_PCT, 0.02);
  const takeProfitPct = percentFromEnv(env.TAKE_PROFIT_PCT, 0.03);
  const dailyLossLimitPct = percentFromEnv(env.DAILY_LOSS_LIMIT_PCT, 0.04);

  return {
    allocationPct,
    dailyLossLimitPct,
    entryEndMinutes: parseClock(env.ENTRY_END_ET, "14:30"),
    entryStartMinutes: parseClock(env.ENTRY_START_ET, "09:45"),
    forceExitMinutes: parseClock(env.FORCE_EXIT_ET, "15:50"),
    stopLossPct,
    takeProfitPct,
    tradingEnabled: env.TRADING_ENABLED === "true",
    universe,
  };
}

function requireCredentials(env) {
  if (!env.ALPACA_API_KEY_ID || !env.ALPACA_API_SECRET_KEY) {
    throw new Error("Paper API credentials are not configured.");
  }
}

function authHeaders(env) {
  return {
    "APCA-API-KEY-ID": env.ALPACA_API_KEY_ID,
    "APCA-API-SECRET-KEY": env.ALPACA_API_SECRET_KEY,
  };
}

async function parseResponse(response) {
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text || null;
  }

  if (!response.ok) {
    const safeMessage =
      payload && typeof payload === "object"
        ? payload.message || payload.code || response.statusText
        : response.statusText;
    throw new Error(`Alpaca request failed (${response.status}): ${safeMessage}`);
  }
  return payload;
}

async function tradingRequest(env, path, init = {}) {
  const headers = {
    ...authHeaders(env),
    ...(init.body ? { "content-type": "application/json" } : {}),
    ...(init.headers || {}),
  };
  const response = await fetch(`${PAPER_TRADING_BASE_URL}${path}`, {
    ...init,
    headers,
  });
  return parseResponse(response);
}

async function marketDataRequest(env, path) {
  const response = await fetch(`${MARKET_DATA_BASE_URL}${path}`, {
    headers: authHeaders(env),
  });
  return parseResponse(response);
}

function easternParts(date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone: NEW_YORK_TIME_ZONE,
    year: "numeric",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    dateTag: `${parts.year}${parts.month}${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function average(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function momentumMetrics(bars) {
  if (!Array.isArray(bars) || bars.length < 13) return null;
  const sorted = [...bars].sort((a, b) => new Date(a.t) - new Date(b.t));
  const closes = sorted.map((bar) => Number(bar.c));
  const volumes = sorted.map((bar) => Number(bar.v));
  if ([...closes, ...volumes].some((value) => !Number.isFinite(value))) return null;

  const last = closes.length - 1;
  const price = closes[last];
  const return15m = price / closes[last - 3] - 1;
  const return60m = price / closes[last - 12] - 1;
  const sma9 = average(closes.slice(-9));
  const recentVolume = average(volumes.slice(-3));
  const priorVolume = average(volumes.slice(-12, -3));
  const volumeRatio = priorVolume > 0 ? recentVolume / priorVolume : 0;

  return {
    price,
    return15m,
    return60m,
    score: return15m * 0.6 + return60m * 0.4,
    sma9,
    volumeRatio,
  };
}

function selectMomentumCandidate(barsBySymbol, universe) {
  const candidates = universe
    .map((symbol) => ({ symbol, metrics: momentumMetrics(barsBySymbol[symbol]) }))
    .filter(({ metrics }) => metrics)
    .filter(
      ({ metrics }) =>
        metrics.price > metrics.sma9 &&
        metrics.return15m >= 0.0025 &&
        metrics.return60m >= 0.004 &&
        metrics.volumeRatio >= 0.7,
    )
    .sort((a, b) => b.metrics.score - a.metrics.score);
  return candidates[0] || null;
}

function accountDailyReturn(account) {
  const equity = Number(account.equity);
  const lastEquity = Number(account.last_equity);
  if (!Number.isFinite(equity) || !Number.isFinite(lastEquity) || lastEquity <= 0) {
    return 0;
  }
  return equity / lastEquity - 1;
}

function positionExitReason({ account, config, metrics, now, position }) {
  const { minutes } = easternParts(now);
  const unrealizedReturn = Number(position.unrealized_plpc || 0);
  if (accountDailyReturn(account) <= -config.dailyLossLimitPct) return "daily-loss-limit";
  if (minutes >= config.forceExitMinutes) return "scheduled-close";
  if (unrealizedReturn <= -config.stopLossPct) return "position-stop";
  if (unrealizedReturn >= config.takeProfitPct) return "take-profit";
  if (metrics && (metrics.price < metrics.sma9 || metrics.return15m <= -0.002)) {
    return "momentum-reversal";
  }
  return null;
}

function roundOrderPrice(value) {
  const decimals = value >= 1 ? 2 : 4;
  return Number(value).toFixed(decimals);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchBars(env, symbols, now) {
  const end = new Date(now.getTime() - 60_000);
  const start = new Date(end.getTime() - 4 * 60 * 60_000);
  const params = new URLSearchParams({
    adjustment: "raw",
    end: end.toISOString(),
    feed: "iex",
    limit: "1000",
    sort: "asc",
    start: start.toISOString(),
    symbols: symbols.join(","),
    timeframe: "5Min",
  });
  const payload = await marketDataRequest(env, `/v2/stocks/bars?${params}`);
  return payload?.bars || {};
}

function isOpenOrder(order) {
  return ["accepted", "new", "partially_filled", "pending_new", "pending_replace"].includes(
    order.status,
  );
}

async function waitForCancellation(env, orderId) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await sleep(400);
    const order = await tradingRequest(env, `/v2/orders/${orderId}`);
    if (!isOpenOrder(order)) return;
  }
  throw new Error("Protective order cancellation did not complete in time.");
}

async function cancelSymbolOrders(env, openOrders, symbol) {
  const matching = openOrders.filter((order) => order.symbol === symbol);
  for (const order of matching) {
    await tradingRequest(env, `/v2/orders/${order.id}`, { method: "DELETE" });
    await waitForCancellation(env, order.id);
  }
}

async function ensureProtectiveStop(env, config, position, openOrders, dateTag) {
  const existing = openOrders.find(
    (order) =>
      order.symbol === position.symbol &&
      order.side === "sell" &&
      ["stop", "stop_limit", "trailing_stop"].includes(order.type),
  );
  if (existing) return { action: "stop-already-active", orderId: existing.id };

  const averageEntry = Number(position.avg_entry_price);
  const stopPrice = roundOrderPrice(averageEntry * (1 - config.stopLossPct));
  const order = await tradingRequest(env, "/v2/orders", {
    body: JSON.stringify({
      client_order_id: `${ORDER_PREFIX}-stop-${dateTag}`,
      qty: position.qty,
      side: "sell",
      stop_price: stopPrice,
      symbol: position.symbol,
      time_in_force: "day",
      type: "stop",
    }),
    method: "POST",
  });
  return { action: "protective-stop-submitted", orderId: order.id, stopPrice };
}

async function closePosition(env, position, openOrders, dateTag, reason) {
  const existingExit = openOrders.find(
    (order) => order.client_order_id === `${ORDER_PREFIX}-exit-${dateTag}`,
  );
  if (existingExit) return { action: "exit-already-open", orderId: existingExit.id, reason };

  await cancelSymbolOrders(env, openOrders, position.symbol);
  const order = await tradingRequest(env, "/v2/orders", {
    body: JSON.stringify({
      client_order_id: `${ORDER_PREFIX}-exit-${dateTag}`,
      qty: position.qty,
      side: "sell",
      symbol: position.symbol,
      time_in_force: "day",
      type: "market",
    }),
    method: "POST",
  });
  return { action: "exit-submitted", orderId: order.id, reason, symbol: position.symbol };
}

async function protectFilledEntry(env, config, order, openOrders, dateTag) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = await tradingRequest(env, `/v2/orders/${order.id}`);
    if (current.status === "filled") {
      const position = await tradingRequest(env, `/v2/positions/${order.symbol}`);
      return ensureProtectiveStop(env, config, position, openOrders, dateTag);
    }
    if (["canceled", "expired", "rejected", "suspended"].includes(current.status)) {
      return { action: "entry-not-filled", status: current.status };
    }
    await sleep(750);
  }
  return { action: "entry-pending", orderId: order.id };
}

async function runBot(env, now = new Date()) {
  requireCredentials(env);
  const config = getConfig(env);
  const { dateTag, minutes } = easternParts(now);
  const clock = await tradingRequest(env, "/v2/clock");
  const account = await tradingRequest(env, "/v2/account");

  if (account.account_blocked || account.trading_blocked) {
    return { action: "blocked-account", paperOnly: true };
  }
  if (!clock.is_open) {
    return { action: "market-closed", paperOnly: true };
  }

  const [positions, openOrders, allOrders] = await Promise.all([
    tradingRequest(env, "/v2/positions"),
    tradingRequest(env, "/v2/orders?status=open&limit=500&direction=desc"),
    tradingRequest(env, "/v2/orders?status=all&limit=500&direction=desc&nested=false"),
  ]);

  const symbols = [...new Set([...config.universe, ...positions.map((position) => position.symbol)])];
  const barsBySymbol = await fetchBars(env, symbols, now);

  if (positions.length > 0) {
    const position = positions[0];
    const metrics = momentumMetrics(barsBySymbol[position.symbol]);
    const reason = positionExitReason({ account, config, metrics, now, position });
    if (!config.tradingEnabled) {
      return { action: "dry-run-position", paperOnly: true, reason, symbol: position.symbol };
    }
    if (reason) {
      return { ...(await closePosition(env, position, openOrders, dateTag, reason)), paperOnly: true };
    }
    return {
      ...(await ensureProtectiveStop(env, config, position, openOrders, dateTag)),
      paperOnly: true,
      symbol: position.symbol,
    };
  }

  if (accountDailyReturn(account) <= -config.dailyLossLimitPct) {
    return { action: "daily-loss-lockout", paperOnly: true };
  }
  if (minutes < config.entryStartMinutes || minutes > config.entryEndMinutes) {
    return { action: "outside-entry-window", paperOnly: true };
  }
  if (openOrders.length > 0) {
    return { action: "open-order-present", paperOnly: true };
  }
  if (allOrders.some((order) => order.client_order_id?.startsWith(`${ORDER_PREFIX}-entry-${dateTag}`))) {
    return { action: "daily-entry-already-used", paperOnly: true };
  }

  const candidate = selectMomentumCandidate(barsBySymbol, config.universe);
  if (!candidate) return { action: "no-signal", paperOnly: true };

  const asset = await tradingRequest(env, `/v2/assets/${encodeURIComponent(candidate.symbol)}`);
  if (!asset.tradable || !asset.fractionable || asset.status !== "active") {
    return { action: "asset-not-eligible", paperOnly: true, symbol: candidate.symbol };
  }

  const available = Math.min(
    Number(account.equity),
    Number(account.cash),
    Number(account.buying_power),
  );
  const notional = Math.floor(available * config.allocationPct * 100) / 100;
  if (!Number.isFinite(notional) || notional < 1) {
    return { action: "insufficient-paper-cash", paperOnly: true };
  }

  if (!config.tradingEnabled) {
    return {
      action: "dry-run-entry",
      notional,
      paperOnly: true,
      score: candidate.metrics.score,
      symbol: candidate.symbol,
    };
  }

  const order = await tradingRequest(env, "/v2/orders", {
    body: JSON.stringify({
      client_order_id: `${ORDER_PREFIX}-entry-${dateTag}`,
      notional: notional.toFixed(2),
      side: "buy",
      symbol: candidate.symbol,
      time_in_force: "day",
      type: "market",
    }),
    method: "POST",
  });
  const protection = await protectFilledEntry(env, config, order, openOrders, dateTag);
  return {
    action: "entry-submitted",
    notional,
    orderId: order.id,
    paperOnly: true,
    protection,
    symbol: candidate.symbol,
  };
}

function healthPayload(env) {
  const config = getConfig(env);
  return {
    allocationPct: config.allocationPct,
    dailyLossLimitPct: config.dailyLossLimitPct,
    mode: config.tradingEnabled ? "paper-enabled" : "paper-dry-run",
    paperOnly: true,
    schedule: "every five minutes; Alpaca market clock gated",
    stopLossPct: config.stopLossPct,
    takeProfitPct: config.takeProfitPct,
    universe: config.universe,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/health") {
      return new Response("Not found", { status: 404 });
    }
    return Response.json(healthPayload(env));
  },

  async scheduled(controller, env, context) {
    const task = runBot(env, new Date(controller.scheduledTime || Date.now()))
      .then((result) => console.log(JSON.stringify(result)))
      .catch((error) => console.error(JSON.stringify({ error: error.message, paperOnly: true })));
    context.waitUntil(task);
  },
};

export {
  MARKET_DATA_BASE_URL,
  PAPER_TRADING_BASE_URL,
  accountDailyReturn,
  easternParts,
  getConfig,
  healthPayload,
  momentumMetrics,
  positionExitReason,
  roundOrderPrice,
  runBot,
  selectMomentumCandidate,
};
