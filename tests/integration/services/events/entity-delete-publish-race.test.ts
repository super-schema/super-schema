import "dotenv/config"; // first: @/lib/db (pulled in by the services) reads DB_PROVIDER at import time
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { PayloadFormat, SchemaArtifact } from "@/lib/event-specs/types";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";
import type { EntityPin } from "@/lib/events/types";
import { err, ok, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

const { access, hook } = vi.hoisted(() => ({
  access: { userId: "" },
  hook: { afterReferrerRead: undefined as undefined | (() => Promise<void>) },
}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { id: access.userId } })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: async () => "tenant_default" }));
// The race made deterministic: the delete's event-referrer read is the last thing it does before it deletes. `hook.afterReferrerRead`
// runs once, right after that read returned (so the delete has decided "no event holds this entity") and before the delete runs.
vi.mock("@/services/events/event-guards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/events/event-guards")>();
  return {
    ...actual,
    findEntityEventReferrers: async (...args: Parameters<typeof actual.findEntityEventReferrers>) => {
      const found = await actual.findEntityEventReferrers(...args);
      const run = hook.afterReferrerRead;
      hook.afterReferrerRead = undefined;
      await run?.();
      return found;
    },
  };
});

import { deleteEntityAction } from "@/app/(dashboard)/schemas/[domainSlug]/actions";
import { deleteEntity } from "@/services/entity.service";
import type { ArtifactRenderer } from "@/services/events/artifact-renderer";
import { publishEvent } from "@/services/events/event-publish.service";
import { createEvent, updateEventDocument } from "@/services/events/event.service";
import { cleanupDomains, connectTestDb, createProductScope, stamp, testContext } from "./helpers";

/**
 * Entity delete against event publish (W2-B1). The delete's guard (does any event hold this entity?) and its delete used to be two
 * unrelated statements, so a publish that committed between them left a PUBLISHED pin on a deleted entity. Both now run in one
 * transaction that first locks the entity row FOR UPDATE; publish holds the pinned entity FOR SHARE until it commits. Whichever
 * takes the row first wins: a delete that went first removes the entity before the publish's lock is granted (the publish's
 * re-verification then fails with CONFLICT); a publish that went first has committed its published edge before the delete's guard reads.
 *
 * The invariant checked everywhere below: a published version never pins an entity that is gone.
 */
let prisma: PrismaClient;
let ctx: ServiceContext;
let scope: Awaited<ReturnType<typeof createProductScope>>;
let owner: { level: "PRODUCT"; productId: string };

const modelNames = new Map<string, string>();
const avro = (name: string): SchemaArtifact => ({ format: "avro", schema: { type: "record", name, fields: [{ name: "id", type: "string" }] } });
/** Renders every known entity version as a tiny Avro record; never consults the database. */
const renderer: ArtifactRenderer = {
  async render(subject, format: PayloadFormat) {
    const id = subject.kind === "version" ? subject.entityVersionId : subject.entityId;
    const name = modelNames.get(id);
    return name ? ok({ artifact: avro(name), warnings: [] }) : err({ code: "NOT_FOUND", message: `no stub for ${id} (${format})` });
  },
};

interface Versioned { entityId: string; versionId: string; name: string }
async function publishedEntity(label: string): Promise<Versioned> {
  const name = `${label}${stamp().replace(/[^a-z0-9]/gi, "")}`;
  const entity = await scope.entity(name);
  const row = await prisma.entityVersion.create({
    data: {
      entityId: entity.id, major: 1, minor: 0, sequence: 1, changeKind: "INITIAL", publishedById: ctx.userId,
      resolvedSource: `model ${name} {\n  id: string;\n}\n`, fieldSnapshot: [{ name: "id", fieldNumber: 1 }],
    },
  });
  modelNames.set(entity.id, name);
  modelNames.set(row.id, name);
  return { entityId: entity.id, versionId: row.id, name };
}
const pinTo = (e: Versioned): EntityPin => ({ entityId: e.entityId, entityVersionId: e.versionId });

/** A complete, valid v2 document: one Kafka/Avro channel, one message pinned to `payload`, one send operation. */
function documentFor(payload: EntityPin): EventDocument {
  return {
    ...emptyEventDocument("race-service"),
    servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" }],
    channels: [{ key: "orders", address: "payments.orders.v1", protocol: "kafka", serverKeys: ["kafka-prod"], format: "avro", messageKeys: ["order-created"] }],
    messages: [{ key: "order-created", contentType: "avro/binary", payload, traitKeys: [] }],
    traits: [],
    operations: [{ key: "publishOrderCreated", action: "send", channelKey: "orders", messageKeys: ["order-created"], traitKeys: [] }],
  };
}

async function draftEvent(payload: EntityPin): Promise<string> {
  const created = await createEvent(scope.product.id, { name: `evt-${stamp()}` }, ctx);
  if (!created.success) throw new Error(created.error.message);
  const saved = await updateEventDocument(created.data.id, documentFor(payload), owner, ctx);
  if (!saved.success) throw new Error(saved.error.message);
  return created.data.id;
}
/** The draft saved with `payload`, then published: the failure of whichever step failed first. */
async function saveThenPublish(eventId: string, payload: EntityPin): Promise<Result<unknown>> {
  const saved = await updateEventDocument(eventId, documentFor(payload), owner, ctx);
  if (!saved.success) return saved;
  return publishEvent(eventId, scope.product.id, {}, ctx, { renderer });
}

const entityExists = async (id: string) => (await prisma.entity.count({ where: { id } })) === 1;
const codeOf = (r: Result<unknown>) => (r.success ? "ok" : r.error.code);

/** Resolves when `p` settled, or when some backend waits on a `FOR SHARE` row lock (the publish queued behind the delete). */
async function settledOrBlocked(p: Promise<unknown>, timeoutMs = 10_000): Promise<void> {
  let settled = false;
  void p.then(() => { settled = true; }, () => { settled = true; });
  const deadline = Date.now() + timeoutMs;
  while (!settled && Date.now() < deadline) {
    const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FOR SHARE%'`;
    if (n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** What the database says afterwards: is the entity gone, and does any published version of the event still pin it? */
async function pinsAfterwards(entity: Versioned, eventId: string) {
  const versions = await prisma.eventSpecVersion.findMany({ where: { eventSpecId: eventId }, select: { id: true, sourceDocument: true } });
  const publishedPin = versions.filter((v) => JSON.stringify(v.sourceDocument).includes(entity.entityId));
  const publishedEdges = await prisma.schemaReference.count({
    where: { fromKind: "EVENT_SPEC_VERSION", fromId: { in: versions.map((v) => v.id) }, toKind: "ENTITY_VERSION", toId: entity.versionId },
  });
  return { gone: !(await entityExists(entity.entityId)), versions: versions.length, publishedPins: publishedPin.length, publishedEdges };
}

beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
  access.userId = ctx.userId;
  scope = await createProductScope(prisma, ctx, "race");
  owner = { level: "PRODUCT", productId: scope.product.id };
}, 120_000);

afterAll(async () => {
  await cleanupDomains(prisma, [scope?.domain.id]);
  await prisma.$disconnect();
});

const deletes = {
  "deleteEntity (service)": async (id: string) => (await deleteEntity(id, ctx)).success,
  "deleteEntityAction (the UI's delete)": async (id: string) => "success" in (await deleteEntityAction(id)),
} as const;

describe.each(Object.entries(deletes))("%s against a concurrent publish", (_name, remove) => {
  it("a pin that lands after the delete's guard read is never published onto the deleted entity (deterministic interleaving)", async () => {
    const base = await publishedEntity("Base");
    const target = await publishedEntity("Target");
    const eventId = await draftEvent(pinTo(base)); // the draft does not name `target` yet: the delete's guard will find nothing

    // After the guard decided "nothing holds it": the draft gets pinned to the target and is published. A publish that does not
    // wait for the delete finishes right here; one that is queued behind the delete's row lock cannot, so do not wait for it.
    let publishing: Promise<Result<unknown>> | undefined;
    hook.afterReferrerRead = async () => {
      publishing = saveThenPublish(eventId, pinTo(target));
      await settledOrBlocked(publishing);
    };

    const deleted = await remove(target.entityId);
    const published = await publishing!;

    const after = await pinsAfterwards(target, eventId);
    // the invariant: never both a published version and a deleted entity
    expect(deleted && published.success).toBe(false);
    expect(after.gone && after.publishedPins > 0).toBe(false);
    expect(after.gone && after.publishedEdges > 0).toBe(false);
    // the guard ran first and found nothing, and the delete holds the row: the delete wins, the publish is the one that fails
    expect(deleted).toBe(true);
    expect(after.gone).toBe(true);
    expect(codeOf(published)).toBe("CONFLICT");
    expect(after.versions).toBe(0);
  }, 60_000);

  it("rounds of a pin landing while the delete runs: whatever the order, the delete and the publish never both succeed", async () => {
    for (let round = 0; round < 6; round += 1) {
      const base = await publishedEntity("Base");
      const target = await publishedEntity("Target");
      const eventId = await draftEvent(pinTo(base));

      const [deleted, published] = await Promise.all([remove(target.entityId), saveThenPublish(eventId, pinTo(target))]);

      const after = await pinsAfterwards(target, eventId);
      expect(deleted && published.success).toBe(false);
      expect(after.gone && (after.publishedPins > 0 || after.publishedEdges > 0)).toBe(false);
      if (deleted) {
        expect(after.gone).toBe(true);
        expect(["CONFLICT", "PUBLISH_BLOCKED", "VALIDATION_ERROR"]).toContain(codeOf(published)); // the pin vanished under the publish / the save
        expect(after.versions).toBe(0);
      } else {
        expect(after.gone).toBe(false);
        expect(published.success).toBe(true); // the publish got the row first: its published edge blocks the delete
        expect(after.publishedPins).toBe(1);
      }
    }
  }, 180_000);

  it("a draft that already pins the entity keeps it alive: the delete is IN_USE whenever it runs, and the publish is unaffected", async () => {
    for (let round = 0; round < 3; round += 1) {
      const target = await publishedEntity("Target");
      const eventId = await draftEvent(pinTo(target));

      const [deleted, published] = await Promise.all([remove(target.entityId), publishEvent(eventId, scope.product.id, {}, ctx, { renderer })]);

      expect(deleted).toBe(false);
      expect(published.success).toBe(true);
      const after = await pinsAfterwards(target, eventId);
      expect(after).toMatchObject({ gone: false, versions: 1, publishedPins: 1, publishedEdges: 1 });
    }
  }, 120_000);
});
