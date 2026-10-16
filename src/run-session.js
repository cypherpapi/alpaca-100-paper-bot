import { startupDiagnostic } from "./singleton.js";

// Retired broker entrypoint in this preparation draft. No broker runner is imported.
console.log(JSON.stringify({
  ...startupDiagnostic(process.env, new Date()),
  ready: false, adapter: "legacy-cli-disabled", reason: "use-approved-singleton-executor",
}));
process.exitCode = 1;
