import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { GitHubClient } from "./github";
import { DeliveryError, type ArtifactFile, type PreparedPlan } from "./contracts";
import { validateFiles } from "./artifact";

function runPreparation(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, detached: process.platform !== "win32", stdio: "ignore" });
    let finished = false;
    const timer = setTimeout(() => finish(new Error("Contract preparation timed out")), 10 * 60 * 1000);
    function finish(error?: Error) {
      if (finished) return;
      finished = true; clearTimeout(timer);
      // Bound Make/Python grandchildren too, including on timeout or parent failure.
      if (child.pid && process.platform !== "win32") { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } }
      else child.kill("SIGKILL");
      if (error) reject(error); else resolve();
    }
    child.once("error", finish);
    child.once("close", (code) => finish(code === 0 ? undefined : new Error("Contract preparation failed")));
  });
}

/** Repository-owned code is only run for destinations an operator explicitly trusts. */
export async function prepareEventContract(client: GitHubClient, plan: PreparedPlan): Promise<{ files: ArtifactFile[]; validation: string[] }> {
  const repo = `${client.repository.host}/${client.repository.owner}/${client.repository.repo}`.toLowerCase();
  if (!(process.env.DEPLOYMENT_EVENT_REPOSITORIES ?? "").split(",").map((r) => r.trim().toLowerCase().replace(/\.git$/, "")).includes(repo)) throw new DeliveryError("An operator must approve this contract repository in DEPLOYMENT_EVENT_REPOSITORIES before its validators can run");
  const toolkit = process.env.DEPLOYMENT_EVENT_TOOLKIT;
  if (!toolkit || !path.isAbsolute(toolkit)) throw new DeliveryError("Configure DEPLOYMENT_EVENT_TOOLKIT with an installed Event Schema Central toolchain");
  const directory = await mkdtemp(path.join(tmpdir(), "superschema-contract-"));
  try {
    const files = await client.readFiles(plan.baseSha!, (p) => !p.startsWith(".github/") && !/\.(png|jpe?g|gif|woff2?|pdf|zip)$/i.test(p));
    let bytes = 0;
    for (const f of files) {
      bytes += Buffer.byteLength(f.content);
      if (bytes > 50 * 1024 * 1024) throw new DeliveryError("Contract repository exceeds the preparation size limit");
      const dest = path.join(directory, f.path);
      await mkdir(path.dirname(dest), { recursive: true }); await writeFile(dest, f.content);
    }
    // Dependencies come from an operator-installed toolchain, never from shell supplied by a workflow.
    await symlink(path.join(toolkit, ".venv"), path.join(directory, ".venv"), "dir");
    await symlink(path.join(toolkit, "node_modules"), path.join(directory, "node_modules"), "dir");
    await mkdir(path.join(directory, "tools"), { recursive: true });
    await symlink(path.join(toolkit, "tools/node_modules"), path.join(directory, "tools/node_modules"), "dir");
    const input = path.join(directory, ".superschema-input.json");
    await writeFile(input, JSON.stringify({ bundle: plan.bundle, settings: plan.settings, baseBranch: plan.connectionConfig.baseBranch }));
    const output = path.join(directory, ".superschema-output.json");
    const env: NodeJS.ProcessEnv = { NODE_ENV: "production", PATH: process.env.PATH, LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1", HOME: directory, DEPLOYMENT_INPUT: input, DEPLOYMENT_OUTPUT: output };
    try {
      await runPreparation(path.join(toolkit, ".venv/bin/python"), [path.join(process.cwd(), "scripts/prepare-event-contract.py"), "--root", directory], directory, env);
    } catch {
      let detail = "Repository preparation or validation failed";
      try { const report = JSON.parse(await readFile(output, "utf8")); detail = String(report.error || detail).slice(0, 2000); } catch { /* No credentials or raw child output are exposed. */ }
      throw new DeliveryError(detail);
    }
    const report = JSON.parse(await readFile(output, "utf8")) as { files: ArtifactFile[]; validation: string[] };
    validateFiles(report.files);
    return report;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
