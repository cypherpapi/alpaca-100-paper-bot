import { appendFileSync } from 'node:fs';
import { runOngoingPaper } from '../src/ongoing-paper.js';
try {
  await runOngoingPaper(process.env, { phase: process.argv[2], log: value => {
    console.log(JSON.stringify(value));
    if (process.env.GITHUB_STEP_SUMMARY && ['ongoing-paper-preflight', 'ongoing-paper-skipped',
      'session-started', 'check-complete', 'session-completed', 'session-failed'].includes(value.event)) {
      const { event, timestamp, commit, paperOnly, phase, action, symbol, checks, reason } = value;
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, '\nOngoing paper evidence:\n\n```json\n' +
        JSON.stringify({ event, timestamp, commit, paperOnly, phase, action, symbol, checks, reason }) + '\n```\n');
    }
  } });
} catch {
  console.error(JSON.stringify({ event: 'ongoing-paper-failed', paperOnly: true }));
  process.exitCode = 1;
}
