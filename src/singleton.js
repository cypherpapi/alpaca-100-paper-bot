// Draft: one durable transactional store per paper account. No lease expiry or replay.
export const SINGLETON_KEY = "paper-executor-v1";
export const CHECK_INTERVAL_MS = 5 * 60_000;

export async function runSingletonCheck(storage, { slot, now, runId }, run) {
  if (!storage?.transaction || !Number.isInteger(slot) || !Number.isFinite(now.getTime()) || !runId) {
    throw new Error("invalid-singleton-input");
  }
  const claim = await storage.transaction(async (tx) => {
    const state = await tx.get(SINGLETON_KEY) || {};
    if (state.active) return { action: "singleton-busy", executed: false };
    if (state.lastCompletedSlot !== undefined && slot <= state.lastCompletedSlot) {
      return { action: "singleton-duplicate", executed: false };
    }
    await tx.put(SINGLETON_KEY, { ...state, active: { runId, slot, startedAt: now.toISOString() } });
    return { claimed: true };
  });
  if (!claim.claimed) return claim;
  // Any exception (including a failed completion write) retains the durable active marker.
  // No automatic unlock: an operator must stop old executors and reconcile first.
  const result = await run();
  await storage.transaction(async (tx) => {
    const state = await tx.get(SINGLETON_KEY);
    if (state?.active?.runId !== runId || state.active.slot !== slot) {
      throw new Error("singleton-owner-lost");
    }
    await tx.put(SINGLETON_KEY, {
      lastCompletedSlot: slot,
      heartbeat: {
        startedAt: state.active.startedAt, completedAt: result.completedAt,
        runId, slot, mode: "paper-dry-run", executed: result.executed === true,
        outcome: result.action, ready: result.ready === true,
        dataFresh: result.data?.symbols?.every((item) => item.fresh) ?? null,
      },
    });
  });
  return result;
}

export function startupDiagnostic(env, now) {
  const credentialsPresent = Boolean(env.ALPACA_API_KEY_ID && env.ALPACA_API_SECRET_KEY);
  const tradingRefused = env.TRADING_ENABLED === "true";
  return {
    action: tradingRefused ? "trading-mode-refused" : "startup-diagnostic",
    paperOnly: true, mode: "paper-dry-run", executed: false,
    ready: credentialsPresent && !tradingRefused,
    reason: tradingRefused ? "draft-is-dry-run-only"
      : credentialsPresent ? null : "credentials-unconfigured",
    completedAt: now.toISOString(),
  };
}
