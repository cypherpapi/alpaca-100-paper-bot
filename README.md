# Alpaca $100 Paper Bot

This is a deliberately high-risk **paper-only** trading experiment for the separate Alpaca paper account funded with $100 of simulated cash. It cannot be pointed at Alpaca's live trading host without changing source code.

## Strategy

- Runs every five minutes on weekdays and checks Alpaca's market clock.
- Trades only during regular U.S. market hours.
- Scans liquid leveraged bull/bear ETFs: `TQQQ`, `SQQQ`, `SOXL`, `SOXS`, `TNA`, and `TZA`.
- Buys the strongest qualifying 15-minute/60-minute momentum candidate.
- Uses at most 90% of the paper account and makes at most one new entry per day.
- Adds a 2% protective stop after a fill.
- Exits around a 3% gain, on a momentum reversal, or by 3:50 p.m. Eastern.
- Locks out new entries after a 4% daily account loss.
- Never shorts, uses options, borrows on margin, trades crypto, or holds intentionally overnight.

Leveraged ETFs can move sharply and decay over time. The restrictions above reduce failure modes; they do not make the strategy safe or profitable. Paper fills can also be more favorable than real fills.

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
