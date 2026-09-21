# Alpaca $100 Paper Bot

This is a deliberately high-risk **paper-only** trading experiment for the separate Alpaca paper account funded with $100 of simulated cash. It cannot be pointed at Alpaca's live trading host without changing source code.

## Trend Hunter v3 aggressive strategy

- Runs every five minutes on weekdays and checks Alpaca's market clock.
- Trades only during regular U.S. market hours.
- Scans leveraged bull/bear ETFs: `TQQQ`, `SQQQ`, `SOXL`, `SOXS`, `TNA`, `TZA`, `NVDL`, `NVDD`, `TSLL`, `TSLQ`, `LABU`, and `LABD`.
- Scores every symbol from 0 to 100 using 15-minute and 60-minute returns, EMA 5/13 alignment, VWAP, volume, RSI 14, ATR 14, and breakout or pullback-recovery structure.
- Uses `SPY` and `QQQ` to classify the broad tape as bullish, bearish, or mixed, then gives a small score advantage to leveraged ETFs aligned with that regime.
- Rejects weak trends, low-volume moves, and entries stretched more than 2 ATR above VWAP.
- Refuses to chase a symbol already up at least 8% on the day when it is within 1% of its session high.
- Requires a trend score of at least 52 and logs the complete ranking plus every rejection reason on each paper run.
- Uses at most 99% of the paper account, holds one position at a time, and can make up to 12 entries per day.
- Allows immediate re-entry after an exit when a fresh momentum signal independently qualifies.
- Adds a fixed 3% broker-side protective stop after a fill.
- Once an observed gain reaches 0.75%, raises the resting Alpaca paper stop to protect approximately +0.25%. Once the gain reaches 1.5%, it raises that stop again to trail the peak by 0.5 percentage points. Software exits provide the same protection when price has already crossed the intended level.
- After a 10-minute minimum hold, exits a flat or losing position whose trend no longer qualifies.
- After the minimum hold, rotates out when a different qualified symbol leads the held symbol by at least 15 score points. The next scheduled run must independently requalify the new leader before entry.
- Takes a hard profit at 4% rather than waiting for the former 12% moonshot target.
- Still exits on a confirmed momentum reversal or by 3:50 p.m. Eastern.
- Locks out new entries after a 12% daily account loss.
- Refuses a new entry when its planned stop could push the account beyond the daily loss limit.
- Logs fill prices, realized trade results, equity, cash, and daily paper P/L for easier reporting.
- Never shorts, uses options, borrows on margin, trades crypto, or holds intentionally overnight.

Leveraged ETFs can move sharply and decay over time. The restrictions above reduce failure modes; they do not make the strategy safe or profitable. Paper fills can also be more favorable than real fills.

The aggressive profile is capped at 12 entries rather than trading continuously. Additional trades only occur after a completed exit and a new qualifying signal. The wider 9:35 a.m.–3:15 p.m. entry window, lower qualification thresholds, zero cooldown, and faster rotation increase opportunity while the projected-risk check still blocks a new entry that could exceed the daily paper-loss limit.

The strategy now promotes the actual resting paper stop as observed profits increase, reducing dependence on the next workflow run. Alpaca's free stock-data plan uses the IEX feed rather than the full consolidated market, and GitHub notes that scheduled workflows can be delayed during periods of high load. Those constraints make this suitable for a paper experiment, not execution-quality evidence for live funds.

## Required secrets

Enter these directly into the hosting provider's encrypted secret controls. Never paste them into chat or commit them to a file:

- `ALPACA_API_KEY_ID`
- `ALPACA_API_SECRET_KEY`

Both must belong to the `$100` Alpaca paper account.

## Safe activation sequence

1. Deploy with `TRADING_ENABLED=false`.
2. Confirm `/health` reports `paperOnly: true` and `mode: paper-dry-run`.
3. Inspect at least one scheduled dry run for successful account and market-data access.
4. Change only `TRADING_ENABLED` to `true` to permit simulated orders.
5. Keep the account in paper mode for at least 10 market sessions before evaluating live trading.

## Local verification

```bash
npm test
npm run check
```

## Free scheduled hosting with GitHub Actions

The included `.github/workflows/paper-bot.yml` runs the bot every five minutes on weekdays using the `America/New_York` timezone. Alpaca's market clock still blocks runs whenever the market is closed.

Use a public repository so standard GitHub-hosted runners remain free. The source code can be public because it contains no credentials. Store the credentials only as these GitHub Actions repository secrets:

- `ALPACA_API_KEY_ID`
- `ALPACA_API_SECRET_KEY`

Create two repository variables:

- `BOT_ACTIVE` = `true` after both secrets have been entered. Until then, scheduled jobs are skipped.
- `TRADING_ENABLED` = `false` for the first dry run. Change it to `true` only after a successful dry run confirms the `$100` paper account.

The workflow can also be started manually from the Actions tab. It has read-only repository permissions, a three-minute timeout, and concurrency protection so two bot runs cannot overlap.

## Optional Cloudflare hosting

The included `wrangler.jsonc` remains as an optional alternative. It is not required for the free GitHub Actions setup.

Cloudflare should store the two Alpaca values as encrypted secrets. The remaining values in `wrangler.jsonc` are intentionally non-secret and can be adjusted without changing the live/paper boundary.
