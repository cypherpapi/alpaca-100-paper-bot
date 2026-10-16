import { runReadOnlySession } from "./runner.js";
try {
  await runReadOnlySession(process.env);
} catch {
  console.error(JSON.stringify({ event: "session-failed", paperOnly: true }));
  process.exitCode = 1;
}
