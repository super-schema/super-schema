import { createHmac } from "node:crypto";
import { requestExternal, WebhookTargetError } from "@/lib/webhook-transport";
import { gitArtifactRoot, gitManifestPath, hierarchyFiles, validateFiles } from "./artifact";
import { branchDate, deliveryBranchName } from "./git-branch";
import { DeliveryError, type ArtifactBundle, type ConnectionConfig, type Credentials, type DeploymentMethod, type PreparedPlan, type WorkflowSettings } from "./contracts";
import { authHeaders, retryDelay } from "./http";
import { GitHubClient } from "./github";
import { RegistryClient } from "./registry";
import { prepareEventContract } from "./event-contract";

import { generatedGitPrTitle } from "./pr-title";

export async function prepareDelivery(input: { id: string; method: DeploymentMethod; bundle: ArtifactBundle; config: ConnectionConfig; settings: WorkflowSettings; revision: number; environment: string }, credentials: Credentials): Promise<PreparedPlan> {
  const plan: PreparedPlan = { bundle: input.bundle, connectionConfig: input.config, settings: input.settings, workflowRevision: input.revision, environment: input.environment, validation: ["Published artifact and complete file manifest verified"] };
  if (input.method === "git") {
    plan.settings = { ...plan.settings, title: plan.settings.title.trim() || generatedGitPrTitle({ schema: input.bundle.entity.schema, format: input.bundle.format, version: input.bundle.version, environment: input.environment, contractVersion: plan.settings.contractVersion }) };
    const client = new GitHubClient(input.config.url, credentials);
    await client.verify();
    plan.baseSha = await client.base(input.config.baseBranch);
    plan.branch = await availableBranch(client, { schema: input.bundle.entity.schema, contractVersion: plan.settings.contractVersion, date: branchDate() });
    const existing = await client.tree(plan.baseSha);
    if (input.settings.eventContract) {
      if (input.config.gitRoot) throw new DeliveryError("The Event Schema Central adapter requires its own repository root; use a generic Git workflow for a scoped GitOps folder");
      const prepared = await prepareEventContract(client, plan);
      plan.files = prepared.files; plan.validation.push(...prepared.validation);
    } else {
      plan.files = hierarchyFiles(input.bundle, input.settings.contractVersion, input.config.gitRoot);
      const root = gitArtifactRoot(input.bundle.entity, input.settings.contractVersion, input.config.gitRoot);
      // A destination version is immutable per target format: once this format's manifest exists there,
      // only an identical file set may be re-delivered. Other formats may share the version directory.
      const ownPaths = new Set(plan.files.map((f) => f.path));
      const manifest = gitManifestPath(root, input.bundle.format);
      if (existing.some((f) => f.path === manifest)) {
        const current = await client.readFiles(plan.baseSha, (p) => ownPaths.has(p));
        if (current.length !== plan.files.length || current.some((f) => !plan.files!.some((planned) => planned.path === f.path && planned.content === f.content))) throw new DeliveryError("This destination version already contains different artifacts; choose a new contract version");
      } else if (existing.some((f) => f.type === "blob" && ownPaths.has(f.path))) {
        // No manifest for this format, yet a planned file exists: e.g. bigquery and postgresql both write `<schema>.sql`.
        const current = await client.readFiles(plan.baseSha, (p) => ownPaths.has(p));
        if (current.some((f) => plan.files!.find((planned) => planned.path === f.path)?.content !== f.content)) throw new DeliveryError(`Another target already wrote a different file at ${root}; choose a new contract version`);
      }
      plan.validation.push("Domain/product/schema/version layout validated under the repository root");
    }
    validateFiles(plan.files);
    const lower = new Map(existing.map((f) => [f.path.toLowerCase(), f]));
    for (const f of plan.files) {
      const old = lower.get(f.path.toLowerCase());
      if (old && (old.path !== f.path || old.type !== "blob" || old.mode !== "100644")) throw new DeliveryError("A planned path collides with an existing repository entry");
      const parts = f.path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join("/");
        const entry = lower.get(parent.toLowerCase());
        if (entry && (entry.path !== parent || entry.type !== "tree")) throw new DeliveryError("A planned directory collides with an existing repository entry");
      }
    }
    const plannedPaths = new Set(plan.files.map((file) => file.path));
    const existingPaths = new Set(existing.filter((file) => file.type === "blob" && plannedPaths.has(file.path)).map((file) => file.path));
    const baseline = existingPaths.size ? await client.readFiles(plan.baseSha, (path) => existingPaths.has(path)) : [];
    plan.fileChanges = plan.files.map((file) => {
      const before = baseline.find((old) => old.path === file.path)?.content;
      return { path: file.path, status: before === undefined ? "added" : before === file.content ? "unchanged" : "modified", ...(before === undefined ? {} : { before }) };
    });
    plan.validation.push("Remote base commit pinned; no repository writes performed during preview");
  } else if (input.method === "registry") plan.validation.push(...await new RegistryClient(input.config.url, credentials).preview(input.bundle, input.settings));
  else {
    const url = new URL(input.config.url);
    if (url.username || url.password || url.hash || (url.protocol !== "https:" && process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS !== "true")) throw new DeliveryError("Use an HTTPS API endpoint without URL credentials");
    authHeaders(credentials);
    plan.validation.push("JSON deployment envelope prepared; the endpoint owns downstream processing");
  }
  return plan;
}

export async function deliverPrepared(id: string, method: DeploymentMethod, plan: PreparedPlan, credentials: Credentials, idempotencyKey: string) {
  if (method === "git") {
    if (!plan.baseSha || !plan.branch || !plan.files) throw new DeliveryError("The Git preview is incomplete");
    if (plan.fileChanges?.every((file) => file.status === "unchanged")) throw new DeliveryError("The preview contains no file changes");
    return new GitHubClient(plan.connectionConfig.url, credentials).deliver({ baseBranch: plan.connectionConfig.baseBranch, baseSha: plan.baseSha, branch: plan.branch, files: plan.files,
      title: plan.settings.title || generatedGitPrTitle({ schema: plan.bundle.entity.schema, format: plan.bundle.format, version: plan.bundle.version, environment: plan.environment, contractVersion: plan.settings.contractVersion }),
      body: `Schema artifact ${plan.bundle.format} v${plan.bundle.version}\n\nContract version: ${plan.settings.contractVersion}\n\nContent hash: ${plan.bundle.contentHash}\n\nEnvironment: ${plan.environment}\n\nValidation:\n${plan.validation.map((v) => `- ${v}`).join("\n")}\n\nSuper Schema run: ${id}`,
      marker: `SuperSchema-Delivery: ${id} ${plan.bundle.contentHash}` });
  }
  if (method === "registry") return new RegistryClient(plan.connectionConfig.url, credentials).deliver(plan.bundle, plan.settings);
  const body = JSON.stringify({ payloadVersion: "1", event: "schema.deployment.requested", runId: id, idempotencyKey, entity: plan.bundle.entity, environment: plan.environment,
    artifact: { format: plan.bundle.format, version: plan.bundle.version, sourceEntityVersion: plan.bundle.sourceEntityVersion, contentHash: plan.bundle.contentHash, primaryFile: plan.bundle.primaryFile, files: plan.bundle.files.map(({ path, content }) => ({ path, content })) } });
  const headers: Record<string, string> = { ...authHeaders(credentials), "Content-Type": "application/json", "Idempotency-Key": idempotencyKey };
  if (credentials.signingSecret) headers["X-Webhook-Signature"] = `sha256=${createHmac("sha256", credentials.signingSecret).update(body).digest("hex")}`;
  let response: Awaited<ReturnType<typeof requestExternal>>;
  try { response = await requestExternal(plan.connectionConfig.url, { method: "POST", headers, body }); }
  catch (e) { if (e instanceof WebhookTargetError) throw new DeliveryError(e.message); throw new DeliveryError("API response interrupted; delivery may have been accepted", plan.connectionConfig.supportsIdempotency, true); }
  if (response.status < 200 || response.status >= 300) {
    throw new DeliveryError(`API endpoint returned HTTP ${response.status}`, response.status === 429 || response.status >= 500, response.status >= 500,
      retryDelay(response.headers));
  }
  // Do not retain arbitrary response bodies, which may echo credentials or sensitive content.
  return { outcome: response.status === 202 ? "accepted" as const : "delivered" as const, httpStatus: response.status };
}

/** First unused `<schema>-<version>-<date>[-n]` branch, so a second delivery the same day never reuses another run's branch. */
async function availableBranch(client: GitHubClient, input: { schema: string; contractVersion: string; date: string }): Promise<string> {
  for (let attempt = 1; attempt <= 50; attempt++) {
    const name = deliveryBranchName({ ...input, attempt });
    if (!await client.branchExists(name)) return name;
  }
  throw new DeliveryError("Too many delivery branches for this schema version today; merge or delete older ones");
}
