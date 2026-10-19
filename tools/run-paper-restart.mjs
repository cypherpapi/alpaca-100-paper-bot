import { runGatedPaper } from '../src/paper-restart.js';
const approvedReasons = new Set(['paper-orders-not-approved', 'outside-entry-window',
  'account-or-market-not-ready', 'invalid-market-clock', 'entry-data-not-fresh',
  'dry-run-check-not-ready', 'invalid-session-duration', 'paper-transport-refused']);
try {
  await runGatedPaper(process.env, { allowOrders: process.argv.includes('--paper-orders') });
} catch (error) {
  console.error(JSON.stringify({ event: 'paper-restart-paused', paperOnly: true,
    reason: approvedReasons.has(error.message) ? error.message : 'validation-or-session-failed' }));
  process.exitCode = 1;
}
