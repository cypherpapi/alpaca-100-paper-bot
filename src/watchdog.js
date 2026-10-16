// Pure evaluator only: no timers, network, alert delivery, retries or credentials.
const MINUTE_MS = 60_000;
export function assessWatchdog({ now, calendar, state,
  graceMs = 2 * MINUTE_MS, cadenceMs = 5 * MINUTE_MS, stallMs = 2 * MINUTE_MS }) {
  const time = now.getTime();
  const result = (reason, alert, extra = {}) => ({ reason, alert, paperOnly: true, ...extra });
  if (![time, graceMs, cadenceMs, stallMs].every(Number.isFinite) ||
      graceMs < 0 || cadenceMs <= 0 || stallMs <= 0) return result("invalid-watchdog-input", true);
  const active = state?.active;
  if (active) {
    const started = Date.parse(active.startedAt);
    if (!Number.isFinite(started) || started > time) return result("invalid-active-heartbeat", true);
    if (time - started > stallMs) return result("execution-stalled-or-uncertain", true);
  }
  // Calendar is supplied from an independently verified exchange calendar.
  // A weekday/timezone guess is not a substitute for holidays and early closes.
  if (!calendar) return result("calendar-required", true);
  if (calendar.closed === true) return result("exchange-closed", false);
  const open = Date.parse(calendar.openAt), close = Date.parse(calendar.closeAt);
  const entry = Date.parse(calendar.entryStartAt);
  if (![open, close, entry].every(Number.isFinite) || open >= close || entry < open || entry >= close) {
    return result("invalid-calendar", true);
  }
  if (time < open || time >= close) return result("outside-monitored-session", false);
  const heartbeat = state?.heartbeat;
  if (!heartbeat) return result(time > entry + graceMs ? "startup-missed" : "awaiting-startup",
    time > entry + graceMs);
  const completed = Date.parse(heartbeat.completedAt);
  if (!Number.isFinite(completed) || completed > time) return result("invalid-completion-heartbeat", true);
  if (completed < open) return result(time > entry + graceMs ? "startup-missed" : "awaiting-startup",
    time > entry + graceMs);
  if (heartbeat.ready !== true || heartbeat.executed !== true) return result("startup-not-ready", true);
  if (heartbeat.mode !== "paper-dry-run") return result("unexpected-execution-mode", true);
  if (time - completed > 2 * cadenceMs + graceMs) return result("completion-overdue", true);
  if (heartbeat.dataFresh === false) return result("market-data-not-fresh", true);
  if (active) return result("check-in-progress", false);
  return result("healthy", false);
}
