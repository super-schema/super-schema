import { describe, expect, it } from "vitest";
import { collectDocumentEdges, collectDocumentRefs } from "@/lib/events/document/edges";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";
import type { ReferenceEdge } from "@/services/events/schema-references";

const doc = (): EventDocument => ({
  ...emptyEventDocument("t"),
  messages: [
    { key: "A", payload: { entityId: "e1", entityVersionId: "v1" }, headers: { entityId: "e2", entityVersionId: "v2" }, keyPin: { entityId: "e3", entityVersionId: null }, traitKeys: ["T"] },
    { key: "B", payload: { entityId: "e1", entityVersionId: "v1" }, traitKeys: [] },
  ],
  traits: [
    { key: "T", kind: "MESSAGE", spec: {}, headers: { entityId: "e4", entityVersionId: "v4" } },
    { key: "L", kind: "OPERATION", libraryTraitId: "lib-9" },
  ],
  externalRefs: [{ key: "x", eventVersionId: "ev-7", kind: "message", itemKey: "M" }],
});

describe("collectDocumentEdges", () => {
  it("emits pinned edges, trait header edges and external-ref edges, deduplicated and sorted", () => {
    expect(collectDocumentEdges(doc())).toEqual([
      { role: "HEADERS", toKind: "ENTITY_VERSION", toId: "v2" },
      { role: "HEADERS", toKind: "ENTITY_VERSION", toId: "v4" },
      { role: "MESSAGE", toKind: "EVENT_SPEC_VERSION", toId: "ev-7" },
      { role: "PAYLOAD", toKind: "ENTITY_VERSION", toId: "v1" },
    ]);
  });
  it("creates no edge for an unpinned pin", () => {
    expect(collectDocumentEdges(doc()).some((e) => e.role === "KEY")).toBe(false);
  });
  it("is empty for the empty document", () => {
    expect(collectDocumentEdges(emptyEventDocument("t"))).toEqual([]);
  });
  it("is structurally assignable to the service's ReferenceEdge (fails tsc on enum drift)", () => {
    const edges: ReferenceEdge[] = collectDocumentEdges(doc());
    expect(edges).toHaveLength(4);
  });
});

describe("collectDocumentRefs", () => {
  it("lists entities, versions, unpinned pins, library traits and external versions", () => {
    expect(collectDocumentRefs(doc())).toEqual({
      entityIds: ["e1", "e2", "e3", "e4"],
      pinnedVersionIds: ["v1", "v2", "v4"],
      unpinned: [{ pointer: "/messages/0/keyPin", entityId: "e3" }],
      libraryTraitIds: ["lib-9"],
      externalVersionIds: ["ev-7"],
    });
  });
});
