import { runGatedPaper } from '../src/paper-restart.js';
import { appendFileSync } from 'node:fs';
import { restartFailureDiagnostic } from './paper-restart-diagnostics.mjs';
try {
  await runGatedPaper(process.env, { allowOrders: process.argv.includes('--paper-orders') });
} catch (error) {
  const diagnostic = JSON.stringify(restartFailureDiagnostic(error));
  console.error(diagnostic);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        '\nPaper restart paused. Sanitized diagnostic:\n\n```json\n' + diagnostic + '\n```\n');
    } catch {
      console.error('paper-restart-summary-write-failed');
    }
  }
  process.exitCode = 1;
}
