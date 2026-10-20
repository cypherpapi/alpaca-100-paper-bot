import { runGatedPaper } from '../src/paper-restart.js';
import { appendFileSync } from 'node:fs';
import { restartFailureDiagnostic } from './paper-restart-diagnostics.mjs';
function writeSummary(title, diagnostic) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      '\n' + title + '\n\n```json\n' + diagnostic + '\n```\n');
  } catch {
    console.error('paper-restart-summary-write-failed');
  }
}
try {
  await runGatedPaper(process.env, {
    allowOrders: process.argv.includes('--paper-orders'),
    log: value => {
      const diagnostic = JSON.stringify(value);
      console.log(diagnostic);
      if (['read-only-preflight', 'read-only-strategy-check'].includes(value.event)) {
        writeSummary('Sanitized read-only readiness evidence:', diagnostic);
      }
      if (['session-started', 'check-complete', 'session-completed', 'session-failed'].includes(value.event)) {
        const { event, timestamp, commit, paperOnly, action, symbol, checks, reason } = value;
        writeSummary('Bounded paper session evidence:', JSON.stringify({
          event, timestamp, commit, paperOnly, action, symbol, checks, reason,
        }));
      }
    },
  });
} catch (error) {
  const diagnostic = JSON.stringify(restartFailureDiagnostic(error));
  console.error(diagnostic);
  writeSummary('Paper restart paused. Sanitized diagnostic:', diagnostic);
  process.exitCode = 1;
}
