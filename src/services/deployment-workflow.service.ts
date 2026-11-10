import { randomUUID } from "node:crypto";
import { Prisma, type DeploymentConnection } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { withAudit } from "@/lib/audit";
import { ctxCan } from "@/lib/access/context";
import { can } from "@/lib/access";
import { ROLE_ROW_SELECT, assignmentsFromRows } from "@/lib/access/assignments";
import { openSecret, sealSecret } from "@/lib/crypto/secret-box";
import { freezeArtifact, digest } from "@/lib/deployments/artifact";
import { prepareDelivery, deliverPrepared } from "@/lib/deployments/adapters";
import { authHeaders } from "@/lib/deployments/http";
import { GitHubClient, parseRepository } from "@/lib/deployments/github";
import { RegistryClient } from "@/lib/deployments/registry";
import { privateTargetsAllowed, requestExternal } from "@/lib/webhook-transport";
import {
  ConnectionConfigSchema, CredentialsSchema, DeliveryError, ExecuteSchema, PreviewSchema, SaveConnectionSchema, SaveWorkflowSchema, WorkflowSettingsSchema,
  type ArtifactBundle, type ConnectionView, type Credentials, type DeploymentMethod, type DeploymentWorkspace, type DeliveryReceipt, type PreparedPlan, type RunView,
} from "@/lib/deployments/contracts";
import type { ServiceContext } from "@/types/service-context";
import type { SchemaVersionsMap } from "@/types/schema-version";

const secretField = "DeploymentConnection.credentials" as const;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const asError = (message: string): never => { throw new DeliveryError(message); };
const methodOf = (row: { method: string }) => row.method as DeploymentMethod;
const CONNECTION_VIEW_SELECT = { id: true, name: true, method: true, config: true, revision: true, active: true } as const;
const RUN_VIEW_SELECT = { id: true, workflowId: true, method: true, format: true, artifactVersion: true, environment: true, status: true, createdAt: true, attemptCount: true, error: true, receipt: true, planHash: true, expiresAt: true } as const;
type RunSummary = Prisma.DeploymentRunGetPayload<{ select: typeof RUN_VIEW_SELECT }>;
export const connectionView = (row: Pick<DeploymentConnection, keyof typeof CONNECTION_VIEW_SELECT>): ConnectionView => ({ id: row.id, name: row.name, method: methodOf(row), config: ConnectionConfigSchema.parse(row.config), revision: row.revision, active: row.active });
const credentialsOf = (row: DeploymentConnection): Credentials => CredentialsSchema.parse(JSON.parse(openSecret(row.credentials, secretField)));
export const runView = (row: RunSummary): RunView => ({ id: row.id, workflowId: row.workflowId, method: methodOf(row), format: row.format, artifactVersion: row.artifactVersion, environment: row.environment, status: row.status, createdAt: row.createdAt.toISOString(), attemptCount: row.attemptCount, error: row.error, receipt: row.receipt as unknown as DeliveryReceipt | null, planHash: row.planHash, expiresAt: row.expiresAt.toISOString() });

async function entityFor(entityId: string, ctx: ServiceContext, action: "deploy.read" | "deploy.run" | "deploy.configure") {
  const entity = await prisma.entity.findUnique({ where: { id: entityId }, include: { tenant: true, domain: true, product: true } });
  if (!entity || !ctxCan(ctx, action, { tenantId: entity.tenantId, domainId: entity.domainId, productId: entity.productId })) return asError("Entity not found or deployment access denied");
  return entity;
}

async function readableBundle(bundle: ArtifactBundle, ctx: Pick<ServiceContext, "assignments">, tenantId: string): Promise<void> {
  const refs = bundle.referenceEntityIds;
  if (!refs.length) return;
  const rows = await prisma.entity.findMany({ where: { id: { in: refs } }, select: { id: true, tenantId: true, domainId: true, productId: true } });
  for (const id of refs) {
    const row = rows.find((r) => r.id === id);
    if (!can([...(ctx.assignments ?? [])], "entity.read", row ?? { tenantId })) asError("Deployment requires access to every referenced artifact");
  }
}

function destination(config: unknown, method: DeploymentMethod) {
  const parsed = ConnectionConfigSchema.parse(config);
  if (method === "git") parseRepository(parsed.url);
  else {
    const url = new URL(parsed.url);
    if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(privateTargetsAllowed() && url.protocol === "http:"))) asError("Use an HTTPS destination without URL credentials");
  }
  return parsed;
}

export async function getDeploymentWorkspace(entityId: string, ctx: ServiceContext): Promise<DeploymentWorkspace> {
  const entity = await entityFor(entityId, ctx, "deploy.read");
  const [connections, workflows, runs] = await Promise.all([
    prisma.deploymentConnection.findMany({ where: { tenantId: entity.tenantId }, select: CONNECTION_VIEW_SELECT, orderBy: { name: "asc" } }),
    prisma.deploymentWorkflow.findMany({ where: { tenantId: entity.tenantId, entityId }, orderBy: { name: "asc" } }),
    prisma.deploymentRun.findMany({ where: { tenantId: entity.tenantId, entityId }, select: RUN_VIEW_SELECT, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  const versions = ((entity.metadata as Record<string, unknown> | null)?.schemaVersions ?? {}) as SchemaVersionsMap;
  const legacyGit = ctxCan(ctx, "git.manage") ? (await prisma.gitConfig.findMany({ select: { id: true } })).map((c, i) => ({ id: c.id, name: `Legacy Git configuration ${i + 1}` })) : [];
  const legacyMarkers = Object.entries(versions).flatMap(([format, entries]) => entries.filter((v) => v.status === "deployed").map((v) => ({ format, version: v.version, deployedAt: v.deployedAt })));
  return { legacyGit, legacyMarkers, connections: connections.map(connectionView), workflows: workflows.map((w) => ({ id: w.id, name: w.name, format: w.format, environment: w.environment, connectionId: w.connectionId, settings: WorkflowSettingsSchema.parse(w.settings), revision: w.revision, active: w.active })), runs: runs.map(runView),
    formats: Object.entries(versions).map(([key, entries]) => ({ key, versions: entries.filter((v) => v.status === "published" || v.status === "deployed").map((v) => v.version).sort((a, b) => b - a) })).filter((f) => f.versions.length),
    canConfigure: ctxCan(ctx, "deploy.configure", { tenantId: entity.tenantId }), canRun: ctxCan(ctx, "deploy.run", { tenantId: entity.tenantId, domainId: entity.domainId, productId: entity.productId }) };
}

export async function importLegacyGitConnection(entityId: string, id: string, ctx: ServiceContext): Promise<ConnectionView> {
  await entityFor(entityId, ctx, "deploy.configure");
  if (!ctxCan(ctx, "git.manage")) return asError("Only a platform administrator may migrate unscoped legacy Git credentials");
  const config = await prisma.gitConfig.findUnique({ where: { id } });
  if (!config) return asError("Legacy Git configuration not found");
  const value = openSecret(config.authCredential, "GitConfig.authCredential");
  let credentials: Credentials;
  if (config.authMethod === "PERSONAL_ACCESS_TOKEN") credentials = CredentialsSchema.parse({ authType: "bearer", token: value });
  else if (config.authMethod === "GITHUB_APP") {
    try { credentials = CredentialsSchema.parse({ ...JSON.parse(value), authType: "github-app" }); }
    catch { return asError("Configure the GitHub App installation and private key in a new connection"); }
  } else return asError("SSH credentials cannot open GitHub PRs; configure a GitHub token or App connection");
  const repository = parseRepository(config.repositoryUrl);
  return saveDeploymentConnection(entityId, { name: `${repository.owner}/${repository.repo}`.slice(0, 100), method: "git", config: { url: repository.web, baseBranch: config.branch, supportsIdempotency: false }, credentials }, ctx);
}

export async function saveDeploymentConnection(entityId: string, raw: unknown, ctx: ServiceContext): Promise<ConnectionView> {
  const entity = await entityFor(entityId, ctx, "deploy.configure");
  const input = SaveConnectionSchema.parse(raw);
  const config = destination(input.config, input.method);
  const old = input.id ? await prisma.deploymentConnection.findFirst({ where: { id: input.id, tenantId: entity.tenantId } }) : null;
  if (input.id && !old) asError("Connection not found");
  if (old && old.method !== input.method) asError("Create a separate connection to change its deployment method");
  const credentials = input.credentials ?? (old ? credentialsOf(old) : asError("Connection credentials are required"));
  if (input.method === "git" && !["bearer", "github-app"].includes(credentials.authType)) asError("GitHub requires a token or GitHub App credentials");
  if (input.method !== "git") authHeaders(credentials);
  const data = { name: input.name, method: input.method, config: json(config), credentials: sealSecret(JSON.stringify(credentials), secretField), active: input.active };
  return withAudit({ action: old ? "UPDATE" : "CREATE", entityType: "DeploymentConnection", entityId: old?.id ?? "pending", tenantId: entity.tenantId, userId: ctx.userId,
    beforeState: old ? connectionView(old) : undefined, fn: async () => {
      const row = old ? await prisma.deploymentConnection.update({ where: { id: old.id }, data: { ...data, revision: { increment: 1 } } })
        : await prisma.deploymentConnection.create({ data: { ...data, tenantId: entity.tenantId, createdBy: ctx.userId } });
      return connectionView(row);
    } });
}

export async function verifyDeploymentConnection(entityId: string, id: string, ctx: ServiceContext): Promise<string> {
  const entity = await entityFor(entityId, ctx, "deploy.configure");
  const connection = await prisma.deploymentConnection.findFirst({ where: { id, tenantId: entity.tenantId, active: true } });
  if (!connection) return asError("Connection not found");
  const config = destination(connection.config, methodOf(connection)), credentials = credentialsOf(connection);
  if (connection.method === "git") { await new GitHubClient(config.url, credentials).verify(); return "GitHub repository access verified"; }
  if (connection.method === "registry") { await new RegistryClient(config.url, credentials).verify(); return "Schema Registry access verified"; }
  const response = await requestExternal(config.url, { method: "GET", headers: authHeaders(credentials) });
  if (response.status >= 400 && response.status !== 405) asError(`Endpoint verification returned HTTP ${response.status}`);
  if (response.status >= 300 && response.status < 400) asError("Endpoint redirects are not followed");
  return "API endpoint reachable; JSON POST acceptance is verified when delivering a schema";
}

export async function saveDeploymentWorkflow(entityId: string, raw: unknown, ctx: ServiceContext) {
  const entity = await entityFor(entityId, ctx, "deploy.run");
  const input = SaveWorkflowSchema.parse(raw);
  const connection = await prisma.deploymentConnection.findFirst({ where: { id: input.connectionId, tenantId: entity.tenantId, active: true } });
  if (!connection) asError("Connection not found");
  if (input.id && !await prisma.deploymentWorkflow.findFirst({ where: { id: input.id, tenantId: entity.tenantId, entityId } })) asError("Workflow not found");
  const data = { name: input.name, connectionId: input.connectionId, format: input.format, environment: input.environment, settings: json(input.settings), active: input.active };
  return withAudit({ action: input.id ? "UPDATE" : "CREATE", entityType: "DeploymentWorkflow", entityId: input.id ?? "pending", tenantId: entity.tenantId, userId: ctx.userId, fn: async () => {
    const row = input.id ? await prisma.deploymentWorkflow.update({ where: { id: input.id }, data: { ...data, revision: { increment: 1 } } })
      : await prisma.deploymentWorkflow.create({ data: { ...data, tenantId: entity.tenantId, entityId, createdBy: ctx.userId } });
    return { id: row.id, name: row.name, entityId, connectionId: row.connectionId, format: row.format, environment: row.environment, revision: row.revision };
  } });
}

export async function previewDeployment(entityId: string, raw: unknown, ctx: ServiceContext): Promise<{ run: RunView; plan: PreparedPlan }> {
  const entity = await entityFor(entityId, ctx, "deploy.run");
  const input = PreviewSchema.parse(raw);
  const old = await prisma.deploymentRun.findUnique({ where: { tenantId_idempotencyKey: { tenantId: entity.tenantId, idempotencyKey: input.idempotencyKey } } });
  if (old) {
    if (old.entityId !== entityId || old.workflowId !== input.workflowId || old.artifactVersion !== input.version || old.createdBy !== ctx.userId) asError("This delivery intent belongs to another request");
    const plan = old.snapshot as unknown as PreparedPlan;
    await readableBundle(plan.bundle, ctx, entity.tenantId);
    return { run: runView(old), plan };
  }
  const workflow = await prisma.deploymentWorkflow.findFirst({ where: { id: input.workflowId, entityId, tenantId: entity.tenantId, active: true }, include: { connection: true } });
  if (!workflow || !workflow.connection.active || workflow.connection.tenantId !== entity.tenantId) return asError("Workflow or connection not found");
  if (!entity.domain || !entity.product) return asError("Git deployment uses a tenant/domain/product/schema hierarchy; assign this entity to a product first");
  const versions = (entity.metadata as Record<string, unknown> | null)?.schemaVersions as SchemaVersionsMap | undefined;
  const version = versions?.[workflow.format]?.find((v) => v.version === input.version);
  if (!version) return asError("The selected schema version was not found");
  let bundle: ArtifactBundle;
  try { bundle = freezeArtifact({ id: entity.id, name: entity.name, tenant: entity.tenant.slug, domain: entity.domain.slug, product: entity.product.slug, schema: entity.slug }, workflow.format, version); }
  catch (error) { return asError(error instanceof Error ? error.message : "Invalid artifact"); }
  await readableBundle(bundle, ctx, entity.tenantId);
  const id = randomUUID(), connection = workflow.connection;
  const plan = await prepareDelivery({ id, method: methodOf(connection), bundle, config: destination(connection.config, methodOf(connection)), settings: WorkflowSettingsSchema.parse(workflow.settings), revision: workflow.revision, environment: workflow.environment }, credentialsOf(connection));
  const row = await prisma.deploymentRun.create({ data: { id, tenantId: entity.tenantId, entityId, workflowId: workflow.id, connectionId: connection.id, connectionRevision: connection.revision, method: connection.method, format: workflow.format, artifactVersion: version.version, environment: workflow.environment, snapshot: json(plan), planHash: digest(plan), idempotencyKey: input.idempotencyKey, createdBy: ctx.userId, expiresAt: new Date(Date.now() + 30 * 60 * 1000) } });
  return { run: runView(row), plan };
}

export async function queueDeployment(entityId: string, raw: unknown, ctx: ServiceContext): Promise<RunView> {
  const entity = await entityFor(entityId, ctx, "deploy.run");
  const input = ExecuteSchema.parse(raw);
  const run = await prisma.deploymentRun.findFirst({ where: { id: input.runId, entityId, tenantId: entity.tenantId, createdBy: ctx.userId }, include: { workflow: true, connection: true } });
  if (!run || run.planHash !== input.planHash || digest(run.snapshot) !== run.planHash) return asError("Validated preview not found");
  await readableBundle((run.snapshot as unknown as PreparedPlan).bundle, ctx, entity.tenantId);
  if (!run.workflow.active || !run.connection.active || run.workflow.revision !== (run.snapshot as unknown as PreparedPlan).workflowRevision || run.connection.revision !== run.connectionRevision) asError("Workflow or connection changed; create a new preview");
  if (run.status === "PREVIEWED" && run.expiresAt < new Date()) asError("This preview expired; create a new validated preview");
  // A repeated execute is a read, never a second external side effect.
  if (run.status === "PREVIEWED") await prisma.deploymentRun.updateMany({ where: { id: run.id, status: "PREVIEWED" }, data: { status: "QUEUED", nextAttemptAt: new Date() } });
  else if (run.status === "UNKNOWN" && run.method !== "http") await prisma.deploymentRun.updateMany({ where: { id: run.id, status: "UNKNOWN" }, data: { status: "QUEUED", nextAttemptAt: new Date() } });
  return runView((await prisma.deploymentRun.findUnique({ where: { id: run.id } }))!);
}

export async function refreshDeploymentReceipt(entityId: string, id: string, ctx: ServiceContext): Promise<RunView> {
  const entity = await entityFor(entityId, ctx, "deploy.read");
  const run = await prisma.deploymentRun.findFirst({ where: { id, entityId, tenantId: entity.tenantId }, include: { connection: true } });
  if (!run) return asError("Run not found");
  const receipt = run.receipt as unknown as DeliveryReceipt | null;
  if (run.method === "git" && receipt?.prNumber) {
    if (!run.connection.active) asError("The connection is disabled");
    if (run.connection.revision !== run.connectionRevision) asError("The connection changed; use the recorded PR link or configure a new delivery");
    const result = await new GitHubClient(ConnectionConfigSchema.parse(run.connection.config).url, credentialsOf(run.connection)).prStatus(receipt.prNumber);
    return runView(await prisma.deploymentRun.update({ where: { id }, data: { receipt: json({ ...receipt, state: result.state }) } }));
  }
  return runView(run);
}

export async function processDeploymentRun(id: string): Promise<void> {
  const token = randomUUID();
  const claim = await prisma.deploymentRun.updateMany({ where: { id, status: "QUEUED", nextAttemptAt: { lte: new Date() } }, data: { status: "RUNNING", leaseToken: token, leaseUntil: new Date(Date.now() + 15 * 60 * 1000), attemptCount: { increment: 1 } } });
  if (claim.count !== 1) return;
  const run = await prisma.deploymentRun.findUnique({ where: { id }, include: { workflow: true, connection: true } });
  if (!run) return;
  const attempt = await prisma.deploymentAttempt.create({ data: { runId: id, number: run.attemptCount, status: "RUNNING" } });
  const heartbeat = setInterval(() => { void prisma.deploymentRun.updateMany({ where: { id, leaseToken: token, status: "RUNNING" }, data: { leaseUntil: new Date(Date.now() + 15 * 60 * 1000) } }).catch(() => undefined); }, 30000);
  heartbeat.unref();
  let receipt: DeliveryReceipt | undefined, error: string | undefined;
  let status = "SUCCEEDED", nextAttemptAt = new Date();
  try {
    const user = await prisma.user.findUnique({ where: { id: run.createdBy }, select: { id: true, disabledAt: true, roles: { select: ROLE_ROW_SELECT } } });
    const principal = user && !user.disabledAt ? { assignments: assignmentsFromRows(user.roles) } : null;
    const entity = await prisma.entity.findUnique({ where: { id: run.entityId }, select: { tenantId: true, domainId: true, productId: true } });
    if (!principal || !entity || !can(principal.assignments, "deploy.run", entity)) asError("Deployment permission was revoked");
    if (!run.connection.active || !run.workflow.active || run.connection.tenantId !== run.tenantId || run.workflow.tenantId !== run.tenantId || run.workflow.entityId !== run.entityId) asError("The workflow or connection is no longer available");
    const plan = run.snapshot as unknown as PreparedPlan;
    if (digest(plan) !== run.planHash || run.connection.revision !== run.connectionRevision || run.workflow.revision !== plan.workflowRevision) asError("Workflow or connection changed; create a new preview");
    await readableBundle(plan.bundle, principal!, run.tenantId);
    receipt = await deliverPrepared(id, methodOf(run), plan, credentialsOf(run.connection), run.idempotencyKey);
  } catch (e) {
    const failure = e instanceof DeliveryError ? e : new DeliveryError("Deployment could not be completed; verify configuration and create a new preview");
    error = failure.message;
    const canRetry = failure.retryable && run.attemptCount < 5 && (!failure.uncertain || run.method !== "http" || ConnectionConfigSchema.parse(run.connection.config).supportsIdempotency);
    status = canRetry ? "QUEUED" : failure.uncertain ? "UNKNOWN" : "FAILED";
    nextAttemptAt = new Date(Date.now() + (failure.retryAfterMs ?? Math.min(60000 * 2 ** (run.attemptCount - 1), 3600000)));
  } finally { clearInterval(heartbeat); }
  await prisma.$transaction(async (tx) => {
    const changed = await tx.deploymentRun.updateMany({ where: { id, status: "RUNNING", leaseToken: token }, data: { status, error: error ?? null, receipt: receipt ? json(receipt) : Prisma.DbNull, leaseUntil: null, leaseToken: null, nextAttemptAt } });
    if (changed.count === 1) await tx.deploymentAttempt.update({ where: { id: attempt.id }, data: { status, error: error ?? null, receipt: receipt ? json(receipt) : Prisma.DbNull, finishedAt: new Date() } });
  });
}

export async function processDueDeployments(limit = 10): Promise<number> {
  // An interrupted worker leaves an uncertain handoff. Only idempotent providers are automatically reconciled.
  const abandoned = await prisma.deploymentRun.findMany({ where: { status: "RUNNING", leaseUntil: { lt: new Date() } }, take: limit, include: { connection: true } });
  for (const run of abandoned) {
    const repeatable = run.method !== "http" || ConnectionConfigSchema.parse(run.connection.config).supportsIdempotency;
    await prisma.$transaction(async (tx) => {
      const recovered = await tx.deploymentRun.updateMany({ where: { id: run.id, status: "RUNNING", leaseToken: run.leaseToken, leaseUntil: { lt: new Date() } }, data: { status: repeatable && run.attemptCount < 5 ? "QUEUED" : "UNKNOWN", leaseToken: null, leaseUntil: null, error: "Worker interrupted; reconciling the previous attempt", nextAttemptAt: new Date() } });
      if (recovered.count === 1) await tx.deploymentAttempt.updateMany({ where: { runId: run.id, number: run.attemptCount, status: "RUNNING" }, data: { status: "UNKNOWN", finishedAt: new Date(), error: "Worker interrupted before a receipt was recorded" } });
    });
  }
  const due = await prisma.deploymentRun.findMany({ where: { status: "QUEUED", nextAttemptAt: { lte: new Date() } }, select: { id: true }, orderBy: { nextAttemptAt: "asc" }, take: limit });
  // Process sequentially to bound external API and repository-toolchain load.
  for (const run of due) await processDeploymentRun(run.id);
  return due.length;
}
