import { describe, it, expect, vi } from "vitest";
import { parse } from "yaml";
import { StructuralAsyncApi3Validator, validateAsyncApi3Structure } from "@/lib/event-specs/validator";
import { jsonPointer } from "@/lib/event-specs/json-pointer";
import type { JsonObject } from "@/lib/event-specs/types";
import { SPEC_6_2_CHECKOUT_YAML } from "./fixtures/worked-example";

/**
 * The structural check runs on the server thread for every emission, so its cost must follow the size of the document, not its size times
 * its depth. These documents are built with loops (the test must not depend on the recursion it is checking) and are checked for the same
 * diagnostics the shallow document gets, at the same pointers.
 */

const valid = (): JsonObject => parse(SPEC_6_2_CHECKOUT_YAML) as JsonObject;
const codes = (doc: object) => validateAsyncApi3Structure(doc).map((d) => [d.severity, d.code, d.pointer]);

/** `levels` objects chained by `next`; each holds `width` numbers. The innermost `next` is `deepest`. */
function nestedBinding(levels: number, width: number, deepest: Record<string, unknown>): Record<string, unknown> {
  const numbers = Array.from({ length: width }, (_, i) => i);
  let node: Record<string, unknown> = deepest;
  for (let level = 0; level < levels; level++) node = { values: numbers.slice(), next: node };
  return node;
}

/** `depth` single-key objects chained by `next` (no values at all): the shape that only depth can make expensive. */
function deepChain(depth: number, deepest: Record<string, unknown>): Record<string, unknown> {
  let node: Record<string, unknown> = deepest;
  for (let level = 0; level < depth; level++) node = { next: node };
  return node;
}

const segmentsOf = (count: number): string[] => Array.from({ length: count }, () => "next");

describe("validateAsyncApi3Structure on large and deep documents", () => {
  it("validates a 1,000-level binding with 400,000 values to the same result as the document without it, in bounded time", () => {
    const doc = valid();
    (doc.servers as Record<string, Record<string, unknown>>)["kafka-prod"].bindings = nestedBinding(1000, 400, {});

    const started = performance.now();
    const diagnostics = validateAsyncApi3Structure(doc);
    const elapsed = performance.now() - started;

    expect(diagnostics).toEqual(validateAsyncApi3Structure(valid()));
    expect(diagnostics).toEqual([]);
    // The quadratic walk took about 3.9 s on an idle machine (over 10 s under load); the linear one takes milliseconds. The margin is wide
    // because the bound is about the growth, and a loaded CI runner must not turn it into a flaky timing test.
    expect(elapsed).toBeLessThan(2000);
  });

  it("reports an unresolved reference at the bottom of a 1,000-level binding at its exact pointer", () => {
    const doc = valid();
    (doc.servers as Record<string, Record<string, unknown>>)["kafka-prod"].bindings = nestedBinding(1000, 400, { $ref: "#/components/nope" });

    expect(codes(doc)).toEqual([
      ["error", "UNRESOLVED_REF", jsonPointer("servers", "kafka-prod", "bindings", ...segmentsOf(1000))],
    ]);
  });

  it("reports a remote reference below a long chain of arrays and objects at its exact pointer", () => {
    // Built from the inside out: even levels wrap the node in an array (index 0), odd levels in an object under `items`.
    const levels = 500;
    let node: unknown = { $ref: "https://evil.example/trait.yaml" };
    for (let level = 0; level < levels; level++) node = level % 2 === 0 ? [node] : { items: node };
    const doc = valid();
    (doc.servers as Record<string, Record<string, unknown>>)["kafka-prod"].bindings = node as Record<string, unknown>;

    // The outermost wrapper is the last level built (odd, so `items`), read down to the reference.
    const segments: Array<string | number> = [];
    for (let level = levels - 1; level >= 0; level--) segments.push(level % 2 === 0 ? 0 : "items");
    expect(codes(doc)).toEqual([["error", "REMOTE_REF", jsonPointer("servers", "kafka-prod", "bindings", ...segments)]]);
  });

  it("walks a 20,000-level document without a depth limit and reports its deepest reference", () => {
    const doc = valid();
    (doc.servers as Record<string, Record<string, unknown>>)["kafka-prod"].bindings = deepChain(20_000, { $ref: "#/components/nope" });

    expect(codes(doc)).toEqual([
      ["error", "UNRESOLVED_REF", jsonPointer("servers", "kafka-prod", "bindings", ...segmentsOf(20_000))],
    ]);
  });

  it("reports a finding past 150,000 levels at its pointer (the pointer is built without spreading its segments)", () => {
    const depth = 200_000;
    const doc = valid();
    (doc.servers as Record<string, Record<string, unknown>>)["kafka-prod"].bindings = deepChain(depth, { $ref: "#/components/nope" });

    // Built as a string: a spread of 200,000 arguments is what this must not depend on.
    const pointer = `/servers/kafka-prod/bindings${"/next".repeat(depth)}`;
    expect(codes(doc)).toEqual([["error", "UNRESOLVED_REF", pointer]]);
  });
});

describe("StructuralAsyncApi3Validator on a cyclic object", () => {
  it("returns a VALIDATOR_FAILED result instead of looping or throwing (parsed JSON can never be cyclic, a built object can)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const doc = valid();
      const loop: Record<string, unknown> = { level: 1 };
      loop.next = loop;
      (doc.servers as Record<string, Record<string, unknown>>)["kafka-prod"].bindings = loop;

      expect(() => validateAsyncApi3Structure(doc)).toThrow(/cyclic/);
      const result = await new StructuralAsyncApi3Validator().validate(doc);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe("VALIDATOR_FAILED");
    } finally {
      consoleError.mockRestore();
    }
  });
});
