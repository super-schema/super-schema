import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/db", () => ({ prisma: {} }));
import { MAX_DOCUMENT_DEPTH } from "@/lib/event-specs/serialize";
import type { JsonObject } from "@/lib/event-specs/types";
import { parseEventDocument } from "@/lib/events/document/parse";
import { emptyEventDocument } from "@/lib/events/document/types";
import { documentSaveProblem, updateEventDocument } from "@/services/events/event.service";

/** `levels` single-key objects chained by `next`, ending in `{}`: the shape only depth makes expensive. */
function deepChain(levels: number): JsonObject {
  let node: JsonObject = {};
  for (let level = 0; level < levels; level++) node = { next: node };
  return node;
}

/** A document whose one message carries `bindings`: the binding object sits four levels down (document, messages, the message, bindings). */
function documentWithMessageBindings(bindings: JsonObject) {
  return {
    ...emptyEventDocument("checkout"),
    messages: [{ key: "order-created", payload: { entityId: "E1", entityVersionId: null }, bindings }],
  };
}

describe("saving an event document: the emission bounds apply to what the user stores", () => {
  it("refuses a document whose binding nests past the emission depth, before any read or write", async () => {
    const doc = documentWithMessageBindings(deepChain(300));
    // the context has no database: a refusal must come before the event is looked up
    const out = await updateEventDocument("event-1", doc, { level: "PRODUCT", productId: "product-1" } as never, { prisma: {} } as never);

    expect(out.success).toBe(false);
    if (out.success) return;
    expect(out.error.code).toBe("VALIDATION_ERROR");
    expect(out.error.message).toMatch(/cannot be saved: it nests more than \d+ levels/);
  });

  it("accepts a message binding that the assembler can still emit, and refuses one a level deeper", () => {
    // A message's bindings are emitted under components, one level deeper than they are stored: the stored depth bound is one lower.
    const deepestStoredAt = (levels: number) => {
      const parsed = parseEventDocument(documentWithMessageBindings(deepChain(levels - 4)));
      if (!parsed.success) throw new Error(`fixture is not a valid document: ${JSON.stringify(parsed.error.details)}`);
      return documentSaveProblem(parsed.data);
    };

    // the innermost object of the binding is at depth `levels`; emitted, it is one deeper
    expect(deepestStoredAt(MAX_DOCUMENT_DEPTH - 1)).toBeNull();
    expect(deepestStoredAt(MAX_DOCUMENT_DEPTH)).toMatch(/nests more than 63 levels/);
  });
});
