import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";
import type { FrozenTrait } from "@/lib/events/types";
import type { EventSnapshot } from "@/services/events/event-snapshot";
import { gatherPublishFacts } from "@/services/events/event-publish-facts";

// `gatherPublishFacts` reads the version rows and their entities in two queries (Prisma loads the relation of a `select` in a second one),
// so an entity deleted between the two leaves a version row whose `entity` is null. A fake `db` returns exactly that row.

type VersionRow = {
  id: string; entityId: string; major: number; minor: number; patch: number; stage?: "RELEASED" | "SNAPSHOT"; publishedAt?: Date; entity: { name: string } | null;
};

const pin = (entityId: string, entityVersionId: string | null) => ({ entityId, entityVersionId });

const documentWithPayload = (): EventDocument => ({
  ...emptyEventDocument("orders"),
  channels: [{ key: "orders", address: "orders", protocol: "kafka", serverKeys: [], format: "json-schema", messageKeys: ["OrderCreated"] }],
  messages: [{ key: "OrderCreated", payload: pin("ent-order", "ver-order"), traitKeys: [] }],
  operations: [{ key: "publishOrderCreated", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: [] }],
});

const snapshotOf = (
  document: EventDocument, latestRelease: EventSnapshot["latestRelease"] = null, openSnapshot: EventSnapshot["openSnapshot"] = null
): EventSnapshot => ({
  event: { id: "ev-1", name: "orders", tenantId: "tenant-1", domainId: "dom-1", productId: "prod-1", productSlug: "prod", specType: "ASYNCAPI" },
  document, latestRelease, openSnapshot, libraryTraits: new Map(), external: new Map(), externalMajors: {}, entityFormats: new Map(),
});
const AT = new Date("2026-11-01T10:00:00.000Z");

/** Only what the facts read: version rows (as given), entity names, and nothing else. */
function fakeDb(versions: VersionRow[], entities: Array<{ id: string; name: string }> = []): PrismaClient {
  return {
    entityVersion: { findMany: async () => versions.map((v) => ({ stage: "RELEASED", publishedAt: AT, ...v })) },
    entity: { findMany: async () => entities },
    trait: { findMany: async () => [] },
    eventSpecVersion: { findMany: async () => [] },
  } as unknown as PrismaClient;
}

describe("gatherPublishFacts: a version whose entity was deleted between the two reads", () => {
  it("is a MISSING_ENTITY blocker, never a TypeError", async () => {
    const db = fakeDb([{ id: "ver-order", entityId: "ent-order", major: 1, minor: 0, patch: 0, entity: null }], [{ id: "ent-order", name: "Order" }]);
    const facts = await gatherPublishFacts(db, snapshotOf(documentWithPayload()));
    if (!facts.success) throw new Error(facts.error.message);
    expect(facts.data.blockers).toEqual([
      { kind: "MISSING_ENTITY", pointer: "/messages/0/payload", message: '"ver-order" is not a published version of Order' },
    ]);
    // the version resolves to nothing: the bump has no fact for it, so it cannot be classified yet
    expect(facts.data.current.pins).toEqual({});
    expect(facts.data.classifiable).toBe(false);
  });

  it("still resolves the same version while its entity is there", async () => {
    const db = fakeDb([{ id: "ver-order", entityId: "ent-order", major: 1, minor: 2, patch: 0, entity: { name: "Order" } }], [{ id: "ent-order", name: "Order" }]);
    const facts = await gatherPublishFacts(db, snapshotOf(documentWithPayload()));
    if (!facts.success) throw new Error(facts.error.message);
    expect(facts.data.blockers).toEqual([]);
    expect(facts.data.current.pins).toEqual({ "ver-order": { entityId: "ent-order", entityName: "Order", label: "1.2.0", major: 1 } });
  });

  it("leaves a frozen library trait's headers pin unknown (no major, no label), never a TypeError", async () => {
    const document = documentWithPayload();
    const frozen: FrozenTrait = {
      id: "trait-1", name: "Audit", kind: "MESSAGE", ownerSlug: "acme", spec: {}, headersEntityId: "ent-headers", headersEntityVersionId: "ver-headers",
    };
    const latest: EventSnapshot["latestRelease"] = {
      id: "v-1", major: 1, minor: 0, patch: 0, sequence: 1, sourceDocument: document, resolvedSpec: {}, frozenTraits: [frozen], compatReport: null,
      publishedAt: AT, updatedAt: AT,
    };
    const db = fakeDb([
      { id: "ver-order", entityId: "ent-order", major: 1, minor: 0, patch: 0, entity: { name: "Order" } },
      { id: "ver-headers", entityId: "ent-headers", major: 3, minor: 1, patch: 0, entity: null },
    ], [{ id: "ent-order", name: "Order" }]);
    const facts = await gatherPublishFacts(db, snapshotOf(document, latest));
    if (!facts.success) throw new Error(facts.error.message);
    expect(facts.data.previous?.libraryHeaders["trait-1"]).toEqual({
      entityId: "ent-headers", entityVersionId: "ver-headers", major: null, label: null,
    });
    expect(facts.data.blockers).toEqual([]);
  });
});

describe("gatherPublishFacts: the open snapshot and the latest release", () => {
  const stored = (id: string, document: EventDocument, n: { major: number; minor: number; sequence: number }) => ({
    id, ...n, patch: 0, sourceDocument: document, resolvedSpec: {}, frozenTraits: [], compatReport: null, publishedAt: AT, updatedAt: AT,
  });
  const order = { id: "ver-order", entityId: "ent-order", major: 1, minor: 0, patch: 0, entity: { name: "Order" } };

  it("compares the draft with the open snapshot (NO_CHANGES), but classifies the bump against the latest release", async () => {
    const released = { ...documentWithPayload(), info: { ...documentWithPayload().info, description: "v1" } };
    const draft = documentWithPayload();
    const db = fakeDb([order], [{ id: "ent-order", name: "Order" }]);
    const facts = await gatherPublishFacts(
      db, snapshotOf(draft, stored("rel", released, { major: 1, minor: 0, sequence: 1 }), stored("snap", draft, { major: 1, minor: 1, sequence: 2 }))
    );
    if (!facts.success) throw new Error(facts.error.message);
    expect(facts.data.hasChanges).toBe(false); // the draft is exactly what the snapshot holds
    expect(facts.data.previous?.doc).toEqual(released); // the bump side is the release
    expect(facts.data.latestRelease).toEqual({ id: "rel", major: 1, minor: 0, patch: 0, sequence: 1 });
    expect(facts.data.openSnapshot).toEqual({ id: "snap", major: 1, minor: 1, patch: 0, sequence: 2 });
  });

  it("a draft equal to the release but not to the open snapshot has changes to save", async () => {
    const released = documentWithPayload();
    const snap = { ...released, info: { ...released.info, description: "edited" } };
    const db = fakeDb([order], [{ id: "ent-order", name: "Order" }]);
    const facts = await gatherPublishFacts(
      db, snapshotOf(released, stored("rel", released, { major: 1, minor: 0, sequence: 1 }), stored("snap", snap, { major: 1, minor: 0, sequence: 2 }))
    );
    if (!facts.success) throw new Error(facts.error.message);
    expect(facts.data.hasChanges).toBe(true);
  });

  it("a pinned version saved again after the open snapshot was saved is a change (the snapshot no longer holds what it pins)", async () => {
    const draft = documentWithPayload();
    const later = new Date(AT.getTime() + 60_000);
    const db = fakeDb([{ ...order, stage: "SNAPSHOT", publishedAt: later }], [{ id: "ent-order", name: "Order" }]);
    const facts = await gatherPublishFacts(db, snapshotOf(draft, null, stored("snap", draft, { major: 1, minor: 0, sequence: 1 })));
    if (!facts.success) throw new Error(facts.error.message);
    expect(facts.data.hasChanges).toBe(true);
    // a snapshot pin is labelled as one
    expect(facts.data.current.pins["ver-order"]).toMatchObject({ label: "1.0.0_snapshot" });
  });
});
