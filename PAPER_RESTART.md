## Current ongoing GitHub paper operation (October 20, 2026)

The existing account workflow now requests weekday kickoff at **09:40 America/New_York**
(`40 9 * * 1-5`, timezone-aware). One 210-minute morning session hands off only on
success to a closing session capped at 340 minutes, with 220/355-minute job timeouts.
The existing `alpaca-paper-bot` workflow lock serializes manual and scheduled runs;
there is no second executor or automatic uncertain-order retry. GitHub scheduling
is best effort, so configured kickoff is not proof of actual timely startup.

The ongoing adapter verifies an open, current market clock and GET-only account
access before starting. Each core check independently enforces account, data,
benchmark, candidate, and risk gates. It can continue position management after
14:30 even if entry data is unhealthy; it does not weaken entry eligibility.
Entries remain 09:40–14:30 ET, scheduled exits 15:50 ET, and sessions stop by 16:00 ET.
The closing cap leaves 15 minutes for setup/teardown within its job timeout.

Manual defaults remain read-only. `audit_only` runs the GET-only account audit;
`paper_test` retains the earlier bounded test; `ongoing_paper` starts the day path.
For a supervised five-minute run of the day adapter, set both `ongoing_paper` and
`supervised_test`; closing handoff is then skipped. Existing read-only CLI wrappers
remain read-only. Existing credentials and paper endpoints are reused.

Cloudflare overlap was reconciled from the original no-deployment setup history
and the known account inventory. No Cloudflare migration or paid service is used.
The earlier test made two no-signal checks; its subsequent audit verified zero
positions, open orders, and recent orders at 17:46 UTC. An actual scheduled start,
full-day handoff and 15:50 exit coverage still require observed run evidence.

Historical preparation notes follow; their pending-activation statements describe
older revisions and do not supersede the current operation above.

# Bounded paper restart

This change does not activate orders. Existing strategy, universe, allocation, stops,
entry windows, daily loss cap, entry limit, cooldown and exit rules are unchanged.
Existing GitHub repository Alpaca secrets are the only credential source. No host,
credential, repository variable or billing configuration is created or changed.

## Next evidence gate

`.github/workflows/paper-window-validation.yml` requests one run on October 20,
2026 at 13:45 UTC = 09:45 America/New_York = 06:45 America/Los_Angeles.
The date guard expires after that UTC date; the annual cron cannot validate in a
later year. Manual dispatch can recover a missed start while the entry window is
open. The job is bounded to ten minutes, uses the existing `alpaca-paper-bot`
concurrency group, runs network-disabled tests first and uses the existing secret
names. No order opt-in is present. It is not a recurring trading schedule.

The gate requires a connected, unblocked paper account, open market, a broker
clock within 60 seconds, weekday and strategy entry window (09:40–14:30 Eastern),
and at least 15 bars per universe/benchmark symbol. It rechecks every latest bar
against actual current time with the existing 660-second freshness ceiling.
Future, missing, incomplete or stale data fails closed. A subsequent dry-run
strategy check must have fresh data and no data error. Its action, ranking
rejections and symbol timestamps are logged, without account identifiers,
balances, headers or credentials. A no-signal result is valid; no signal is forced.
The existing provisional freshness limitations in FRESHNESS_REVIEW.md still apply.

Inspect the scheduled run's actual logs before supervised activation. A successful
mock CI, closed-market probe, or absent workflow run is not readiness. No success
file or repository variable automatically enables later orders.

## Prepared paper execution entrypoint (inactive)

`node tools/run-paper-restart.mjs` is GET-only validation and one dry-run check.
`node tools/run-paper-restart.mjs --paper-orders` additionally requires both
`PAPER_RESTART_APPROVED=true` and `TRADING_ENABLED=true` in that future process,
and repeats the current account/data gate before starting the existing serial
session. The default supervised session is 15 minutes; `SESSION_MAX_MINUTES`
must be an integer from 1 through 350. No workflow currently invokes this order
mode, and saved `TRADING_ENABLED=false` is preserved. Original read-only CLIs stay
forced false.

The transport rejects HTTP, credentials embedded in URLs, ports, unapproved hosts,
redirects and non-order mutations. Preflight accepts GET only. In approved order
mode all POST/PATCH/DELETE destinations must be HTTPS paper-api.alpaca.markets
under /v2/orders; data.alpaca.markets remains GET-only. An uncertain error is not
retried. Underlying per-check stale-entry and risk controls remain intact.

After the next-window gate is observed passing, the already-authorized supervised
restart still needs an operator/agent to start and observe the guarded paper
session using the existing GitHub secrets, confirm no other executor, and arrange
continuous supervision/closing coverage before leaving a position unattended.
No additional user approval for that authorized scope is implied here. A recurring
order workflow is intentionally not installed ahead of this evidence. Report the
actual trade or the strategy's reason for not trading.

GitHub cron and job startup are best effort and may be delayed or dropped. A
missed validation needs an observed manual start inside the entry window; a delay
past 14:30 Eastern fails the gate. This change does not claim reliable unattended
scheduling, session handoff or guaranteed execution.

## Approved per-symbol paper test (October 20, 2026)

Entry candidates retain the minimum 15 bars and maximum 660-second bar age.
An unhealthy individual symbol is excluded until healthy again; SPY and QQQ
must both be healthy for any entry or rotation. Stale held-position history
cannot drive rotation or trend exits. Account/time/loss safeguards and protective
stops remain active independently of bar eligibility.

The existing validation workflow defaults to read-only. Its explicit `paper_test`
manual input on `main` permits one five-minute gated paper session, sharing the
`alpaca-paper-bot` concurrency lock. Scheduled runs cannot enable orders. First
run read-only validation successfully on the merged commit; then request the
manual test. Each paper session repeats current account/clock/data gates. Entry
windows and ordinary strategy signals still apply; no order is forced. A bounded
session may leave an existing or new paper position protected by its broker stop;
it does not promise a scheduled-close check after the session ends.
