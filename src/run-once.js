import { runReadOnlyCheck } from "./runner.js";
try {
  console.log(JSON.stringify(await runReadOnlyCheck(process.env)));
} catch {
  console.error(JSON.stringify({ event: "check-failed", paperOnly: true }));
  process.exitCode = 1;
}
