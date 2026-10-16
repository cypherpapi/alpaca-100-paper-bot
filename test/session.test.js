import test from "node:test";
import assert from "node:assert/strict";
import { runSession } from "../src/session.js";

function harness(at, run) {
  let time = new Date(at).getTime();
  const logs = [];
  const options = {
    now: () => new Date(time),
    wait: async (ms) => { time += ms; },
    run: async (env, now) => run(env, now, (ms) => { time += ms; }),
    log: (result) => { if (result.event === "check-complete") logs.push(result); },
  };
  return { options, logs };
}

test("session runs serial five-minute checks through closing window", async () => {
  const calls = [];
  const h = harness("2026-10-08T19:44:17Z", async (env, now) => {
    calls.push(now.toISOString());
    return { action: "no-signal", paperOnly: true };
  });
  await runSession({ GITHUB_SHA: "test-commit" }, h.options);
  assert.deepEqual(calls, ["2026-10-08T19:44:17.000Z", "2026-10-08T19:45:00.000Z", "2026-10-08T19:50:00.000Z", "2026-10-08T19:55:00.000Z"]);
  assert.equal(h.logs[0].commit, "test-commit");
  assert.equal(h.logs[0].timestamp, calls[0]);
});

test("slow checks skip missed slots without overlapping or catch-up calls", async () => {
  const calls = [];
  const h = harness("2026-10-08T19:40:00Z", async (env, now, advance) => {
    calls.push(now.toISOString());
    advance(7 * 60_000);
    return { action: "no-signal" };
  });
  await runSession({}, h.options);
  assert.deepEqual(calls, ["2026-10-08T19:40:00.000Z", "2026-10-08T19:50:00.000Z"]);
});

test("session stops on an uncertain execution error without retry", async () => {
  let calls = 0;
  const h = harness("2026-10-08T16:00:00Z", async () => {
    calls++;
    throw new Error("uncertain order result");
  });
  await assert.rejects(runSession({}, h.options), /uncertain order result/);
  assert.equal(calls, 1);
});

test("pre-open startup waits; holidays, weekends and late starts stop safely", async () => {
  let calls = 0;
  const h = harness("2026-10-08T13:20:00Z", async () => {
    calls++;
    return { action: "market-closed" };
  });
  await runSession({}, h.options);
  assert.equal(calls, 3);
  for (const at of ["2026-10-10T16:00:00Z", "2026-10-08T23:00:00Z"]) {
    const h = harness(at, async () => assert.fail("must not run"));
    await runSession({}, h.options);
  }
});

test("sessions end before GitHub's six-hour runner limit", async () => {
  const h = harness("2026-10-08T13:30:00Z", async () => ({ action: "no-signal" }));
  await runSession({}, h.options);
  assert.equal(h.logs.at(-1).timestamp, "2026-10-08T19:15:00.000Z");
  assert.equal(h.logs.length, 70);
});
