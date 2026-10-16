import { easternParts, runBot } from "./index.js";

const INTERVAL_MS = 5 * 60_000;

function inSession(now) {
  const { minutes } = easternParts(now);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short",
  }).format(now);
  return !["Sat", "Sun"].includes(weekday) && minutes >= 9 * 60 && minutes < 16 * 60;
}

// Serial checks; never retry an uncertain trading result or replay missed intervals.
export async function runSession(env, {
  sessionMinutes = 350,
  now = () => new Date(),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  run = runBot,
  log = (result) => console.log(JSON.stringify(result)),
} = {}) {
  if (!Number.isInteger(sessionMinutes) || sessionMinutes < 1 || sessionMinutes > 350) {
    throw new Error("SESSION_MAX_MINUTES must be an integer from 1 through 350");
  }
  const started = now();
  const deadline = started.getTime() + sessionMinutes * 60_000;
  let checks = 0;
  let reason = "session-ended";
  const emit = (event, extra = {}) => log({ event, timestamp: now().toISOString(),
    commit: env.GITHUB_SHA || null, paperOnly: true, ...extra });
  emit("session-started", { entryStartEt: env.ENTRY_START_ET || "09:40",
    entryEndEt: env.ENTRY_END_ET || "14:30",
    lateForEntryStart: easternParts(started).minutes > (() => {
      const [h, m] = (env.ENTRY_START_ET || "09:40").split(":").map(Number);
      return h * 60 + m;
    })() });
  if (!inSession(started)) {
    emit("session-skipped", { reason: "outside-session", checks: 0 });
    return;
  }
  try {
    while (now().getTime() < deadline && inSession(now())) {
      const startedAt = now();
      emit("check-started", { check: checks + 1 });
      const result = await run(env, startedAt);
      checks += 1;
      emit("check-complete", { ...result, timestamp: startedAt.toISOString(), checks });
      if (result.action === "blocked-account" ||
          (result.action === "market-closed" && easternParts(startedAt).minutes >= 9 * 60 + 30)) {
        reason = result.action;
        break;
      }
      const current = now().getTime();
      const next = (Math.floor(current / INTERVAL_MS) + 1) * INTERVAL_MS;
      if (next >= deadline || !inSession(new Date(next))) break;
      emit("session-heartbeat", { checks, nextCheckAt: new Date(next).toISOString() });
      await wait(next - current);
    }
  } catch (error) {
    reason = "check-failed";
    emit("session-failed", { reason, checks });
    throw error;
  } finally {
    emit("session-completed", { reason, checks });
  }
}
