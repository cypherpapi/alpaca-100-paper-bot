import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { runSingletonCheck, startupDiagnostic, SINGLETON_KEY } from "../src/singleton.js";
import { DiagnosticExecutor, dispatchDiagnostic, EXECUTOR_NAME } from "../src/diagnostic-executor.js";
import { barFreshness } from "../src/index.js";
import { assessWatchdog } from "../src/watchdog.js";

const time = new Date("2026-10-15T14:00:00Z");
const claim = (id = "one", slot = 1) => ({ runId: id, slot, now: time });
const done = () => ({ action: "no-signal", executed: true, ready: true,
  data: { symbols: [{ fresh: true }] }, completedAt: time.toISOString() });
function store() {
  let state = new Map(), queue = Promise.resolve(), puts = 0, failPut = Infinity;
  const clone = (x) => x === undefined ? undefined : structuredClone(x);
  return {
    get: async (key) => clone(state.get(key)),
    failAtPut: (n) => { failPut = n; },
    transaction(fn) {
      const next = queue.then(async () => {
        const draft = new Map([...state].map(([k, v]) => [k, clone(v)]));
        const tx = {
          get: async (key) => clone(draft.get(key)),
          put: async (key, value) => {
            if (++puts === failPut) throw new Error("storage-failed");
            draft.set(key, clone(value));
          },
        };
        const result = await fn(tx);
        state = draft;
        return result;
      });
      queue = next.catch(() => {});
      return next;
    },
  };
}
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const request = (at = time) => new Request("https://singleton.invalid/check", {
  method: "POST", body: JSON.stringify({ scheduledAt: at.toISOString() }),
});

test("shared store blocks overlapping independent clients without queuing work", async () => {
  const storage = store(), started = deferred(), finish = deferred();
  let calls = 0;
  const first = runSingletonCheck(storage, claim(), async () => {
    calls++; started.resolve(); await finish.promise; return done();
  });
  await started.promise;
  const second = await runSingletonCheck(storage, claim("two", 2), async () => { calls++; return done(); });
  assert.equal(second.action, "singleton-busy");
  assert.equal(calls, 1);
  finish.resolve(); await first;
  assert.equal((await storage.get(SINGLETON_KEY)).active, undefined);
});

test("completed slots are deduplicated, older slots rejected, next slot allowed", async () => {
  const storage = store();
  await runSingletonCheck(storage, claim(), async () => done());
  for (const slot of [0, 1]) {
    const result = await runSingletonCheck(storage, claim("repeat", slot), async () => assert.fail("no replay"));
    assert.equal(result.action, "singleton-duplicate");
  }
  const result = await runSingletonCheck(storage, claim("next", 2), async () => done());
  assert.equal(result.action, "no-signal");
});

test("uncertain runner error retains lock across client restart and long elapsed time", async () => {
  const storage = store();
  await assert.rejects(runSingletonCheck(storage, claim(), async () => { throw Error("uncertain"); }), /uncertain/);
  const result = await runSingletonCheck(storage, { ...claim("restart", 10000),
    now: new Date("2026-11-15T14:00:00Z") }, async () => assert.fail("no expired-lease takeover"));
  assert.equal(result.action, "singleton-busy");
  assert.equal((await storage.get(SINGLETON_KEY)).active.runId, "one");
});

test("failed claim does not execute; failed completion retains durable active state", async () => {
  const storage = store(); storage.failAtPut(1);
  await assert.rejects(runSingletonCheck(storage, claim(), async () => assert.fail("no execution")), /storage-failed/);
  const other = store(); other.failAtPut(2);
  await assert.rejects(runSingletonCheck(other, claim(), async () => done()), /storage-failed/);
  assert.ok((await other.get(SINGLETON_KEY)).active);
});

test("owner mismatch fails closed", async () => {
  const storage = store();
  await assert.rejects(runSingletonCheck(storage, claim(), async () => {
    await storage.transaction(async (tx) => tx.put(SINGLETON_KEY, {
      active: { ...claim("different"), startedAt: time.toISOString() },
    }));
    return done();
  }), /singleton-owner-lost/);
});

test("startup diagnostic is credential-free and refuses enabled trading", () => {
  assert.equal(startupDiagnostic({}, time).reason, "credentials-unconfigured");
  const r = startupDiagnostic({ TRADING_ENABLED: "true", ALPACA_API_KEY_ID: "mock",
    ALPACA_API_SECRET_KEY: "mock-secret" }, time);
  assert.equal(r.action, "trading-mode-refused");
  assert.equal(r.ready, false);
  assert.ok(!JSON.stringify(r).includes("mock-secret"));
});

test("unconfigured dispatcher fails closed before any network or broker work", async () => {
  await assert.rejects(dispatchDiagnostic({}, time), /binding-unconfigured/);
});

test("dispatcher always routes independent callers to one fixed identity", async () => {
  const names = [];
  const env = { PAPER_EXECUTOR: {
    idFromName: (name) => { names.push(name); return name; },
    get: (id) => ({ fetch: async (req) => {
      assert.equal(id, EXECUTOR_NAME); assert.equal(req.method, "POST");
      assert.equal((await req.json()).scheduledAt, time.toISOString());
      return Response.json({ action: "startup-diagnostic" });
    } }),
  } };
  await dispatchDiagnostic(env, time); await dispatchDiagnostic(env, time);
  assert.deepEqual(names, [EXECUTOR_NAME, EXECUTOR_NAME]);
});

test("two object instances sharing durable storage exclude each other", async () => {
  const storage = store(), started = deferred(), finish = deferred();
  const env = { ALPACA_API_KEY_ID: "mock", ALPACA_API_SECRET_KEY: "mock-secret" };
  const first = new DiagnosticExecutor({ storage }, env, { now: () => time, runId: () => "one",
    run: async (passed) => {
      assert.equal(passed.TRADING_ENABLED, "false");
      started.resolve(); await finish.promise; return done();
    } });
  const second = new DiagnosticExecutor({ storage }, env, { now: () => time, runId: () => "two",
    run: async () => assert.fail("must be excluded") });
  const pending = first.fetch(request()); await started.promise;
  assert.equal((await (await second.fetch(request())).json()).action, "singleton-busy");
  finish.resolve(); await pending;
});

test("object startup without credentials persists not-ready heartbeat without broker calls", async () => {
  const storage = store();
  const object = new DiagnosticExecutor({ storage }, {}, { now: () => time, runId: () => "one",
    run: async () => assert.fail("no broker calls") });
  const result = await (await object.fetch(request())).json();
  assert.equal(result.reason, "credentials-unconfigured");
  const heartbeat = (await storage.get(SINGLETON_KEY)).heartbeat;
  assert.equal(heartbeat.executed, false);
  assert.equal(heartbeat.ready, false);
  assert.ok(!JSON.stringify(heartbeat).includes("SECRET"));
});

test("object refuses live flag even with a binding and injected runner", async () => {
  const object = new DiagnosticExecutor({ storage: store() }, { TRADING_ENABLED: "true" },
    { now: () => time, runId: () => "one", run: async () => assert.fail("no execution") });
  assert.equal((await (await object.fetch(request())).json()).action, "trading-mode-refused");
});

test("old, future and malformed schedule requests never claim or run", async () => {
  const storage = store();
  const object = new DiagnosticExecutor({ storage }, {}, { now: () => time, runId: () => "one",
    run: async () => assert.fail("no replay") });
  for (const at of [new Date(time.getTime() - 300_000), new Date(time.getTime() + 1)]) {
    assert.equal((await object.fetch(request(at))).status, 409);
  }
  const malformed = new Request("https://singleton.invalid/check", { method: "POST", body: "{}" });
  assert.equal((await object.fetch(malformed)).status, 409);
  assert.equal(await storage.get(SINGLETON_KEY), undefined);
});

test("watchdog requires an exchange calendar and handles holiday/early close", () => {
  assert.equal(assessWatchdog({ now: time }).reason, "calendar-required");
  assert.equal(assessWatchdog({ now: time, calendar: { closed: true } }).alert, false);
  assert.equal(assessWatchdog({ now: new Date("2026-11-27T18:01:00Z"),
    calendar: { openAt: "2026-11-27T14:30:00Z", entryStartAt: "2026-11-27T14:40:00Z",
      closeAt: "2026-11-27T18:00:00Z" } }).reason, "outside-monitored-session");
});
const calendar = { openAt: "2026-10-15T13:30:00Z", entryStartAt: "2026-10-15T13:40:00Z",
  closeAt: "2026-10-15T20:00:00Z" };
function heartbeat(at = time.toISOString()) {
  return { completedAt: at, ready: true, executed: true, mode: "paper-dry-run", dataFresh: true };
}

test("watchdog reports missed startup and does not count previous-day completion", () => {
  assert.equal(assessWatchdog({ now: time, calendar }).reason, "startup-missed");
  assert.equal(assessWatchdog({ now: time, calendar,
    state: { heartbeat: heartbeat("2026-10-14T19:55:00Z") } }).reason, "startup-missed");
  assert.equal(assessWatchdog({ now: new Date("2026-10-15T13:41:00Z"), calendar }).alert, false);
});

test("watchdog distinguishes healthy, not-ready, stale data, overdue and stalled", () => {
  const check = (state) => assessWatchdog({ now: time, calendar, state });
  assert.equal(check({ heartbeat: heartbeat() }).reason, "healthy");
  assert.equal(check({ heartbeat: { ...heartbeat(), executed: false } }).reason, "startup-not-ready");
  assert.equal(check({ heartbeat: { ...heartbeat(), dataFresh: false } }).reason, "market-data-not-fresh");
  assert.equal(check({ heartbeat: heartbeat("2026-10-15T13:47:59Z") }).reason, "completion-overdue");
  assert.equal(check({ active: { startedAt: "2026-10-15T13:57:59Z" }, heartbeat: heartbeat() }).reason,
    "execution-stalled-or-uncertain");
});

test("watchdog UTC calendar handles winter Eastern entry without a fixed UTC offset", () => {
  const winter = { openAt: "2026-12-01T14:30:00Z", entryStartAt: "2026-12-01T14:40:00Z",
    closeAt: "2026-12-01T21:00:00Z" };
  assert.equal(assessWatchdog({ now: new Date("2026-12-01T14:41:00Z"), calendar: winter }).reason, "awaiting-startup");
  assert.equal(assessWatchdog({ now: new Date("2026-12-01T14:43:00Z"), calendar: winter }).reason, "startup-missed");
});

test("freshness permits a missing update but rejects older than eleven minutes", () => {
  for (const [age, fresh] of [[300_000, true], [600_000, true], [660_000, true], [660_001, false]]) {
    assert.equal(barFreshness({ SPY: [{ t: new Date(time.getTime() - age).toISOString() }] },
      ["SPY"], time)[0].fresh, fresh);
  }
  // Age alone deliberately does not establish a completed aggregate.
  assert.equal(barFreshness({ SPY: [{ t: "2026-10-15T13:55:00Z" }] },
    ["SPY"], new Date("2026-10-15T13:57:00Z"))[0].fresh, true);
});

test("push workflow contains only mock CI with no scheduler, secrets, broker entrypoint or deploy", () => {
  const workflow = fs.readFileSync(new URL("../.github/workflows/paper-bot.yml", import.meta.url), "utf8");
  assert.match(workflow, /push:/);
  assert.match(workflow, /tools\/network-guard.cjs/);
  for (const forbidden of [/schedule:/, /secrets\./, /run-session/, /run-once/, /wrangler/, /BOT_ACTIVE/, /TRADING_ENABLED/]) {
    assert.doesNotMatch(workflow, forbidden);
  }
});

test("legacy CLI entrypoints cannot bypass the singleton draft", () => {
  for (const path of ["run-once.js", "run-session.js"]) {
    const source = fs.readFileSync(new URL("../src/" + path, import.meta.url), "utf8");
    assert.doesNotMatch(source, /import.*(?:runBot|runSession)/);
    assert.match(source, /legacy-cli-disabled/);
    assert.match(source, /process.exitCode = 1/);
  }
});

test("review Wrangler config has no active cron or provisioned singleton binding", () => {
  const config = JSON.parse(fs.readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  assert.deepEqual(config.triggers.crons, []);
  assert.equal(config.durable_objects, undefined);
  assert.equal(config.migrations, undefined);
});
