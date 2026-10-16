import { runSession } from "./session.js";
import { runBot } from "./index.js";

// Initial validation adapter only. A repository variable cannot enable orders here.
export async function runReadOnlySession(env, options = {}) {
  const sessionMinutes = env.SESSION_MAX_MINUTES === undefined ? 350 : Number(env.SESSION_MAX_MINUTES);
  return runSession({ ...env, TRADING_ENABLED: "false" }, { ...options, sessionMinutes });
}

export async function runReadOnlyCheck(env, now = new Date(), run = runBot) {
  return run({ ...env, TRADING_ENABLED: "false" }, now);
}
