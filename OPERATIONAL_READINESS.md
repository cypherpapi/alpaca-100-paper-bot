# Operational readiness: use the existing GitHub runner

## Recommendation
Use the existing public GitHub Actions repository, existing Alpaca paper secrets and one serial execution path. Keep pagination, timestamp/freshness checks, explicit session reporting and mock CI. Do not require a Durable Object, new host, persistent token or independent watchdog to get the current bot through a verified session.

The proposed first validation is read-only, started manually around 09:25 Eastern (06:25 Pacific). One dispatch chains a 210-minute morning job and a closing job of up to 350 minutes. Each remains below GitHub's six-hour per-job limit. Workflow-level concurrency uses the existing alpaca-paper-bot group, and closing has needs: morning. This avoids overlapping account executors and covers the 15:50 Eastern forced-exit window. A single 350-minute runner started at 09:25 would end around 15:15, too early.

The draft manual workflow is deployment/manual-readonly.workflow.review, OUTSIDE .github/workflows. It is not installed or runnable as a workflow. Only credential-free mock CI is active. Both CLI wrappers force TRADING_ENABLED=false. No paper orders can be enabled with a repository variable in this validation revision. No credential-backed workflow has been run.

## What is verified from existing records
- Main was re-read at b8dc0ce7b77f9c761c0ae4a7e4b855a4da7162bb, and the repository is public, nonarchived.
- GitHub-hosted Ubuntu jobs ran on October 15 with TRADING_ENABLED=true in their nonsecret log metadata. The morning session made 29 checks (12 no-signal, 17 outside-entry-window), with unchanged $94.16 equity. The later successful job had zero check results. These are checks, not trades.
- The first check was 17:38:40Z, almost four hours after the 09:40 Eastern entry start. Eight consecutive ranking payloads were identical; stale data remains unproven because the old logs omitted latest timestamps.
- README explicitly describes GitHub as the existing free host and Cloudflare as optional. wrangler.jsonc proves a source configuration exists, not that a Worker, paid plan, secret, domain, or deployment is active.
- Current BOT_ACTIVE/TRADING_ENABLED values, secret presence/validity and Cloudflare account/billing state are not verified. Historical flags are not a current settings read. No credential values were read.
- No Cloudflare account tool is available. The connector rejected GET actions/workflows as an unsupported endpoint. It does not expose the required variables/billing/hosting settings reader. No permissions were accepted or new access created to work around this limitation.

## PR complexity review and compatibility correction
The prior 0b6e21d6 preparation commit is recoverable and passed 57 mock tests. It is deliberately quarantined but adds three new hosting modules, distributed lock recovery policy, a new namespace/migration and a watchdog contract. Its broker CLI entrypoints are retired and its Worker adapter depends on a missing binding. It is not a drop-in deployment for the existing GitHub setup.

The simpler revision removes that migration from the deployment path:
- Core data/observability repairs remain; strategy thresholds and paper-host pinning are unchanged.
- Existing serial session logic is reused with a bounded operational duration option for the closing-job handoff.
- GitHub CLI compatibility is restored for read-only validation rather than exiting unconditionally. Both adapters force false before calling the existing core.
- Cloudflare stays inactive, without a binding/migration. It is not a second executor.
- An independent watchdog is optional later hardening, not a prerequisite for the first working session. GitHub logs/notifications are enough to inspect this supervised validation; they cannot detect every never-started workflow.

With one GitHub execution path, workflow-level concurrency plus the awaited loop provides the needed nonoverlap. The old schedule and any old jobs must be stopped/drained before cutover. A Durable Object is only relevant if separately choosing concurrent/multiple-provider execution or Cloudflare; it is not required simply because the old cron was late.

## Cost
Recommended incremental hosting cost: $0 for standard GitHub-hosted runner minutes while this repository remains public. The draft adds no artifact upload, cache or larger runner. Existing provider/account charges and current billing totals were not inspected; this is not a claim that every account service is free. No hosting purchase, paid plan, billing permission or credential is required for this path.
Official source: https://docs.github.com/en/billing/concepts/product-billing/github-actions

Cloudflare plan/deployment/cost are unverified from accessible records and are irrelevant to the recommended path. Do not buy a plan or provision a namespace to unblock this repair.

## Exact missing steps and required authorization
1. The simpler candidate passed 43 network-blocked mock tests and five Node syntax checks locally. Review its source diff and confirm test-only CI passes the revised PR head. Do not merge the earlier architecture draft as though it could run the existing workflow unchanged.
2. Obtain explicit approval to stop/drain old-revision workflows and land the GitHub-only repair on main with push triggers restricted to test CI. Keep schedules absent and Cloudflare inactive. We have not stopped jobs, merged, changed repository flags, or deployed anything.
3. A repository owner must verify, in Settings without disclosing values, that both existing paper-secret names are present and BOT_ACTIVE is appropriate. Before resuming orders, confirm there is no other account executor (including any optional old Cloudflare Worker); this is not a hosting prerequisite for a read-only connectivity test. There is no evidence a new credential is needed. If existing secrets are missing or invalid, stop for the owner's action instead of creating or exposing them.
4. Obtain explicit permission for one credential-backed READ-ONLY dry-run session against the existing paper account. Install the reviewed manual-only workflow after that approval; a push cannot invoke it because it has no push or schedule trigger. Start it manually before the entry window and inspect startup time, timestamps/freshness, both job handoff and closing coverage. No order path is enabled.
5. If that read-only run succeeds, obtain separate explicit permission to resume the existing PAPER ORDER execution. This validation revision deliberately forces false: removing that temporary guard and reusing the existing paper flag is a small, separate reviewed activation change. It does not require a new host or strategy-threshold change. Do not activate until old executors are excluded and any uncertain account state is reconciled.
6. Initially start each trading day's workflow manually and confirm it started. Existing GitHub cron is best effort: logs already show missed morning startup. Merely changing cron spacing/timezone cannot guarantee on-time execution. After a complete observed paper session, decide whether to re-enable one daily kickoff schedule with manual fallback. If fully unattended, punctual execution is mandatory, GitHub alone cannot satisfy that requirement; a separately reviewed reliable trigger/provider is then warranted.

The immediate approval/action can be stated as: "Approve the GitHub-only repair landing with automatic execution off, and one manually started read-only paper validation using the existing secrets." That does NOT authorize orders, new credentials, recurring schedules or spending. Paper order resumption remains a separate explicit approval.

## Limits and sources
The 11-minute gate is provisional: it allows one missing five-minute update and does not establish that aggregates are complete. Read FRESHNESS_REVIEW.md. A scheduler repair, fresh bars, or passing tests cannot guarantee a qualifying signal, trades, or profit. Read-only access proves connectivity/diagnostics, not fills or broker protection behavior.

GitHub docs confirm timezone-aware cron is supported, so the presence of timezone: America/New_York is not evidence of the failure. They also warn schedules may be delayed/dropped; each hosted job has a six-hour limit. The two-job design removes the per-job horizon issue, not GitHub startup/queue latency. First/second job setup may create a gap, and a failed/uncertain first job must not automatically retry or launch a closing execution.

Sources checked during review:
- Existing repository README and source/workflow at b8dc0ce7.
- October 15 runs 38779028659 and 38802659378; verified logs already retrieved.
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule
- https://docs.github.com/en/actions/reference/limits
- https://docs.github.com/en/billing/concepts/product-billing/github-actions
