import { config } from "dotenv";
import {
  initializeGitOpsEnvironment,
  getGitOpsWorkerSettings,
} from "../src/lib/gitops/config.mjs";
config({ path: ".env.local", quiet: true });
config({ quiet: true });
initializeGitOpsEnvironment();
const settings = getGitOpsWorkerSettings();
const token = process.env.GITOPS_WORKER_TOKEN,
  url = new URL(
    process.env.GITOPS_WORKER_URL ?? "http://localhost:3000/api/gitops/process",
  );
if (!token || token.length < 32)
  throw new Error(
    "Set GITOPS_WORKER_TOKEN to a server-only secret of at least 32 characters",
  );
if (
  url.pathname !== "/api/gitops/process" ||
  url.username ||
  url.password ||
  url.search ||
  url.hash ||
  (url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    ))
)
  throw new Error(
    "Use the exact GitOps worker endpoint; remote URLs require HTTPS",
  );
let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});
do {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(310000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    console.log(
      `GitOps worker processed ${Number(result.processed) || 0} jobs`,
    );
  } catch (e) {
    console.error(
      `GitOps worker: ${e instanceof Error ? e.message : "request failed"}`,
    );
    if (process.argv.includes("--once")) process.exitCode = 1;
  }
  if (process.argv.includes("--once") || stopping) break;
  await new Promise((resolve) => setTimeout(resolve, settings.intervalMs));
} while (!stopping);
