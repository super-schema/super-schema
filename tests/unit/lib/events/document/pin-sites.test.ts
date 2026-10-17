import { describe, expect, it } from "vitest";
import { collectDocumentEdges, collectPinSites } from "@/lib/events/document/edges";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";

const doc = (): EventDocument => ({
  ...emptyEventDocument("t"),
  messages: [
    { key: "A", payload: { entityId: "e1", entityVersionId: "v1" }, headers: { entityId: "e2", entityVersionId: "v2" }, keyPin: { entityId: "e3", entityVersionId: null }, traitKeys: ["T"] },
    { key: "B", payload: { entityId: "e1", entityVersionId: "v1" }, traitKeys: [] },
  ],
  traits: [
    { key: "T", kind: "MESSAGE", spec: {}, headers: { entityId: "e4", entityVersionId: "v4" } },
    { key: "NoHeaders", kind: "MESSAGE", spec: { summary: "inline only" } },
    { key: "L", kind: "MESSAGE", libraryTraitId: "lib-9" },
  ],
});

describe("collectPinSites", () => {
  it("returns payload, headers, keyPin and local-trait headers with their JSON pointers, in document order", () => {
    expect(collectPinSites(doc()).map(({ pointer, pin }) => ({ pointer, pin }))).toEqual([
      { pointer: "/messages/0/payload", pin: { entityId: "e1", entityVersionId: "v1" } },
      { pointer: "/messages/0/headers", pin: { entityId: "e2", entityVersionId: "v2" } },
      { pointer: "/messages/0/keyPin", pin: { entityId: "e3", entityVersionId: null } },
      { pointer: "/messages/1/payload", pin: { entityId: "e1", entityVersionId: "v1" } },
      { pointer: "/traits/0/headers", pin: { entityId: "e4", entityVersionId: "v4" } },
    ]);
  });

  it("skips library traits and local traits without a headers pin", () => {
    const pointers = collectPinSites(doc()).map((s) => s.pointer);
    expect(pointers).not.toContain("/traits/1/headers");
    expect(pointers.some((p) => p.startsWith("/traits/2"))).toBe(false);
  });

  it("is empty for the empty document", () => {
    expect(collectPinSites(emptyEventDocument("t"))).toEqual([]);
  });

  it("is the one source of the edge roles: the same sites produce collectDocumentEdges", () => {
    const sites = collectPinSites(doc());
    expect(sites.map((s) => s.role)).toEqual(["PAYLOAD", "HEADERS", "KEY", "PAYLOAD", "HEADERS"]);
    const pinnedIds = sites.flatMap((s) => (s.pin.entityVersionId ? [s.pin.entityVersionId] : []));
    expect(new Set(collectDocumentEdges(doc()).map((e) => e.toId))).toEqual(new Set(pinnedIds));
  });
});
