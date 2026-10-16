# Reliability repair status

This branch repairs code and adds mock-only verification. It does not deploy or activate a trading executor. A passing check is not an order, fill, or evidence that the complaint about no trades since October 8 has been resolved operationally.

## Verified baseline and observed run behavior
Main was re-read at b8dc0ce7b77f9c761c0ae4a7e4b855a4da7162bb. Its unchanged commit and the local original/ snapshot preserve recoverable source. Existing main push behavior could execute the bot, so this repair is isolated on a non-trading review branch.

- [October 15 session](https://github.com/cypherpapi/alpaca-100-paper-bot/actions/runs/38779028659): first check 2026-10-15T17:38:40.632Z (10:38 a.m. Pacific), almost four hours after the 09:40 Eastern / 06:40 Pacific entry start. Logs contain 29 checks: 12 no-signal and 17 outside-entry-window. Last check 19:55Z. Paper cash/equity remained $94.16 and daily P/L was $0. No entry/fill actions appeared.
- Its 12 ranking payloads had five distinct values, with a longest identical streak of eight checks. Stale data remains unproven: baseline logs lack newest-bar timestamps.
- [After-hours session](https://github.com/cypherpapi/alpaca-100-paper-bot/actions/runs/38802659378): successful job with zero check results, consistent with the baseline loop silently skipping outside its session.
- Recent scheduled runs are often created/started late. For the October 15 sessions, API creation and start times are equal; these records do not establish whether missing earlier starts were caused by delayed dispatch, replaced pending runs, or another scheduling condition. A long session submitted every five minutes under one Actions concurrency group does not provide reliable entry-time execution.

## Published repair scope
Pagination, per-symbol latest bar/count/age diagnostics, freshness checks and position safety fallback; explicit startup/skipped/check/failure/heartbeat reporting; a dry-run-only shared durable singleton draft and watchdog evaluator; retired direct broker CLI runners; inactive Wrangler crons; and test-only CI with no broker credentials, trading commands, deployment, or scheduled trigger. No strategy thresholds changed.

The scheduled adapter now requires an unprovisioned shared executor binding and refuses enabled trading. It cannot silently bypass the lock or be turned into order execution by changing TRADING_ENABLED. The watchdog is a pure evaluator; no hosted service or alert destination exists.

## Validation
The existing local preparation passed 57 mocked tests; they were re-run for publication with the network guard. Seven production modules are syntax-checked directly using Node. GitHub CI must be checked on this PR's exact head before claiming remote success. Local originals and split/reverse-check artifacts remain available in the workspace.

## What remains blocked
No code is merged to main or deployed. Existing hosted/default-branch behavior is unchanged by this PR. Hosted Durable Object binding/migration, real persistence/reset tests, independent watchdog hosting/authentication/calendar/alerts and a dry-run deployment require separate authorization. No real market-data or account call was made for this repair, so account restrictions/entitlements and actual signal execution remain unvalidated. No order placement is authorized. A future trading-enabled proposal requires a separate reviewed code change and explicit approval; this draft is intentionally dry-run-only.

For technical detail, see RELIABILITY_REVIEW.md and FRESHNESS_REVIEW.md. Any landing plan must stop/drain old revisions first, retain the mock-only workflow and disabled schedules, and avoid replaying missed checks. Never restore the old push-triggered trading workflow as part of rollback.
