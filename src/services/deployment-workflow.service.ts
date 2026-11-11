import { gitOpsWorkflowPolicy, assertGitOpsWorkflowRevision } from "@/lib/gitops/workflow-policy";
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
import { deploymentMethodsFor, TargetMethodMappingsSchema, registryTarget } from "@/lib/deployments/target-methods";
import { getSchemaTargetCatalog, getSchemaTargetDefinition } from "@/lib/schema-targets/catalog";
import { privateTargetsAllowed, requestExternal } from "@/lib/webhook-transport";
import {
  ConnectionConfigSchema, CredentialsSchema, DeliveryError, EnvironmentListSchema, ExecuteSchema, PreviewSchema, SaveConnectionSchema, SaveWorkflowSchema, WorkflowSettingsSchema, workflowTargets,
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
  const [connections, workflows, runs, records] = await Promise.all([
    prisma.deploymentConnection.findMany({ where: { tenantId: entity.tenantId }, select: CONNECTION_VIEW_SELECT, orderBy: { name: "asc" } }),
    prisma.deploymentWorkflow.findMany({ where: { tenantId: entity.tenantId, OR: [{ entityId }, ...(entity.productId ? [{ entityId: null, productId: entity.productId }] : [])] }, orderBy: { name: "asc" } }),
    prisma.deploymentRun.findMany({ where: { tenantId: entity.tenantId, entityId }, select: RUN_VIEW_SELECT, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.deploymentRecord.findMany({ where: { target: { startsWith: `${entityId}:` } } }),
  ]);
  const versions = ((entity.metadata as Record<string, unknown> | null)?.schemaVersions ?? {}) as SchemaVersionsMap;
  const legacyGit = ctxCan(ctx, "git.manage") ? (await prisma.gitConfig.findMany({ select: { id: true } })).map((c, i) => ({ id: c.id, name: `Legacy Git configuration ${i + 1}` })) : [];
  const legacyMarkers = Object.entries(versions).flatMap(([format, entries]) => entries.filter((v) => v.status === "deployed").map((v) => ({ format, version: v.version, deployedAt: v.deployedAt })));
  return { entitySlug: entity.slug, targetMethods: TargetMethodMappingsSchema.parse(entity.tenant.deploymentTargetMethods), environments: entity.tenant.deploymentEnvironments,
    productWorkflowsHref: entity.domain && entity.product ? `/schemas/${encodeURIComponent(entity.domain.slug)}/${encodeURIComponent(entity.product.slug)}?tab=workflows` : null,
    recorded: records.map((r) => { const target = r.target.slice(entityId.length + 1); return { target, environment: r.environment, version: r.version, sourceVersion: versions[target]?.find((v) => v.version === r.version)?.entityVersion ?? null }; }),
    legacyGit, legacyMarkers, connections: connections.map(connectionView), workflows: workflows.map((w) => ({ id: w.id, name: w.name, format: w.format, supportedTargets: [...workflowTargets(w)], environment: w.environment, connectionId: w.connectionId, settings: WorkflowSettingsSchema.parse(w.settings), revision: w.revision, active: w.active, scope: w.productId ? "product" as const : "schema" as const })), runs: runs.map(runView),
    formats: Object.entries(versions).map(([key, entries]) => ({ key, sourceVersions: Object.fromEntries(entries.map((v) => [String(v.version), v.entityVersion])), versions: entries.filter((v) => v.status === "published" || v.status === "deployed").map((v) => v.version).sort((a, b) => b - a) })).filter((f) => f.key),
    canConfigure: ctxCan(ctx, "deploy.configure", { tenantId: entity.tenantId }), canRun: ctxCan(ctx, "deploy.run", { tenantId: entity.tenantId, domainId: entity.domainId, productId: entity.productId }) };
}

export async function importLegacyGitConnection(entityId: string, id: string, ctx: ServiceContext): Promise<ConnectionView> {
  const entity = await entityFor(entityId, ctx, "deploy.configure");
  return importTenantLegacyGitConnection(entity.tenantId, id, ctx);
}

export async function importTenantLegacyGitConnection(tenantId: string, id: string, ctx: ServiceContext): Promise<ConnectionView> {
  if (!ctxCan(ctx, "deploy.configure", { tenantId })) return asError("Deployment configuration access denied");
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
  return saveTenantDeploymentConnection(tenantId, { name: `${repository.owner}/${repository.repo}`.slice(0, 100), method: "git", config: { url: repository.web, baseBranch: config.branch, supportsIdempotency: false }, credentials }, ctx);
}

export async function saveDeploymentConnection(entityId: string, raw: unknown, ctx: ServiceContext): Promise<ConnectionView> {
  const entity = await entityFor(entityId, ctx, "deploy.configure");
  return saveTenantDeploymentConnection(entity.tenantId, raw, ctx);
}

export async function saveTenantDeploymentConnection(tenantId: string, raw: unknown, ctx: ServiceContext): Promise<ConnectionView> {
  if (!ctxCan(ctx, "deploy.configure", { tenantId })) return asError("Deployment configuration access denied");
  const entity = { tenantId };
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
  return verifyTenantDeploymentConnection(entity.tenantId, id, ctx);
}

export async function verifyTenantDeploymentConnection(tenantId: string, id: string, ctx: ServiceContext): Promise<string> {
  if (!ctxCan(ctx, "deploy.configure", { tenantId })) return asError("Deployment configuration access denied");
  const entity = { tenantId };
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
  validateEnvironment(entity.tenant.deploymentEnvironments, input.environment);
  const connection = await prisma.deploymentConnection.findFirst({ where: { id: input.connectionId, tenantId: entity.tenantId, active: true } });
  if (!connection) return asError("Connection not found");
  for (const target of input.supportedTargets) validateTargetMethod(target, methodOf(connection), entity.tenant.deploymentTargetMethods);
  if (input.id && !await prisma.deploymentWorkflow.findFirst({ where: { id: input.id, tenantId: entity.tenantId, entityId } })) asError("Workflow not found");
  const data = { name: input.name, connectionId: input.connectionId, format: input.format, supportedTargets: input.supportedTargets, environment: input.environment, settings: json(input.settings), active: input.active };
  return withAudit({ action: input.id ? "UPDATE" : "CREATE", entityType: "DeploymentWorkflow", entityId: input.id ?? "pending", tenantId: entity.tenantId, userId: ctx.userId, fn: async () => {
    const row = input.id ? await prisma.deploymentWorkflow.update({ where: { id: input.id }, data: { ...data, revision: { increment: 1 } } })
      : await prisma.deploymentWorkflow.create({ data: { ...data, tenantId: entity.tenantId, entityId, createdBy: ctx.userId } });
    return { id: row.id, name: row.name, entityId, connectionId: row.connectionId, format: row.format, environment: row.environment, revision: row.revision };
  } });
}

function validateEnvironment(environments: readonly string[], environment: string) {
  if (!environments.includes(environment)) asError("Choose an environment configured in tenant settings");
}

function validateTargetMethod(target: string, method: DeploymentMethod, configured: unknown) {
  if (!deploymentMethodsFor(target, TargetMethodMappingsSchema.parse(configured)).includes(method) || (method === "registry" && !registryTarget(target))) asError("This deployment method is not enabled for the selected target in tenant settings");
}

export async function saveDeploymentTargetMethods(tenantId: string, raw: unknown, ctx: ServiceContext) {
  if (!ctxCan(ctx, "deploy.configure", { tenantId })) return asError("Deployment configuration access denied");
  const mappings = TargetMethodMappingsSchema.parse(raw);
  const targets = new Set(["*", ...getSchemaTargetCatalog().filter((t) => t.enabledInSchemaTab).map((t) => t.key)]);
  for (const [target, methods] of Object.entries(mappings)) {
    if (!targets.has(target)) asError("Choose a supported target datastore or format");
    if (methods.includes("registry") && !registryTarget(target)) asError("Schema registry delivery requires an Avro, JSON Schema or Protobuf target");
  }
  const workflows = await prisma.deploymentWorkflow.findMany({ where: { tenantId, active: true }, select: { name: true, format: true, supportedTargets: true, connection: { select: { method: true } } } });
  if (workflows.some((w) => workflowTargets(w).some((target) => !deploymentMethodsFor(target, mappings).includes(methodOf(w.connection))))) asError("Update or disable workflows that use a method before removing it from a target");
  return withAudit({ action: "UPDATE", entityType: "Tenant", entityId: tenantId, tenantId, userId: ctx.userId, fn: async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { deploymentTargetMethods: json(mappings) } });
    return { targetMethods: mappings };
  } });
}

function workflowApplies(workflow: { entityId: string | null; productId: string | null }, entity: { id: string; productId: string | null }) {
  return workflow.entityId === entity.id || (workflow.entityId === null && workflow.productId !== null && workflow.productId === entity.productId);
}

export async function getTenantDeploymentConfiguration(tenantId: string, ctx: ServiceContext) {
  if (!ctxCan(ctx, "deploy.configure", { tenantId })) return asError("Deployment configuration access denied");
  const [tenant, connections] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { deploymentEnvironments: true, deploymentTargetMethods: true } }),
    prisma.deploymentConnection.findMany({ where: { tenantId }, select: CONNECTION_VIEW_SELECT, orderBy: { name: "asc" } }),
  ]);
  if (!tenant) return asError("Tenant not found");
  const legacyGit = ctxCan(ctx, "git.manage") ? (await prisma.gitConfig.findMany({ select: { id: true } })).map((c, i) => ({ id: c.id, name: `Legacy Git configuration ${i + 1}` })) : [];
  return { targetMethods: TargetMethodMappingsSchema.parse(tenant.deploymentTargetMethods), environments: tenant.deploymentEnvironments, connections: connections.map(connectionView), legacyGit };
}

export async function saveDeploymentEnvironments(tenantId: string, raw: unknown, ctx: ServiceContext) {
  if (!ctxCan(ctx, "deploy.configure", { tenantId })) return asError("Deployment configuration access denied");
  const environments = EnvironmentListSchema.parse(raw);
  if (await prisma.deploymentWorkflow.count({ where: { tenantId, active: true, environment: { notIn: environments } } })) asError("Update or disable workflows that use an environment before removing it");
  return withAudit({ action: "UPDATE", entityType: "Tenant", entityId: tenantId, tenantId, userId: ctx.userId, fn: async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { deploymentEnvironments: environments } });
    return { environments };
  } });
}

async function productFor(productId: string, ctx: ServiceContext, action: "deploy.read" | "deploy.run") {
  const product = await prisma.product.findUnique({ where: { id: productId }, include: { domain: { include: { tenant: true } } } });
  if (!product || !ctxCan(ctx, action, { tenantId: product.domain.tenantId, domainId: product.domainId, productId })) return asError("Product not found or deployment access denied");
  return product;
}

export async function getProductDeploymentConfiguration(productId: string, ctx: ServiceContext) {
  const product = await productFor(productId, ctx, "deploy.read");
  const tenantId = product.domain.tenantId;
  const [connections, workflows] = await Promise.all([
    prisma.deploymentConnection.findMany({ where: { tenantId }, select: CONNECTION_VIEW_SELECT, orderBy: { name: "asc" } }),
    prisma.deploymentWorkflow.findMany({ where: { tenantId, OR: [{ productId, entityId: null }, { entity: { productId } }] }, orderBy: { name: "asc" } }),
  ]);
  return { targetMethods: TargetMethodMappingsSchema.parse(product.domain.tenant.deploymentTargetMethods), environments: product.domain.tenant.deploymentEnvironments, connections: connections.map(connectionView),
    workflows: workflows.map((w) => ({ ...w, supportedTargets: [...workflowTargets(w)], settings: WorkflowSettingsSchema.parse(w.settings), scope: w.entityId ? "schema" as const : "product" as const })),
    canManage: ctxCan(ctx, "deploy.run", { tenantId, domainId: product.domainId, productId }) };
}

export async function saveProductDeploymentWorkflow(productId: string, raw: unknown, ctx: ServiceContext) {
  const product = await productFor(productId, ctx, "deploy.run");
  const tenantId = product.domain.tenantId, input = SaveWorkflowSchema.parse(raw);
  validateEnvironment(product.domain.tenant.deploymentEnvironments, input.environment);
  if (input.supportedTargets.some((key) => !getSchemaTargetDefinition(key)?.enabledInSchemaTab)) return asError("Choose a supported target datastore or format");
  const connection = await prisma.deploymentConnection.findFirst({ where: { id: input.connectionId, tenantId, active: true } });
  if (!connection) return asError("Connection not found");
  for (const target of input.supportedTargets) validateTargetMethod(target, methodOf(connection), product.domain.tenant.deploymentTargetMethods);
  if (input.id && !await prisma.deploymentWorkflow.findFirst({ where: { id: input.id, tenantId, OR: [{ productId, entityId: null }, { entity: { productId } }] } })) asError("Workflow not found");
  const data = { name: input.name, connectionId: input.connectionId, format: input.format, supportedTargets: input.supportedTargets, environment: input.environment, settings: json(input.settings), active: input.active };
  return withAudit({ action: input.id ? "UPDATE" : "CREATE", entityType: "DeploymentWorkflow", entityId: input.id ?? "pending", tenantId, userId: ctx.userId, fn: async () => {
    const row = input.id ? await prisma.deploymentWorkflow.update({ where: { id: input.id }, data: { ...data, revision: { increment: 1 } } })
      : await prisma.deploymentWorkflow.create({ data: { ...data, tenantId, productId, createdBy: ctx.userId } });
    return { id: row.id };
  } });
}

export async function previewDeployment(entityId: string, raw: unknown, ctx: ServiceContext): Promise<{ run: RunView; plan: PreparedPlan }> {
  const entity = await entityFor(entityId, ctx, "deploy.run");
  const input = PreviewSchema.parse(raw);
  const requestHash = digest({ ...input, idempotencyKey: undefined });
  const old = await prisma.deploymentRun.findUnique({ where: { tenantId_idempotencyKey: { tenantId: entity.tenantId, idempotencyKey: input.idempotencyKey } } });
  if (old) {
    if (old.entityId !== entityId || old.workflowId !== input.workflowId || old.artifactVersion !== input.version || old.createdBy !== ctx.userId) asError("This delivery intent belongs to another request");
    const plan = old.snapshot as unknown as PreparedPlan;
    if (plan.requestHash !== requestHash) asError("This delivery intent belongs to another request");
    await readableBundle(plan.bundle, ctx, entity.tenantId);
    return { run: runView(old), plan };
  }
  const workflow = await prisma.deploymentWorkflow.findFirst({ where: { id: input.workflowId, tenantId: entity.tenantId, active: true, OR: [{ entityId }, ...(entity.productId ? [{ entityId: null, productId: entity.productId }] : [])] }, include: { connection: true } });
  if (!workflow || !workflow.connection.active || workflow.connection.tenantId !== entity.tenantId) return asError("Workflow or connection not found");
  if (!entity.domain || !entity.product) return asError("Git deployment uses a tenant/domain/product/schema hierarchy; assign this entity to a product first");
  const targets = workflowTargets(workflow);
  const format = input.format ?? (targets.length === 1 ? targets[0] : asError("Select the exact target for this workflow"));
  if (!targets.includes(format)) return asError("This workflow does not support the selected target");
  if (workflow.connection.method === "git" && input.connectionId && input.connectionId !== workflow.connectionId) return asError("The Git repository is defined by the saved workflow");
  const versions = (entity.metadata as Record<string, unknown> | null)?.schemaVersions as SchemaVersionsMap | undefined;
  const version = versions?.[format]?.find((v) => v.version === input.version);
  if (!version) return asError("The selected schema version was not found");
  let bundle: ArtifactBundle;
  try { bundle = freezeArtifact({ id: entity.id, name: entity.name, tenant: entity.tenant.slug, domain: entity.domain.slug, product: entity.product.slug, schema: entity.slug }, format, version); }
  catch (error) { return asError(error instanceof Error ? error.message : "Invalid artifact"); }
  await readableBundle(bundle, ctx, entity.tenantId);
  const id = randomUUID();
  const connection = input.connectionId && input.connectionId !== workflow.connectionId
    ? await prisma.deploymentConnection.findFirst({ where: { id: input.connectionId, tenantId: entity.tenantId, active: true, method: workflow.connection.method } })
    : workflow.connection;
  if (!connection) return asError("Choose an active tenant connection for this deployment method");
  validateTargetMethod(format, methodOf(connection), entity.tenant.deploymentTargetMethods);
  const environment = input.environment ?? workflow.environment;
  const gitOps=await gitOpsWorkflowPolicy(workflow.id,environment);
  validateEnvironment(gitOps?.environments ?? entity.tenant.deploymentEnvironments, environment);
  const settings = WorkflowSettingsSchema.parse({ ...WorkflowSettingsSchema.parse(workflow.settings), ...input.variables });
  const plan = await prepareDelivery({ id, method: methodOf(connection), bundle, config: {...destination(connection.config, methodOf(connection)),...(gitOps ? {url:gitOps.url,baseBranch:gitOps.baseBranch,gitRoot:gitOps.gitRoot}: {})}, settings, revision: workflow.revision, environment }, credentialsOf(connection));
  if(gitOps)plan.gitOpsRevision=gitOps.revision;
  plan.requestHash = requestHash;
  const row = await prisma.deploymentRun.create({ data: { id, tenantId: entity.tenantId, entityId, workflowId: workflow.id, connectionId: connection.id, connectionRevision: connection.revision, method: connection.method, format, artifactVersion: version.version, environment, snapshot: json(plan), planHash: digest(plan), idempotencyKey: input.idempotencyKey, createdBy: ctx.userId, expiresAt: new Date(Date.now() + 30 * 60 * 1000) } });
  return { run: runView(row), plan };
}

export async function queueDeployment(entityId: string, raw: unknown, ctx: ServiceContext): Promise<RunView> {
  const entity = await entityFor(entityId, ctx, "deploy.run");
  const input = ExecuteSchema.parse(raw);
  const run = await prisma.deploymentRun.findFirst({ where: { id: input.runId, entityId, tenantId: entity.tenantId, createdBy: ctx.userId }, include: { workflow: true, connection: true } });
  if (!run || run.planHash !== input.planHash || digest(run.snapshot) !== run.planHash) return asError("Validated preview not found");
  if (!workflowApplies(run.workflow, entity) || !workflowTargets(run.workflow).includes(run.format)) return asError("Workflow is no longer available for this schema or target");
  if (run.method === "git" && run.connectionId !== run.workflow.connectionId) return asError("The Git repository is defined by the saved workflow");
  if (run.method === "git" && (run.snapshot as unknown as PreparedPlan).fileChanges?.every((f) => f.status === "unchanged")) return asError("The preview contains no file changes");
  validateTargetMethod(run.format, methodOf(run), entity.tenant.deploymentTargetMethods);
  const gitOps=await gitOpsWorkflowPolicy(run.workflowId,run.environment);
  validateEnvironment(gitOps?.environments ?? entity.tenant.deploymentEnvironments, run.environment);
  await assertGitOpsWorkflowRevision(run.workflowId,run.environment,(run.snapshot as unknown as PreparedPlan).gitOpsRevision);
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
    const entity = await prisma.entity.findUnique({ where: { id: run.entityId }, select: { id: true, tenantId: true, domainId: true, productId: true, tenant: { select: { deploymentEnvironments: true, deploymentTargetMethods: true } } } });
    if (!principal || !entity || !can(principal.assignments, "deploy.run", entity)) asError("Deployment permission was revoked");
    if (!run.connection.active || !run.workflow.active || run.connection.tenantId !== run.tenantId || run.workflow.tenantId !== run.tenantId || (!workflowApplies(run.workflow, entity!) || !workflowTargets(run.workflow).includes(run.format)) || (run.method === "git" && run.connectionId !== run.workflow.connectionId)) asError("The workflow or connection is no longer available");
    validateTargetMethod(run.format, methodOf(run), entity!.tenant.deploymentTargetMethods);
    const gitOps=await gitOpsWorkflowPolicy(run.workflowId,run.environment);
    validateEnvironment(gitOps?.environments ?? entity!.tenant.deploymentEnvironments, run.environment);
    await assertGitOpsWorkflowRevision(run.workflowId,run.environment,(run.snapshot as unknown as PreparedPlan).gitOpsRevision);
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
