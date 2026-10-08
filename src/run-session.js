import { runSession } from "./session.js";

try {
  await runSession(process.env);
} catch (error) {
  // Stop this session on uncertainty; never immediately retry an order request.
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), error: error.message, paperOnly: true }));
  process.exitCode = 1;
}
