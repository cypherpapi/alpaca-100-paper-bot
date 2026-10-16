import { runSingletonCheck, startupDiagnostic, SINGLETON_KEY, CHECK_INTERVAL_MS } from "./singleton.js";

export const EXECUTOR_NAME = "single-paper-account-v1";

// Legacy fetch-style Durable Object draft. Not bound or migrated in wrangler.jsonc.
// Injected dependencies are for mock tests only; production defaults fail closed/dry-run.
export class DiagnosticExecutor {
  constructor(ctx, env, { run, now = () => new Date(), runId = () => crypto.randomUUID() } = {}) {
    this.storage = ctx.storage;
    this.env = env;
    this.run = run;
    this.now = now;
    this.runId = runId;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/status") {
      return Response.json(await this.storage.get(SINGLETON_KEY) || {});
    }
    if (request.method !== "POST" || url.pathname !== "/check") return new Response("Not found", { status: 404 });
    const body = await request.json();
    const now = this.now();
    const scheduledAt = Date.parse(body.scheduledAt);
    if (!Number.isFinite(scheduledAt) || scheduledAt > now.getTime() ||
        now.getTime() - scheduledAt >= CHECK_INTERVAL_MS) {
      return Response.json({ action: "schedule-skipped", executed: false }, { status: 409 });
    }
    const result = await runSingletonCheck(this.storage, {
      slot: Math.floor(scheduledAt / CHECK_INTERVAL_MS), now, runId: this.runId(),
    }, async () => {
      const startup = startupDiagnostic(this.env, now);
      if (!startup.ready) return startup;
      if (!this.run) throw new Error("diagnostic-runner-unconfigured");
      // A true live flag is refused above; false is also forced into the runner.
      const check = await this.run({ ...this.env, TRADING_ENABLED: "false" }, now);
      return { ...check, executed: true, ready: true, mode: "paper-dry-run",
        completedAt: this.now().toISOString() };
    });
    return Response.json(result);
  }
}

export async function dispatchDiagnostic(env, scheduledAt) {
  if (!env.PAPER_EXECUTOR?.idFromName || !env.PAPER_EXECUTOR?.get) {
    throw new Error("singleton-binding-unconfigured");
  }
  const id = env.PAPER_EXECUTOR.idFromName(EXECUTOR_NAME);
  const response = await env.PAPER_EXECUTOR.get(id).fetch(new Request("https://singleton.invalid/check", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ scheduledAt: scheduledAt.toISOString() }),
  }));
  const result = await response.json();
  if (!response.ok) throw new Error("singleton-check-skipped");
  return result;
}
