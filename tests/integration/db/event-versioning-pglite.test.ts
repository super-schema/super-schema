import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { TestDb } from "../../helpers/pglite-db";

// The real event publish / promote services on PGlite with every migration (the app's `@/lib/db`, which the audit trail writes through).
// Only the artifact renderer is a stand-in (no TypeSpec compile) and only the structural validator runs: `@asyncapi/parser` is not what
// is tested here (and is heavy).
const holder = vi.hoisted(() => ({ db: undefined as undefined | TestDb }));
vi.mock("@/lib/db", async () => {
  holder.db = await (await import("../../helpers/pglite-db")).createPgliteDb();
  return { prisma: holder.db.prisma };
});
vi.mock("@/lib/event-specs/validation/asyncapi-parser-validator", () => ({ AsyncApiParserValidator: class {} }));

import type { Prisma } from "@/generated/prisma/client";
import { StructuralAsyncApi3Validator, type JsonObject, type PayloadFormat, type SchemaArtifact } from "@/lib/event-specs";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";
import type { ArtifactRenderer } from "@/services/events/artifact-renderer";
import { emitEventStoredVersion, type EmitDeps } from "@/services/events/event-emit.service";
import { listEventVersions, previewEventPublish, promoteEvent, publishEvent } from "@/services/events/event-publish.service";
import { ok, err, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

const TENANT = "tenant_default";
let ctx: ServiceContext;
let n = 0;
const prisma = () => holder.db!.prisma;

const modelNames = new Map<string, string>();
function artifactFor(name: string, format: PayloadFormat): SchemaArtifact {
  return format === "avro"
    ? { format: "avro", schema: { type: "record", name, fields: [{ name: "id", type: "string" }] } }
    : { format: "json-schema", dialect: "draft-07", schema: { type: "object", title: name, properties: { id: { type: "string" } } } };
}
const renderer: ArtifactRenderer = {
  async render(subject, format) {
    const id = subject.kind === "version" ? subject.entityVersionId : subject.entityId;
    const name = modelNames.get(id);
    if (!name) return err({ code: "NOT_FOUND", message: `no stub for ${id}` });
    return ok({ artifact: artifactFor(name, format), warnings: [] });
  },
};
const deps: EmitDeps = { renderer, validators: [new StructuralAsyncApi3Validator()] };

function unwrap<T>(r: Result<T>): T {
  if (!r.success) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data;
}
const codeOf = (r: Result<unknown>) => (r.success ? "OK" : r.error.code);
const obj = (value: unknown) => value as JsonObject;
const infoVersion = (stored: unknown) => obj(obj(stored).info).version;

beforeAll(async () => {
  const user = await prisma().user.create({ data: { email: "event-snapshots@example.test" } });
  ctx = { userId: user.id, userRole: "AUTHOR", assignments: [{ role: "ADMIN", scope: { kind: "GLOBAL" } }], prisma: prisma() };
}, 120_000);
afterAll(async () => {
  await holder.db?.close();
});

/** A fresh domain + product, with helpers for entities (at given versions) and events under it. */
async function scope() {
  const s = `ev${++n}`;
  const domain = await prisma().domain.create({ data: { name: `dom-${s}`, slug: `dom-${s}`, tenantId: TENANT } });
  const product = await prisma().product.create({ data: { domainId: domain.id, name: "P", slug: `p-${s}` } });

  /** An entity with one stored version: RELEASED 1.0.0, or an open 1.0.0_snapshot. */
  const entity = async (name: string, stage: "RELEASED" | "SNAPSHOT" = "RELEASED") => {
    const e = await prisma().entity.create({
      data: { name, slug: `${name.toLowerCase()}-${s}`, tenantId: TENANT, domainId: domain.id, productId: product.id, ownerId: ctx.userId },
    });
    const v = await prisma().entityVersion.create({
      data: {
        entityId: e.id, major: 1, minor: 0, patch: 0, sequence: 1, stage, changeKind: "INITIAL", publishedById: ctx.userId,
        releasedAt: stage === "RELEASED" ? new Date() : null, resolvedSource: `model ${name} {\n  id: string;\n}\n`, fieldSnapshot: [],
      },
    });
    await prisma().entity.update({ where: { id: e.id }, data: { latestVersionId: v.id, hasUnpublishedChanges: false } });
    modelNames.set(e.id, name);
    modelNames.set(v.id, name);
    return { id: e.id, name, versionId: v.id };
  };

  /** A complete, valid v2 document: one Kafka/Avro channel, one message pinned to `payload`, one send operation. */
  const document = (payload: { id: string; versionId: string }, description?: string): EventDocument => ({
    ...emptyEventDocument(`orders-${s}`, description),
    servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" }],
    channels: [{ key: "orders", address: "payments.orders.v1", protocol: "kafka", serverKeys: ["kafka-prod"], format: "avro", messageKeys: ["order-created"] }],
    messages: [{ key: "order-created", contentType: "avro/binary", payload: { entityId: payload.id, entityVersionId: payload.versionId }, traitKeys: [] }],
    operations: [{ key: "publishOrderCreated", action: "send", channelKey: "orders", messageKeys: ["order-created"], traitKeys: [] }],
  });

  const event = async (doc: EventDocument) => {
    const row = await prisma().eventSpec.create({
      data: { name: `evt-${s}-${++n}`, tenantId: TENANT, domainId: domain.id, productId: product.id, document: doc as unknown as Prisma.InputJsonValue },
    });
    return row.id;
  };
  /** Edits the draft the way the event editor saves it: a new document, the draft flagged changed. */
  const edit = (eventId: string, doc: EventDocument) =>
    prisma().eventSpec.update({ where: { id: eventId }, data: { document: doc as unknown as Prisma.InputJsonValue, hasUnpublishedChanges: true } });

  const save = (eventId: string, bump?: "MAJOR" | "MINOR" | "PATCH") => publishEvent(eventId, product.id, bump ? { bump } : {}, ctx, deps);
  const promote = (eventId: string) => promoteEvent(eventId, product.id, ctx);
  return { product, entity, document, event, edit, save, promote };
}

const versionsOf = (eventId: string) => prisma().eventSpecVersion.findMany({ where: { eventSpecId: eventId }, orderBy: { sequence: "asc" } });
const eventRow = (eventId: string) => prisma().eventSpec.findUniqueOrThrow({ where: { id: eventId }, select: { latestVersionId: true, hasUnpublishedChanges: true } });
/** What the entity service's promote does to the row (stage → RELEASED, same row). */
const releaseEntityVersion = (versionId: string) =>
  prisma().entityVersion.update({ where: { id: versionId }, data: { stage: "RELEASED", releasedAt: new Date(), releasedById: ctx.userId } });

describe("event snapshots and promotion (service, PGlite)", () => {
  it("info.version carries the snapshot label", async () => {
    const sc = await scope();
    const order = await sc.entity("Order");
    const id = await sc.event(sc.document(order));

    const saved = unwrap(await sc.save(id));
    expect(saved).toMatchObject({ label: "1.0.0_snapshot", stage: "SNAPSHOT", patch: 0, releasedAt: null });
    const [row] = await versionsOf(id);
    expect(infoVersion(row.document)).toBe("1.0.0_snapshot");
    expect(infoVersion(row.resolvedSpec)).toBe("1.0.0_snapshot");

    const stored = unwrap(await emitEventStoredVersion(id, sc.product.id, "1.0.0_snapshot", ctx));
    expect(infoVersion(stored.document)).toBe("1.0.0_snapshot");
    expect(codeOf(await emitEventStoredVersion(id, sc.product.id, "1.0.0", ctx))).toBe("NOT_FOUND");
  });

  it("save → save → promote yields one RELEASED 1.0.0 whose stored documents read 1.0.0", async () => {
    const sc = await scope();
    const order = await sc.entity("Order");
    const id = await sc.event(sc.document(order));

    const first = unwrap(await sc.save(id));
    expect((await eventRow(id)).latestVersionId).toBe(first.id); // no release yet: the pointer is the snapshot
    expect((await eventRow(id)).hasUnpublishedChanges).toBe(false);

    const again = await sc.save(id);
    expect(codeOf(again)).toBe("PUBLISH_BLOCKED");
    expect(!again.success && again.error.message).toBe("No unsaved changes since v1.0.0_snapshot.");

    await sc.edit(id, sc.document(order, "Orders, documented"));
    const second = unwrap(await sc.save(id));
    expect(second).toMatchObject({ id: first.id, sequence: first.sequence, label: "1.0.0_snapshot" }); // updated in place
    const [updated] = await versionsOf(id);
    expect(obj(updated.sourceDocument).info).toMatchObject({ description: "Orders, documented" });
    expect(await versionsOf(id)).toHaveLength(1);

    const promoted = unwrap(await sc.promote(id));
    expect(promoted).toMatchObject({ id: first.id, label: "1.0.0", stage: "RELEASED" });
    expect(promoted.releasedAt).not.toBeNull();
    const rows = await versionsOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: "RELEASED", releasedById: ctx.userId });
    expect(infoVersion(rows[0].document)).toBe("1.0.0");
    expect(infoVersion(rows[0].resolvedSpec)).toBe("1.0.0");
    expect(obj(rows[0].sourceDocument).info).toMatchObject({ description: "Orders, documented" }); // the rest of the row is what was saved
    expect((await eventRow(id)).latestVersionId).toBe(first.id);
    const emitted = unwrap(await emitEventStoredVersion(id, sc.product.id, "1.0.0", ctx));
    expect(infoVersion(emitted.document)).toBe("1.0.0");

    const audit = await prisma().auditLog.findMany({ where: { entityId: id, action: "PROMOTE_VERSION" } });
    expect(audit).toHaveLength(1);

    expect(codeOf(await sc.promote(id))).toBe("NO_SNAPSHOT");
    await expect(prisma().eventSpecVersion.update({ where: { id: first.id }, data: { changeSummary: "x" } })).rejects.toThrow();
  });

  it("a save after the release creates 1.1.0_snapshot (latestVersionId stays on 1.0.0), raised in place by MAJOR; promote moves the pointer", async () => {
    const sc = await scope();
    const order = await sc.entity("Order");
    const id = await sc.event(sc.document(order));
    unwrap(await sc.save(id));
    const release = unwrap(await sc.promote(id));
    const releasedRow = (await versionsOf(id))[0];

    await sc.edit(id, sc.document(order, "documented"));
    const preview = unwrap(await previewEventPublish(id, sc.product.id, ctx, deps));
    expect(preview).toMatchObject({ latestLabel: "1.0.0", openSnapshotLabel: null, suggestedBump: "PATCH" });
    expect(preview.candidateLabels).toEqual({ MAJOR: "2.0.0_snapshot", MINOR: "1.1.0_snapshot", PATCH: "1.0.1_snapshot" });

    const snap = unwrap(await sc.save(id, "MINOR"));
    expect(snap).toMatchObject({ label: "1.1.0_snapshot", stage: "SNAPSHOT", sequence: 2 });
    expect((await eventRow(id)).latestVersionId).toBe(release.id);

    await sc.edit(id, sc.document(order, "documented again"));
    const raised = unwrap(await sc.save(id, "MAJOR"));
    expect(raised).toMatchObject({ id: snap.id, label: "2.0.0_snapshot", sequence: 2 });
    const rows = await versionsOf(id);
    expect(rows.filter((r) => r.stage === "SNAPSHOT")).toHaveLength(1);
    expect(rows[0]).toEqual(releasedRow); // the release is untouched
    expect(infoVersion(rows[1].document)).toBe("2.0.0_snapshot");

    const list = unwrap(await listEventVersions(id, sc.product.id, ctx));
    expect(list.map((v) => v.label)).toEqual(["2.0.0_snapshot", "1.0.0"]);

    const promoted = unwrap(await sc.promote(id));
    expect(promoted.label).toBe("2.0.0");
    expect((await eventRow(id)).latestVersionId).toBe(snap.id);
    expect(infoVersion((await versionsOf(id))[1].document)).toBe("2.0.0");
  });

  it("promote refuses a draft that is not saved (DRAFT_NOT_SAVED) and leaves the snapshot open", async () => {
    const sc = await scope();
    const order = await sc.entity("Order");
    const id = await sc.event(sc.document(order));
    unwrap(await sc.save(id));
    await sc.edit(id, sc.document(order, "unsaved"));
    expect(codeOf(await sc.promote(id))).toBe("DRAFT_NOT_SAVED");
    expect((await versionsOf(id))[0].stage).toBe("SNAPSHOT");
  });

  it("promote refuses a snapshot pinning an entity snapshot (SNAPSHOT_REFERENCES, naming it) until the entity is released", async () => {
    const sc = await scope();
    const customer = await sc.entity("Customer", "SNAPSHOT");
    const id = await sc.event(sc.document(customer));
    unwrap(await sc.save(id));

    const refused = await sc.promote(id);
    expect(codeOf(refused)).toBe("SNAPSHOT_REFERENCES");
    expect(!refused.success && refused.error.message).toContain("Customer");
    expect((await versionsOf(id))[0].stage).toBe("SNAPSHOT");

    await releaseEntityVersion(customer.versionId);
    expect(unwrap(await sc.promote(id)).label).toBe("1.0.0");
  });

  it("promote refuses a snapshot whose pinned entity snapshot was saved again after it; saving the event again resolves it", async () => {
    const sc = await scope();
    const customer = await sc.entity("Customer", "SNAPSHOT");
    const id = await sc.event(sc.document(customer));
    unwrap(await sc.save(id));
    // the entity's snapshot is saved again in place (new content, same row), then released
    await new Promise((resolve) => setTimeout(resolve, 20));
    await prisma().entityVersion.update({ where: { id: customer.versionId }, data: { publishedAt: new Date() } });
    await releaseEntityVersion(customer.versionId);

    expect(codeOf(await sc.promote(id))).toBe("SNAPSHOT_REFERENCES");
    // the snapshot no longer holds what it pins: a save is possible without editing the draft, and then the promote goes through
    unwrap(await sc.save(id));
    expect(unwrap(await sc.promote(id)).label).toBe("1.0.0");
  });

  it("promote refuses a snapshot that references another event's snapshot through an external ref, naming that event", async () => {
    const sc = await scope();
    const order = await sc.entity("Order");
    const sourceId = await sc.event(sc.document(order));
    const source = unwrap(await sc.save(sourceId));
    const sourceName = (await prisma().eventSpec.findUniqueOrThrow({ where: { id: sourceId } })).name;

    const doc: EventDocument = {
      ...emptyEventDocument("fraud-scorer"),
      servers: [{ key: "kafka-in", protocol: "kafka", host: "kafka-in.internal:9092" }],
      channels: [{ key: "inbox", address: "fraud.inbox.v1", protocol: "kafka", serverKeys: ["kafka-in"], format: "avro", messageKeys: ["payment-received"] }],
      externalRefs: [{ key: "payment-received", eventVersionId: source.id, kind: "message", itemKey: "order-created" }],
      operations: [{ key: "consumePayment", action: "receive", channelKey: "inbox", messageKeys: ["payment-received"], traitKeys: [] }],
    };
    const id = await sc.event(doc);
    unwrap(await sc.save(id));

    const refused = await sc.promote(id);
    expect(codeOf(refused)).toBe("SNAPSHOT_REFERENCES");
    expect(!refused.success && refused.error.message).toContain(sourceName);

    unwrap(await sc.promote(sourceId));
    expect(unwrap(await sc.promote(id)).label).toBe("1.0.0");
  });
});
