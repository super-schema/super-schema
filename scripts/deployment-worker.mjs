import "dotenv/config";
import { setTimeout } from "node:timers/promises";

const token = process.env.DEPLOYMENT_WORKER_TOKEN;
const endpoint = process.env.DEPLOYMENT_WORKER_URL ?? "http://127.0.0.1:3000/api/deployments/process";
if (!token) throw new Error("Set DEPLOYMENT_WORKER_TOKEN in both the application and the worker");
const url = new URL(endpoint);
if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw new Error("Worker endpoint must use HTTPS or loopback HTTP");
let stop = false;
process.on("SIGINT", () => { stop = true; });
process.on("SIGTERM", () => { stop = true; });
do {
  try {
    const response = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15 * 60 * 1000) });
    if (!response.ok) throw new Error(`Worker endpoint returned HTTP ${response.status}`);
    const result = await response.json();
    if (result.processed) console.log(`Processed ${result.processed} deployment run(s)`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Worker request failed");
    if (process.argv.includes("--once")) process.exitCode = 1;
  }
  if (process.argv.includes("--once") || stop) break;
  await setTimeout(5000);
} while (!stop);
