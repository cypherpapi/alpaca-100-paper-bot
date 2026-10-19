import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { runSession } from "../src/session.js";
import { runReadOnlyCheck, runReadOnlySession } from "../src/runner.js";

test("read-only check cannot inherit an enabled trading variable", async () => {
  const result = await runReadOnlyCheck({ TRADING_ENABLED: "true" }, new Date(), async (env) => {
    assert.equal(env.TRADING_ENABLED, "false");
    return { action: "dry-run-entry" };
  });
  assert.equal(result.action, "dry-run-entry");
});

test("read-only session cannot inherit enabled trading and honors a short duration", async () => {
  let time = Date.parse("2026-10-15T13:25:00Z"), count = 0;
  await runReadOnlySession({ TRADING_ENABLED: "true", SESSION_MAX_MINUTES: "10" }, {
    now: () => new Date(time), wait: async (ms) => { time += ms; }, log: () => {},
    run: async (env) => { assert.equal(env.TRADING_ENABLED, "false"); count++; return { action: "no-signal" }; },
  });
  assert.equal(count, 2);
});

test("session rejects invalid duration without invoking the broker", async () => {
  for (const sessionMinutes of [0, 351, 1.5, NaN]) {
    await assert.rejects(runSession({}, { sessionMinutes, run: async () => assert.fail("must not run") }),
      /SESSION_MAX_MINUTES/);
  }
});

test("two serial sessions cover entry and force-exit windows without a six-hour job", async () => {
  let time = Date.parse("2026-10-15T13:25:00Z");
  const checks = [];
  const options = {
    now: () => new Date(time), wait: async (ms) => { time += ms; }, log: () => {},
    run: async (env, now) => { checks.push(now.toISOString()); return { action: "no-signal" }; },
  };
  await runReadOnlySession({ SESSION_MAX_MINUTES: "210" }, options);
  assert.ok(time < Date.parse("2026-10-15T17:00:00Z"));
  time += 60_000; // Mock runner handoff; no real sleep or scheduler.
  await runReadOnlySession({ SESSION_MAX_MINUTES: "350" }, options);
  assert.ok(checks.includes("2026-10-15T13:40:00.000Z"));
  assert.ok(checks.includes("2026-10-15T19:50:00.000Z"));
  assert.equal(checks.at(-1), "2026-10-15T19:55:00.000Z");
});

test("failed uncertain first session does not get automatically retried", async () => {
  let count = 0;
  await assert.rejects(runReadOnlySession({}, {
    now: () => new Date("2026-10-15T13:40:00Z"), log: () => {},
    run: async () => { count++; throw Error("uncertain"); },
  }), /uncertain/);
  assert.equal(count, 1);
});

test("mock CI remains credential-free; older session workflow stays dormant", () => {
  const ci = fs.readFileSync(new URL("../.github/workflows/paper-bot.yml", import.meta.url), "utf8");
  assert.doesNotMatch(ci, /secrets\.|schedule:|run-session|run-once|wrangler/);
  const review = fs.readFileSync(new URL("../deployment/manual-readonly.workflow.review", import.meta.url), "utf8");
  assert.match(review, /needs: morning/);
  assert.match(review, /group: alpaca-paper-bot/);
  assert.match(review, /TRADING_ENABLED: "false"/);
  assert.doesNotMatch(review, /schedule:|push:/);
  assert.equal(fs.existsSync(new URL("../src/singleton.js", import.meta.url)), false);
  assert.equal(fs.existsSync(new URL("../src/diagnostic-executor.js", import.meta.url)), false);
});
