import { easternParts, runBot } from "./index.js";

const INTERVAL_MS = 5 * 60_000;
const SESSION_MS = 350 * 60_000;

function inSession(now) {
  const { minutes } = easternParts(now);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short",
  }).format(now);
  return !["Sat", "Sun"].includes(weekday) && minutes >= 9 * 60 && minutes < 16 * 60;
}

// A single awaited loop: never overlap checks or replay missed intervals.
// GitHub's existing concurrency group serializes entire sessions.
export async function runSession(env, {
  now = () => new Date(),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  run = runBot,
  log = (result) => console.log(JSON.stringify(result)),
} = {}) {
  const deadline = now().getTime() + SESSION_MS;
  while (now().getTime() < deadline && inSession(now())) {
    const startedAt = now();
    const result = await run(env, startedAt);
    log({ timestamp: startedAt.toISOString(), commit: env.GITHUB_SHA || null, ...result });
    // Stay awake through pre-open so a delayed 9 a.m. startup is still useful.
    if (result.action === "blocked-account" ||
        (result.action === "market-closed" && easternParts(startedAt).minutes >= 9 * 60 + 30)) return;
    const current = now().getTime();
    const next = (Math.floor(current / INTERVAL_MS) + 1) * INTERVAL_MS;
    if (next >= deadline || !inSession(new Date(next))) return;
    await wait(next - current);
  }
}
