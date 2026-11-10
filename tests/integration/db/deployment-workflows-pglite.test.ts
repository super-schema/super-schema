import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPGlite } from "@/lib/pglite-adapter";
import { applyPgliteMigrations } from "@/lib/pglite-migrate";
import type { ServiceContext } from "@/types/service-context";
import { DeliveryError, type PreparedPlan } from "@/lib/deployments/contracts";

const h = vi.hoisted(() => ({ db: null as unknown as PrismaClient, prepare: vi.fn(), deliver: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get(_target, property) { const value = Reflect.get(h.db, property); return typeof value === "function" ? value.bind(h.db) : value; } }) }));
vi.mock("@/lib/deployments/adapters", () => ({ prepareDelivery: h.prepare, deliverPrepared: h.deliver }));
import { getDeploymentWorkspace, previewDeployment, processDeploymentRun, processDueDeployments, queueDeployment, saveDeploymentConnection, saveDeploymentWorkflow } from "@/services/deployment-workflow.service";

let pg: PGlite;
const originalSecretKey = process.env.SECRETS_ENCRYPTION_KEY;
const ctx = (): ServiceContext => ({ userId: "actor", userRole: "VIEWER", assignments: [{ role: "ADMIN", scope: { kind: "TENANT", tenantId: "tenant" } }], tenantId: "tenant", prisma: h.db });
const artifact = (version = 1, status = "published", output = '{"type":"record","name":"Account","fields":[]}') => ({ version, status, output, generatedAt: "2026-11-07", entityVersion: 1 });
let connectionId: string, workflowId: string;

beforeAll(async () => {
  process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");
  pg = new PGlite();
  expect(await applyPgliteMigrations(pg)).toContain("20261107000000_deployment_workflows");
  expect(await applyPgliteMigrations(pg)).toEqual([]);
  h.db = new PrismaClient({ adapter: new PrismaPGlite(pg) });
}, 120000);
afterAll(async () => { await h.db?.$disconnect(); await pg?.close(); if (originalSecretKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY; else process.env.SECRETS_ENCRYPTION_KEY = originalSecretKey; });
beforeEach(async () => {
  h.prepare.mockReset(); h.deliver.mockReset();
  const clear = [() => h.db.deploymentRun.deleteMany(), () => h.db.deploymentWorkflow.deleteMany(), () => h.db.deploymentConnection.deleteMany(), () => h.db.userRole.deleteMany(), () => h.db.entity.deleteMany(), () => h.db.product.deleteMany(), () => h.db.domain.deleteMany(), () => h.db.tenant.deleteMany()];
  for (const remove of clear) await remove();
  // Audit entries are immutable and retain their actor, so preserve the actor across cases.
  await h.db.user.upsert({ where: { id: "actor" }, update: { disabledAt: null }, create: { id: "actor", email: "actor@example.test" } });
  await h.db.tenant.create({ data: { id: "tenant", name: "PayPal", slug: "paypal" } });
  await h.db.domain.create({ data: { id: "domain", tenantId: "tenant", name: "Identity", slug: "identity" } });
  await h.db.product.create({ data: { id: "product", domainId: "domain", name: "Accounts", slug: "accounts" } });
  await h.db.entity.create({ data: { id: "root", name: "Account", slug: "account", tenantId: "tenant", domainId: "domain", productId: "product", ownerId: "actor", metadata: { schemaVersions: { avro: [artifact()] } } } });
  await h.db.userRole.create({ data: { userId: "actor", role: "ADMIN", scopeKey: "T:tenant", tenantId: "tenant" } });
  const connection = await saveDeploymentConnection("root", { name: "Staging API", method: "http", config: { url: "https://receiver.example/schema", supportsIdempotency: false }, credentials: { authType: "bearer", token: "very-secret-token" } }, ctx());
  connectionId = connection.id;
  workflowId = (await saveDeploymentWorkflow("root", { name: "Staging", connectionId, format: "avro", environment: "staging", settings: {} }, ctx())).id;
  h.prepare.mockImplementation(async (input) => ({ bundle: input.bundle, connectionConfig: input.config, settings: input.settings, environment: input.environment, workflowRevision: input.revision, validation: ["Test destination prepared"] } satisfies PreparedPlan));
  h.deliver.mockResolvedValue({ outcome: "accepted", httpStatus: 202 });
});

const preview = () => previewDeployment("root", { workflowId, version: 1, idempotencyKey: crypto.randomUUID() }, ctx());
const queue = (run: { id: string; planHash: string }) => queueDeployment("root", { runId: run.id, planHash: run.planHash }, ctx());

describe("durable deployment workflow on migrated PostgreSQL/PGlite tables", () => {
  it("cascades entity-owned runs and attempts when the entity is deleted", async () => {
    const result = await preview(); await queue(result.run); await processDeploymentRun(result.run.id);
    await h.db.entity.delete({ where: { id: "root" } });
    expect(await h.db.deploymentRun.count()).toBe(0); expect(await h.db.deploymentAttempt.count()).toBe(0); expect(await h.db.deploymentWorkflow.count()).toBe(0);
    expect(await h.db.deploymentConnection.count()).toBe(1);
  });
  it("cascades deployment data when the tenant is deleted", async () => {
    await preview();
    await h.db.tenant.delete({ where: { id: "tenant" } });
    expect(await h.db.deploymentRun.count()).toBe(0); expect(await h.db.deploymentWorkflow.count()).toBe(0); expect(await h.db.deploymentConnection.count()).toBe(0);
  });
  it("seals credentials and returns only a public connection view", async () => {
    const row = await h.db.deploymentConnection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(row.credentials).toMatch(/^enc:v1:/); expect(row.credentials).not.toContain("very-secret-token");
    const workspace = await getDeploymentWorkspace("root", ctx());
    expect(JSON.stringify(workspace)).not.toContain("very-secret-token");
    expect(JSON.stringify(await h.db.auditLog.findMany())).not.toContain("very-secret-token");
    expect(workspace).toMatchObject({ canConfigure: true, canRun: true, formats: [{ key: "avro", versions: [1] }] });
  });
  it("pins an older published version through generation of a newer draft and a JSONB round trip", async () => {
    const result = await preview();
    await h.db.entity.update({ where: { id: "root" }, data: { metadata: { schemaVersions: { avro: [artifact(2, "draft", "NEW DRAFT"), artifact()] } } } });
    expect((await queue(result.run)).status).toBe("QUEUED");
    await processDeploymentRun(result.run.id);
    const row = await h.db.deploymentRun.findUniqueOrThrow({ where: { id: result.run.id } });
    expect(row.status).toBe("SUCCEEDED");
    expect(h.deliver.mock.calls[0][2].bundle).toMatchObject({ version: 1, files: [{ content: artifact().output }] });
    expect(await h.db.deploymentRecord.count()).toBe(0);
    expect((await h.db.entity.findUniqueOrThrow({ where: { id: "root" } })).metadata).toMatchObject({ schemaVersions: { avro: [{ status: "draft" }, { status: "published" }] } });
  });
  it("uses one durable intent and claims a concurrently executed job exactly once", async () => {
    const key = crypto.randomUUID();
    const first = await previewDeployment("root", { workflowId, version: 1, idempotencyKey: key }, ctx());
    expect((await previewDeployment("root", { workflowId, version: 1, idempotencyKey: key }, ctx())).run.id).toBe(first.run.id);
    await queue(first.run); await queue(first.run);
    await Promise.all([processDeploymentRun(first.run.id), processDeploymentRun(first.run.id)]);
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(await h.db.deploymentAttempt.count({ where: { runId: first.run.id } })).toBe(1);
    expect((await queue(first.run)).status).toBe("SUCCEEDED");
  });
  it("refuses a changed configuration, expired preview and tampered plan", async () => {
    const first = await preview();
    await h.db.deploymentConnection.update({ where: { id: connectionId }, data: { revision: { increment: 1 } } });
    await expect(queue(first.run)).rejects.toThrow(/changed/);
    const second = await preview();
    await h.db.deploymentRun.update({ where: { id: second.run.id }, data: { expiresAt: new Date(0) } });
    await expect(queue(second.run)).rejects.toThrow(/expired/);
    const third = await preview();
    await h.db.deploymentRun.update({ where: { id: third.run.id }, data: { snapshot: {} } });
    await expect(queue(third.run)).rejects.toThrow(/preview not found/);
    expect(h.deliver).not.toHaveBeenCalled();
  });
  it("does not automatically retry an uncertain non-idempotent API delivery", async () => {
    const result = await preview(); await queue(result.run);
    h.deliver.mockRejectedValue(new DeliveryError("Response lost", true, true));
    await processDeploymentRun(result.run.id); await processDueDeployments();
    expect((await h.db.deploymentRun.findUniqueOrThrow({ where: { id: result.run.id } })).status).toBe("UNKNOWN");
    expect(h.deliver).toHaveBeenCalledTimes(1);
  });
  it("retries an idempotent delivery with the same frozen bytes and records both attempts", async () => {
    await h.db.deploymentConnection.update({ where: { id: connectionId }, data: { config: { url: "https://receiver.example/schema", supportsIdempotency: true } } });
    const result = await preview(); await queue(result.run);
    h.deliver.mockRejectedValueOnce(new DeliveryError("Response lost", true, true)).mockResolvedValue({ outcome: "accepted", httpStatus: 202 });
    await processDeploymentRun(result.run.id);
    expect((await h.db.deploymentRun.findUniqueOrThrow({ where: { id: result.run.id } })).status).toBe("QUEUED");
    await h.db.deploymentRun.update({ where: { id: result.run.id }, data: { nextAttemptAt: new Date(0) } });
    await processDueDeployments();
    expect((await h.db.deploymentRun.findUniqueOrThrow({ where: { id: result.run.id } })).status).toBe("SUCCEEDED");
    expect(h.deliver.mock.calls[0]).toEqual(h.deliver.mock.calls[1]);
    expect(await h.db.deploymentAttempt.count({ where: { runId: result.run.id } })).toBe(2);
  });
  it("marks abandoned non-idempotent work unknown and preserves its attempt", async () => {
    const result = await preview();
    await h.db.deploymentRun.update({ where: { id: result.run.id }, data: { status: "RUNNING", attemptCount: 1, leaseUntil: new Date(0), leaseToken: "dead-worker" } });
    await h.db.deploymentAttempt.create({ data: { runId: result.run.id, number: 1, status: "RUNNING" } });
    await processDueDeployments();
    expect((await h.db.deploymentRun.findUniqueOrThrow({ where: { id: result.run.id } })).status).toBe("UNKNOWN");
    expect((await h.db.deploymentAttempt.findFirstOrThrow({ where: { runId: result.run.id } })).status).toBe("UNKNOWN");
    expect(h.deliver).not.toHaveBeenCalled();
  });
  it("checks the creator's current role before any external side effect", async () => {
    const result = await preview(); await queue(result.run);
    await h.db.userRole.deleteMany({ where: { userId: "actor" } });
    await processDeploymentRun(result.run.id);
    expect((await h.db.deploymentRun.findUniqueOrThrow({ where: { id: result.run.id } })).error).toMatch(/permission was revoked/);
    expect(h.deliver).not.toHaveBeenCalled();
  });
  it("refuses foreign connections and artifact references outside the caller's scope", async () => {
    await h.db.tenant.create({ data: { id: "other", name: "Other", slug: "other" } });
    const foreign = await h.db.deploymentConnection.create({ data: { tenantId: "other", name: "Other API", method: "http", config: {}, credentials: "secret", createdBy: "actor" } });
    await expect(saveDeploymentWorkflow("root", { name: "Foreign", connectionId: foreign.id, format: "avro", environment: "staging", settings: {} }, ctx())).rejects.toThrow(/Connection not found/);
    await h.db.entity.create({ data: { id: "hidden", tenantId: "other", ownerId: "actor", name: "Hidden", slug: "hidden" } });
    await h.db.entity.update({ where: { id: "root" }, data: { metadata: { schemaVersions: { avro: [{ ...artifact(), files: [{ path: "Account.avsc", content: "root", target: "avro", entityId: "root" }, { path: "Hidden.avsc", content: "private", target: "avro", entityId: "hidden" }] }] } } } });
    await expect(preview()).rejects.toThrow(/every referenced artifact/);
    expect(h.prepare).not.toHaveBeenCalled();
  });
  it("blocks drafts server-side even when the UI request is forged", async () => {
    await h.db.entity.update({ where: { id: "root" }, data: { metadata: { schemaVersions: { avro: [artifact(1, "draft")] } } } });
    await expect(preview()).rejects.toThrow(/Publish this schema/);
    expect(h.prepare).not.toHaveBeenCalled();
  });
});
