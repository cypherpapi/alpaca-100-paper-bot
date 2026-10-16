# Independent freshness review

The existing request uses five-minute aggregates, ascending results, IEX, a six-hour lookback, and end = actual check time minus one minute. The 11-minute limit is a new data-quality rule; no momentum, score, risk, allocation, entry or exit threshold is changed.

Rationale: a bar timestamp marks an interval, not the instant the HTTP response arrived. Five minutes for one aggregate + one minute for the request-end lag + one additional five-minute update allowance = eleven minutes. This is a conservative operational allowance, NOT an Alpaca latency guarantee. It deliberately tolerates one missing update and can permit a ranking to repeat for two checks before blocking. At 10:05 a latest 10:00 bar has age 5 minutes (allowed); at 10:10 the unchanged bar has age 10 (allowed); at 10:15 its age is 15 (blocked). Exactly 660 seconds is allowed; any greater age blocks.

Bar age is measured from latest t to actual check start, never controller.scheduledTime. Each universe/benchmark/held symbol must pass. Missing bars, invalid timestamps, future timestamps, or age above 660 seconds reject entry data. A single illiquid or halted symbol can block the entire entry universe. A delayed feed is not silently accepted. A long HTTP request can make data older by decision time; no new request timeout or second decision-time clock check has been introduced. This remains a limitation for a separately reviewed operational change.

Important: end = now minus one minute does NOT establish that a five-minute aggregate is complete. At 09:42 a 09:40 timestamp can still describe a developing bar and passes this age gate. The new regression test explicitly preserves that behavior. Switching to completed-bars-only would change the data used by the existing strategy and needs a separate strategy review; this draft does not silently do that. Freshness also does not prove continuity of every earlier interval, valid OHLCV, or snapshot freshness. Provider updates/late trades can revise aggregates.

On failure, diagnostic counts/timestamps/reasons remain visible, new entries are blocked, and stale or malformed bars are removed before trend metrics. Account daily-loss exits, position-loss exits, scheduled close and base broker stop protection still use their existing inputs. Bar-derived peak/trend exits and stop raises are suppressed. A stronger resting stop remains unchanged. Mocks verify these cases. Production draft adapters and CLIs cannot place orders at all.

Conclusion: retain 11 minutes as an explicitly reviewable, provisional availability/staleness compromise for initial dry-run diagnostics. It is not a strict latest-completed-bar guarantee, and does not establish the cause of the earlier repeated rankings. Review actual paper IEX publication/printing behavior without changing thresholds before any later trading proposal.

Sources checked 2026-10-16:
- [Historical bars](https://docs.alpaca.markets/us/reference/stockbars): aggregates and pagination ordering.
- [Real-time stock bars](https://docs.alpaca.markets/us/docs/real-time-stock-pricing-data): interval timestamps and late-trade updates.
