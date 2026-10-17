import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";
import type { FrozenTrait } from "@/lib/events/types";
import type { EventSnapshot } from "@/services/events/event-snapshot";
import { gatherPublishFacts } from "@/services/events/event-publish-facts";

// `gatherPublishFacts` reads the version rows and their entities in two queries (Prisma loads the relation of a `select` in a second one),
// so an entity deleted between the two leaves a version row whose `entity` is null. A fake `db` returns exactly that row.

type VersionRow = { id: string; entityId: string; major: number; minor: number; entity: { name: string } | null };

const pin = (entityId: string, entityVersionId: string | null) => ({ entityId, entityVersionId });

const documentWithPayload = (): EventDocument => ({
  ...emptyEventDocument("orders"),
  channels: [{ key: "orders", address: "orders", protocol: "kafka", serverKeys: [], format: "json-schema", messageKeys: ["OrderCreated"] }],
  messages: [{ key: "OrderCreated", payload: pin("ent-order", "ver-order"), traitKeys: [] }],
  operations: [{ key: "publishOrderCreated", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: [] }],
});

const snapshotOf = (document: EventDocument, latest: EventSnapshot["latest"] = null): EventSnapshot => ({
  event: { id: "ev-1", name: "orders", tenantId: "tenant-1", domainId: "dom-1", productId: "prod-1", productSlug: "prod", specType: "ASYNCAPI" },
  document, latest, libraryTraits: new Map(), external: new Map(), externalMajors: {}, entityFormats: new Map(),
});

/** Only what the facts read: version rows (as given), entity names, and nothing else. */
function fakeDb(versions: VersionRow[], entities: Array<{ id: string; name: string }> = []): PrismaClient {
  return {
    entityVersion: { findMany: async () => versions },
    entity: { findMany: async () => entities },
    trait: { findMany: async () => [] },
    eventSpecVersion: { findMany: async () => [] },
  } as unknown as PrismaClient;
}

describe("gatherPublishFacts: a version whose entity was deleted between the two reads", () => {
  it("is a MISSING_ENTITY blocker, never a TypeError", async () => {
    const db = fakeDb([{ id: "ver-order", entityId: "ent-order", major: 1, minor: 0, entity: null }], [{ id: "ent-order", name: "Order" }]);
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
    const db = fakeDb([{ id: "ver-order", entityId: "ent-order", major: 1, minor: 2, entity: { name: "Order" } }], [{ id: "ent-order", name: "Order" }]);
    const facts = await gatherPublishFacts(db, snapshotOf(documentWithPayload()));
    if (!facts.success) throw new Error(facts.error.message);
    expect(facts.data.blockers).toEqual([]);
    expect(facts.data.current.pins).toEqual({ "ver-order": { entityId: "ent-order", entityName: "Order", label: "1.2", major: 1 } });
  });

  it("leaves a frozen library trait's headers pin unknown (no major, no label), never a TypeError", async () => {
    const document = documentWithPayload();
    const frozen: FrozenTrait = {
      id: "trait-1", name: "Audit", kind: "MESSAGE", ownerSlug: "acme", spec: {}, headersEntityId: "ent-headers", headersEntityVersionId: "ver-headers",
    };
    const latest: EventSnapshot["latest"] = {
      id: "v-1", major: 1, minor: 0, sequence: 1, sourceDocument: document, resolvedSpec: {}, frozenTraits: [frozen], compatReport: null,
    };
    const db = fakeDb([
      { id: "ver-order", entityId: "ent-order", major: 1, minor: 0, entity: { name: "Order" } },
      { id: "ver-headers", entityId: "ent-headers", major: 3, minor: 1, entity: null },
    ], [{ id: "ent-order", name: "Order" }]);
    const facts = await gatherPublishFacts(db, snapshotOf(document, latest));
    if (!facts.success) throw new Error(facts.error.message);
    expect(facts.data.previous?.libraryHeaders["trait-1"]).toEqual({
      entityId: "ent-headers", entityVersionId: "ver-headers", major: null, label: null,
    });
    expect(facts.data.blockers).toEqual([]);
  });
});
