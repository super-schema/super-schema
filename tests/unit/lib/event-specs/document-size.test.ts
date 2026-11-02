import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/event-specs/serialize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/event-specs/serialize")>();
  return { ...actual, toJson: vi.fn(actual.toJson), toYaml: vi.fn(actual.toYaml) };
});
import { AsyncApi3Adapter } from "@/lib/event-specs/adapter";
import { assembleAsyncApi3 } from "@/lib/event-specs/assemble";
import { emitEventStoredVersion } from "@/services/events/event-emit.service";
import { MAX_DOCUMENT_DEPTH, MAX_DOCUMENT_VALUES, documentSizeProblem, toJson, toYaml } from "@/lib/event-specs/serialize";
import type { JsonObject } from "@/lib/event-specs/types";
import { checkoutServiceSpec } from "./fixtures/worked-example";
import { message, operation, spec } from "./fixtures/builders";

/** `depth` single-key objects chained by `next`, ending in `deepest`: the shape only depth makes expensive. */
function deepChain(depth: number, deepest: JsonObject): JsonObject {
  let node: JsonObject = deepest;
  for (let level = 0; level < depth; level++) node = { next: node };
  return node;
}

/** A binding whose values are `count` numbers spread over arrays of 1,000. */
function wideBinding(count: number): JsonObject {
  const items: number[][] = [];
  for (let start = 0; start < count; start += 1000) items.push(Array.from({ length: Math.min(1000, count - start) }, (_, i) => start + i));
  return { items };
}

/** The checkout example with `bindings` on its one message, emitted through the adapter. */
function specWithMessageBindings(bindings: JsonObject) {
  return spec({
    channels: checkoutServiceSpec.channels,
    messages: [message({ id: "m", name: "M", bindings })],
    operations: [operation({ key: "o", channelRef: checkoutServiceSpec.channels[0].id, messageRefs: ["m"] })],
  });
}

describe("documentSizeProblem", () => {
  it("accepts the assembled checkout example and a document at the depth bound", () => {
    expect(documentSizeProblem(assembleAsyncApi3(checkoutServiceSpec).document)).toBeNull();
    expect(documentSizeProblem({ a: deepChain(MAX_DOCUMENT_DEPTH - 2, {}) })).toBeNull();
  });

  it("refuses a document that nests past the depth bound, and says so", () => {
    expect(documentSizeProblem(deepChain(MAX_DOCUMENT_DEPTH + 10, {}))).toBe(`it nests more than ${MAX_DOCUMENT_DEPTH} levels`);
  });

  it("refuses a document with more values than the bound, and says so", () => {
    const problem = documentSizeProblem(wideBinding(MAX_DOCUMENT_VALUES + 1000));
    expect(problem).toBe(`it has more than ${MAX_DOCUMENT_VALUES.toLocaleString("en-US")} values`);
  });

  it("terminates on a cyclic object, because every turn of the cycle adds depth", () => {
    const loop: Record<string, unknown> = { level: 1 };
    loop.next = loop;
    expect(documentSizeProblem({ a: loop } as JsonObject)).toBe(`it nests more than ${MAX_DOCUMENT_DEPTH} levels`);
  });
});

describe("AsyncApi3Adapter.emit on a document past the bounds", () => {
  it("refuses a 300-level binding before validating or serializing it, and names the reason", async () => {
    vi.mocked(toJson).mockClear();
    vi.mocked(toYaml).mockClear();

    const res = await new AsyncApi3Adapter().emit(specWithMessageBindings(deepChain(300, { value: 1 })));

    expect(res).toEqual({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: `The AsyncAPI document cannot be emitted: it nests more than ${MAX_DOCUMENT_DEPTH} levels. Shorten the bindings, examples or payload schemas.`,
      },
    });
    expect(toJson).not.toHaveBeenCalled();
    expect(toYaml).not.toHaveBeenCalled();
  });

  it("emits a message binding at the depth the save accepts, and refuses one level deeper (the assembler nests messages one level down)", async () => {
    // A binding object at depth 5 + 59 = 64 of the emitted document is the bound; the save's bound (63 as stored) admits exactly this one.
    const atBound = await new AsyncApi3Adapter().emit(specWithMessageBindings(deepChain(MAX_DOCUMENT_DEPTH - 5, { value: 1 })));
    expect(atBound.success).toBe(true);
    const oneDeeper = await new AsyncApi3Adapter().emit(specWithMessageBindings(deepChain(MAX_DOCUMENT_DEPTH - 4, { value: 1 })));
    expect(oneDeeper.success).toBe(false);
  });

  it("refuses a binding with too many values, before serializing it", async () => {
    vi.mocked(toJson).mockClear();
    vi.mocked(toYaml).mockClear();

    const res = await new AsyncApi3Adapter().emit(specWithMessageBindings(wideBinding(MAX_DOCUMENT_VALUES + 1000)));

    expect(res.success).toBe(false);
    expect(toJson).not.toHaveBeenCalled();
    expect(toYaml).not.toHaveBeenCalled();
  });

  it("refuses a binding nested so deep that copying it runs out of stack, instead of throwing", async () => {
    const res = await new AsyncApi3Adapter().emit(specWithMessageBindings(deepChain(20_000, { value: 1 })));

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe("VALIDATION_ERROR");
      expect(res.error.message).toMatch(/nests too deeply to copy/);
    }
    expect(toJson).not.toHaveBeenCalled();
  });

  it("still emits a binding within the bounds, with JSON and YAML", async () => {
    const res = await new AsyncApi3Adapter().emit(specWithMessageBindings(deepChain(40, { value: 1 })));

    expect(res.success).toBe(true);
    expect(toJson).toHaveBeenCalledTimes(1);
    expect(toYaml).toHaveBeenCalledTimes(1);
  });
});

describe("emitEventStoredVersion on a stored document past the bounds", () => {
  const TENANT = "tenant-a";
  const EVENT = "event-1";
  const PRODUCT = "product-1";
  const ADMIN = [{ role: "ADMIN", scope: { kind: "GLOBAL" } }];

  /** A database with one event of this product and one stored version whose document is `document`. */
  function fakePrisma(document: unknown) {
    const event = {
      id: EVENT, name: "checkout", specType: "asyncapi@3.0", tenantId: TENANT, domainId: "domain-1", productId: PRODUCT,
      product: { slug: "checkout" }, latestVersion: null,
    };
    return {
      eventSpec: { findUnique: vi.fn(async () => event) },
      product: { findUnique: vi.fn(async () => ({ id: PRODUCT, domainId: "domain-1", domain: { tenantId: TENANT } })) },
      eventSpecVersion: { findUnique: vi.fn(async () => ({ document, major: 1, minor: 0, compatReport: {} })) },
    };
  }

  it("refuses to serve it, and does not serialize it", async () => {
    vi.mocked(toJson).mockClear();
    vi.mocked(toYaml).mockClear();
    const prisma = fakePrisma(assembleAsyncApi3(specWithMessageBindings(deepChain(300, { value: 1 }))).document);

    const res = await emitEventStoredVersion(EVENT, PRODUCT, "1.0", { userId: "u1", userRole: "ADMIN", assignments: ADMIN, prisma } as never);

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe("VALIDATION_ERROR");
      expect(res.error.message).toBe(`Version 1.0 of event "${EVENT}" cannot be served: it nests more than ${MAX_DOCUMENT_DEPTH} levels`);
    }
    expect(toJson).not.toHaveBeenCalled();
    expect(toYaml).not.toHaveBeenCalled();
  });

  it("serves a stored document within the bounds", async () => {
    const prisma = fakePrisma(assembleAsyncApi3(checkoutServiceSpec).document);

    const res = await emitEventStoredVersion(EVENT, PRODUCT, "1.0", { userId: "u1", userRole: "ADMIN", assignments: ADMIN, prisma } as never);

    expect(res.success).toBe(true);
  });
});
