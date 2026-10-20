import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runOngoingPaper } from '../src/ongoing-paper.js';
const env = { ALPACA_API_KEY_ID: 'fixture-key', ALPACA_API_SECRET_KEY: 'fixture-secret', ONGOING_PAPER_APPROVED: 'true', PAPER_RESTART_APPROVED: 'true', TRADING_ENABLED: 'true' };
const at = new Date('2026-10-20T19:00:00Z'); // after entry cutoff, before forced exit
const fetch = async () => new Response(JSON.stringify({ is_open: true, timestamp: at.toISOString() }));
test('ongoing adapter requires explicit flags before accessing credentials', async () => {
  for (const key of ['ONGOING_PAPER_APPROVED', 'PAPER_RESTART_APPROVED', 'TRADING_ENABLED']) await assert.rejects(runOngoingPaper({ ...env, [key]: 'false' }, {
    phase: 'morning', fetchImpl: async () => assert.fail('no requests'),
  }), /not-approved/);
});
test('delayed closing continuation remains bounded and can manage positions with stale entry data', async () => {
  const original = globalThis.fetch;
  await runOngoingPaper(env, { phase: 'closing', now: () => at, fetchImpl: fetch,
    log: () => {}, run: async settings => {
      assert.equal(settings.TRADING_ENABLED, 'false');
      await assert.rejects(globalThis.fetch('https://paper-api.alpaca.markets/v2/orders', { method: 'POST' }));
      return { action: 'dry-run-position', dataError: 'market-data-unavailable' };
    }, session: async (settings, options) => {
      assert.equal(settings.TRADING_ENABLED, 'true'); assert.equal(options.sessionMinutes, 340);
      assert.equal(options.now(), at);
      await assert.rejects(globalThis.fetch('https://api.alpaca.markets/v2/orders', { method: 'POST' }));
    },
  });
  assert.equal(globalThis.fetch, original);
});
test('stale clock, closed market or blocked account stops continuation and restores transport', async () => {
  const original = globalThis.fetch;
  for (const failure of ['clock', 'account']) {
    await assert.rejects(runOngoingPaper(env, { phase: 'closing', now: () => at, log: () => {},
      fetchImpl: failure === 'clock' ? async () => new Response(JSON.stringify({ is_open: false })) : fetch,
      run: async () => ({ action: 'blocked-account' }), session: async () => assert.fail('no session'),
    }));
    assert.equal(globalThis.fetch, original);
  }
});
test('weekends and post-close starts skip without broker calls', async () => {
  for (const date of ['2026-10-24T14:00:00Z', '2026-10-20T20:00:00Z']) {
    await runOngoingPaper(env, { phase: 'morning', now: () => new Date(date), log: () => {},
      fetchImpl: async () => assert.fail('no request'), session: async () => assert.fail('no session') });
  }
});
test('one account workflow schedules bounded serial jobs and keeps audit/test modes separate', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/paper-window-validation.yml', import.meta.url), 'utf8');
  assert.match(workflow, /40 9 \* \* 1-5/); assert.match(workflow, /timezone: America\/New_York/);
  assert.match(workflow, /needs: morning/); assert.match(workflow, /timeout-minutes: 220/);
  assert.match(workflow, /timeout-minutes: 355/); assert.match(workflow, /group: alpaca-paper-bot/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /workflow_dispatch.*!inputs.ongoing_paper/);
  assert.match(workflow, /github.ref == 'refs\/heads\/main'.*github.event_name == 'schedule'.*inputs.ongoing_paper/);
  assert.match(workflow, /if: \$\{\{ !inputs.supervised_test \}\}/);
  assert.match(workflow, /audit_only:/); assert.match(workflow, /paper_test:/);
  assert.equal(fs.existsSync(new URL('../.github/workflows/ongoing-paper.yml', import.meta.url)), false);
});


test('supervised same-day test bounds the ongoing adapter to five minutes', async () => {
  await runOngoingPaper({ ...env, PAPER_SUPERVISED_TEST: 'true' }, { phase: 'morning', now: () => at,
    fetchImpl: fetch, log: () => {}, run: async () => ({ action: 'no-signal' }),
    session: async (_, options) => assert.equal(options.sessionMinutes, 5) });
});


test('slow read-only preflight cannot enable orders using an expired market clock', async () => {
  let current = at.getTime();
  await assert.rejects(runOngoingPaper(env, { phase: 'closing', now: () => new Date(current),
    fetchImpl: fetch, log: () => {}, run: async () => { current += 90_000; return { action: 'no-signal' }; },
    session: async () => assert.fail('no session after stale clock'),
  }), /market-clock-not-ready/);
});
