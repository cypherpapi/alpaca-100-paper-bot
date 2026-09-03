import { runBot } from "./index.js";

try {
  const result = await runBot(process.env, new Date());
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ error: error.message, paperOnly: true }));
  process.exitCode = 1;
}
