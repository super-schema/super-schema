// tests/unit/lib/events/import/refs.test.ts
// WP-I1: local $ref resolution for the importer — inline what the event document stores inline, reject everything that could escape
// the document (external refs), loop (cycles), or explode (reference expansion bombs).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseAsyncApiSource } from "@/lib/events/import/source";
import { createRefResolver, refTargetPointer, resolveLocalRefs } from "@/lib/events/import/refs";
import type { RawAsyncApi3 } from "@/lib/events/import/types";

const fixture = (name: string): RawAsyncApi3 => {
  const parsed = parseAsyncApiSource(readFileSync(path.join(process.cwd(), "tests/fixtures/asyncapi-import", name), "utf8"));
  if (!parsed.success) throw new Error(parsed.error.message);
  return parsed.data;
};
const doc = (rest: Record<string, unknown>): RawAsyncApi3 => ({ asyncapi: "3.0.0", ...rest });
function failureOf(value: unknown) {
  const result = resolveLocalRefs(value);
  if (result.success) throw new Error("expected a reference error");
  return result.error;
}

describe("resolveLocalRefs: inlining", () => {
  it("replaces a ref with its target, in objects and in arrays, and leaves the rest alone", () => {
    const result = resolveLocalRefs(doc({
      components: { schemas: { Id: { type: "string", minLength: 1 } } },
      list: [{ $ref: "#/components/schemas/Id" }, "plain", 3],
      holder: { id: { $ref: "#/components/schemas/Id" }, other: true },
    }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    const out = result.data as Record<string, unknown>;
    expect(out.list).toEqual([{ type: "string", minLength: 1 }, "plain", 3]);
    expect(out.holder).toEqual({ id: { type: "string", minLength: 1 }, other: true });
    expect(out.asyncapi).toBe("3.0.0");
  });

  it("follows a chain of refs and refs nested inside the target", () => {
    const result = resolveLocalRefs(doc({
      a: { $ref: "#/b" },
      b: { $ref: "#/c" },
      c: { inner: { $ref: "#/d" } },
      d: { leaf: 1 },
    }));
    expect(result.success && (result.data as { a: unknown }).a).toEqual({ inner: { leaf: 1 } });
  });

  it("merges properties written next to a $ref over the target (JSON Schema 2020-12 style)", () => {
    const result = resolveLocalRefs(doc({ s: { $ref: "#/t", description: "overridden" }, t: { type: "string", description: "orig" } }));
    expect(result.success && (result.data as { s: unknown }).s).toEqual({ type: "string", description: "overridden" });
  });

  it("does not treat a property NAMED $ref, or a non-string $ref, as a reference", () => {
    const value = doc({ schema: { properties: { $ref: { type: "string" } } }, odd: { $ref: 5 } });
    const result = resolveLocalRefs(value);
    expect(result.success && result.data).toEqual(value);
  });

  it("decodes percent-escapes and ~1 / ~0 in a pointer", () => {
    const result = resolveLocalRefs(doc({
      channels: { "user/signed up": { address: "u" }, "a~b": { address: "t" } },
      one: { $ref: "#/channels/user~1signed%20up" },
      two: { $ref: "#/channels/a~0b" },
    }));
    expect(result.success && (result.data as { one: unknown; two: unknown })).toMatchObject({ one: { address: "u" }, two: { address: "t" } });
  });

  it("shares one expansion between many uses (no copy per use) and does not mutate the input", () => {
    const input = doc({ components: { schemas: { S: { type: "object", properties: { a: { type: "string" } } } } }, uses: Array.from({ length: 2000 }, () => ({ $ref: "#/components/schemas/S" })) });
    const before = JSON.stringify(input);
    const result = resolveLocalRefs(input);
    expect(result.success).toBe(true);
    if (result.success) {
      const uses = (result.data as { uses: unknown[] }).uses;
      expect(uses[0]).toBe(uses[1999]);
      expect(uses[0]).toEqual({ type: "object", properties: { a: { type: "string" } } });
    }
    expect(JSON.stringify(input)).toBe(before);
  });

  it("a __proto__-free document stays free of one: keys come out as own properties only", () => {
    const result = resolveLocalRefs(doc({ x: { $ref: "#/y" }, y: { constructorName: "ok" } }));
    expect(result.success).toBe(true);
  });
});

describe("resolveLocalRefs: rejects", () => {
  it.each([
    ["an http URL", "http://schemas.example.com/order.json"],
    ["an https URL with a pointer", "https://schemas.example.com/all.json#/definitions/Order"],
    ["a file URL", "file:///etc/passwd"],
    ["a relative path", "./order.json"],
    ["a relative path with a pointer", "schemas/order.yaml#/Order"],
    ["a bare name", "order"],
  ])("%s as EXTERNAL_REF, naming the ref and where it is", (_label, ref) => {
    const error = failureOf(doc({ components: { messages: { m: { payload: { $ref: ref } } } } }));
    expect(error.code).toBe("EXTERNAL_REF");
    expect(error.message).toContain(ref);
    expect(error.message).toContain("/components/messages/m/payload");
    expect(error.message).toMatch(/never fetched/);
  });

  it("a $ref in a section nothing uses (every ref is checked, not only the used ones)", () => {
    expect(failureOf(doc({ components: { schemas: { Unused: { $ref: "https://example.com/x.json" } } } })).code).toBe("EXTERNAL_REF");
  });

  it("an in-document anchor that is not a JSON pointer", () => {
    expect(failureOf(doc({ a: { $ref: "#anchor" } })).code).toBe("REF_NOT_FOUND");
  });

  it("a ref to a missing target as REF_NOT_FOUND, naming the ref and where it is", () => {
    const error = failureOf(fixture("negative-missing-ref.yaml"));
    expect(error.code).toBe("REF_NOT_FOUND");
    expect(error.message).toContain("#/components/schemas/DoesNotExist");
    expect(error.message).toContain("/components/messages/orderCreated/payload");
    expect(error.suggestedFix).toMatch(/from the document root/);
  });

  it("an array index that is out of range, and a pointer into a scalar", () => {
    expect(failureOf(doc({ list: [1], a: { $ref: "#/list/5" } })).code).toBe("REF_NOT_FOUND");
    expect(failureOf(doc({ s: "text", a: { $ref: "#/s/length" } })).code).toBe("REF_NOT_FOUND");
  });

  it("a ref that points at itself, and a ref that points at its own parent", () => {
    expect(failureOf(doc({ a: { $ref: "#/a" } })).code).toBe("REF_CYCLE");
    const parent = failureOf(doc({ tree: { child: { $ref: "#/tree" } } }));
    expect(parent.code).toBe("REF_CYCLE");
    expect(parent.message).toContain("#/tree");
  });

  it("a longer cycle (Node → Tree → Node) as REF_CYCLE, naming the whole chain", () => {
    const error = failureOf(fixture("negative-ref-cycle.yaml"));
    expect(error.code).toBe("REF_CYCLE");
    expect(error.message).toContain("#/components/schemas/Node");
    expect(error.message).toContain("#/components/schemas/Tree");
    expect(error.message).toMatch(/recursive/i);
  });

  it("a reference expansion bomb (40 levels, each referencing the one below twice) without expanding it", () => {
    const schemas: Record<string, unknown> = { S0: { type: "string" } };
    for (let i = 1; i <= 40; i += 1) schemas[`S${i}`] = { allOf: [{ $ref: `#/components/schemas/S${i - 1}` }, { $ref: `#/components/schemas/S${i - 1}` }] };
    const started = Date.now();
    const error = failureOf(doc({ components: { schemas }, use: { $ref: "#/components/schemas/S40" } }));
    expect(error.code).toBe("REF_TOO_LARGE");
    expect(error.message).toMatch(/too large|too many/i);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("a chain of 5,000 refs (stack depth) as REF_TOO_LARGE, not a stack overflow", () => {
    // the entry point comes first, so the chain is followed from its far end (the order a hostile file would pick)
    const value: Record<string, unknown> = { asyncapi: "3.0.0", use: { $ref: "#/r5000" } };
    for (let i = 5000; i >= 1; i -= 1) value[`r${i}`] = { next: { $ref: `#/r${i - 1}` } };
    value.r0 = { end: true };
    const error = failureOf(value);
    expect(error.code).toBe("REF_TOO_LARGE");
    expect(error.message).toMatch(/deep/);
  });

  it("deeply nested plain data (not refs) that a recursive walk could not survive", () => {
    let nested: unknown = 1;
    for (let i = 0; i < 100_000; i += 1) nested = [nested];
    const result = resolveLocalRefs({ asyncapi: "3.0.0", x: nested });
    expect(result.success).toBe(false);
  });
});

describe("createRefResolver", () => {
  const raw = doc({
    channels: { orders: { messages: { created: { $ref: "#/components/messages/Created" } } } },
    components: { messages: { Created: { payload: { $ref: "#/components/schemas/Order" } } }, schemas: { Order: { type: "object" } } },
  });

  it("deref follows the wrappers only: the target comes back as written, with its own refs untouched", () => {
    const resolver = createRefResolver(raw);
    const result = resolver.deref((raw.channels as { orders: { messages: { created: unknown } } }).orders.messages.created, "/channels/orders/messages/created");
    expect(result).toEqual({ success: true, data: { value: { payload: { $ref: "#/components/schemas/Order" } }, pointer: "/components/messages/Created" } });
  });

  it("deref of something that is not a ref is that value at the given pointer", () => {
    const resolver = createRefResolver(raw);
    expect(resolver.deref({ a: 1 }, "/x")).toEqual({ success: true, data: { value: { a: 1 }, pointer: "/x" } });
  });

  it("deref reports a cycle of wrappers and a missing or external target", () => {
    const resolver = createRefResolver(doc({ a: { $ref: "#/b" }, b: { $ref: "#/a" }, c: { $ref: "#/nope" }, d: { $ref: "http://x/y" } }));
    for (const [name, code] of [["a", "REF_CYCLE"], ["c", "REF_NOT_FOUND"], ["d", "EXTERNAL_REF"]] as const) {
      const result = resolver.deref({ $ref: `#/${name}` }, "/start");
      expect(result.success ? "ok" : result.error.code).toBe(code);
    }
  });

  it("inline resolves one value, and check validates the whole document", () => {
    const resolver = createRefResolver(raw);
    const inlined = resolver.inline({ $ref: "#/components/messages/Created" }, "/start");
    expect(inlined).toEqual({ success: true, data: { payload: { type: "object" } } });
    expect(resolver.check().success).toBe(true);
    expect(createRefResolver(doc({ x: { $ref: "#/y" } })).check().success).toBe(false);
  });

  it("records which targets were followed", () => {
    const resolver = createRefResolver(raw);
    resolver.check();
    expect([...resolver.followed].sort()).toEqual(["/components/messages/Created", "/components/schemas/Order"]);
  });
});

describe("refTargetPointer", () => {
  it("is the canonical pointer of a local ref, null for anything else", () => {
    expect(refTargetPointer({ $ref: "#/components/messages/a~1b" })).toBe("/components/messages/a~1b");
    expect(refTargetPointer({ $ref: "#/components/schemas/My%20Schema" })).toBe("/components/schemas/My Schema");
    expect(refTargetPointer({ $ref: "#" })).toBe("");
    expect(refTargetPointer({ $ref: "http://x" })).toBeNull();
    expect(refTargetPointer({ type: "object" })).toBeNull();
    expect(refTargetPointer("#/a")).toBeNull();
    expect(refTargetPointer(null)).toBeNull();
  });
});

describe("cycles in schema content: inlineSchema and check({ tolerateCycles })", () => {
  const recursive = doc({
    components: {
      schemas: {
        Comment: { type: "object", properties: { replies: { type: "array", items: { $ref: "#/components/schemas/Comment" } } } },
        Plain: { type: "object", properties: { id: { type: "string" } } },
        Node: { type: "object", properties: { child: { $ref: "#/components/schemas/Tree" } } },
        Tree: { type: "object", properties: { root: { $ref: "#/components/schemas/Node" } } },
        UsesComment: { type: "object", properties: { comment: { $ref: "#/components/schemas/Comment" } } },
      },
    },
  });
  const schema = (name: string) => ({ $ref: `#/components/schemas/${name}` });

  it("a schema that refers to itself comes back as `recursive`, with the chain that closes the loop", () => {
    const result = createRefResolver(recursive).inlineSchema(schema("Comment"), "/payload");
    expect(result).toEqual({ success: true, data: { recursive: ["#/components/schemas/Comment", "#/components/schemas/Comment"] } });
  });

  it("a loop through several schemas names all of them", () => {
    const result = createRefResolver(recursive).inlineSchema(schema("Node"), "/payload");
    expect(result.success && "recursive" in result.data && result.data.recursive).toEqual(["#/components/schemas/Node", "#/components/schemas/Tree", "#/components/schemas/Node"]);
  });

  it("a schema without a loop is an ordinary value, also after the document was checked with cycles tolerated", () => {
    const resolver = createRefResolver(recursive);
    expect(resolver.check({ tolerateCycles: true }).success).toBe(true);
    expect(resolver.inlineSchema(schema("Plain"), "/payload")).toEqual({ success: true, data: { value: { type: "object", properties: { id: { type: "string" } } } } });
  });

  it("a schema that merely USES a recursive one is recursive too, however often and in whatever order they are read", () => {
    const resolver = createRefResolver(recursive);
    expect(resolver.check({ tolerateCycles: true }).success).toBe(true);
    for (const name of ["UsesComment", "Comment", "UsesComment", "Plain", "Comment"]) {
      const result = resolver.inlineSchema(schema(name), "/payload");
      expect(result.success && "recursive" in result.data, name).toBe(name !== "Plain");
    }
  });

  it("the loop is only tolerated for schema content: after a tolerated check, strict inline of anything that leads into it is REF_CYCLE", () => {
    const resolver = createRefResolver(recursive);
    expect(resolver.check({ tolerateCycles: true }).success).toBe(true);
    for (const name of ["Comment", "UsesComment", "Node"]) {
      const strict = resolver.inline(schema(name), "/binding");
      expect(strict.success ? "ok" : strict.error.code, name).toBe("REF_CYCLE");
    }
    expect(resolver.inline(schema("Plain"), "/binding").success).toBe(true);
  });

  it("a strict resolver that never tolerated the loop refuses it in the first place", () => {
    const fresh = createRefResolver(recursive);
    const checked = fresh.check();
    expect(checked.success ? "ok" : checked.error.code).toBe("REF_CYCLE");
    expect(fresh.inline(schema("Comment"), "/x").success).toBe(false);
  });

  it("a wrapper chain that loops (A -> B -> A) is still found by deref", () => {
    const resolver = createRefResolver(doc({ components: { schemas: { A: { $ref: "#/components/schemas/B" }, B: { $ref: "#/components/schemas/A" } } } }));
    expect(resolver.check({ tolerateCycles: true }).success).toBe(true);
    const result = resolver.deref(schema("A"), "/payload");
    expect(result.success ? "ok" : result.error.code).toBe("REF_CYCLE");
  });

  it.each([
    ["an external ref", { $ref: "https://example.com/x.json" }, "EXTERNAL_REF"],
    ["a missing ref", { $ref: "#/components/schemas/Nope" }, "REF_NOT_FOUND"],
  ])("%s inside a recursive schema is still an error, in check and in inlineSchema", (_label, bad, code) => {
    const value = doc({ components: { schemas: { Comment: { items: { $ref: "#/components/schemas/Comment" }, extra: bad } } } });
    const checked = createRefResolver(value).check({ tolerateCycles: true });
    expect(checked.success ? "ok" : checked.error.code).toBe(code);
    const inlined = createRefResolver(value).inlineSchema(schema("Comment"), "/payload");
    expect(inlined.success ? "ok" : inlined.error.code).toBe(code);
  });

  it("an expansion bomb is still REF_TOO_LARGE with cycles tolerated", () => {
    const schemas: Record<string, unknown> = { S0: { type: "string" } };
    for (let i = 1; i <= 40; i += 1) schemas[`S${i}`] = { allOf: [{ $ref: `#/components/schemas/S${i - 1}` }, { $ref: `#/components/schemas/S${i - 1}` }] };
    const checked = createRefResolver(doc({ components: { schemas } })).check({ tolerateCycles: true });
    expect(checked.success ? "ok" : checked.error.code).toBe("REF_TOO_LARGE");
  });

  it("a recursive schema used by thousands of messages stays cheap (each loop is cut once, then remembered)", () => {
    const messages: Record<string, unknown> = {};
    for (let i = 0; i < 3000; i += 1) messages[`m${i}`] = { payload: schema("Comment") };
    const resolver = createRefResolver({ ...recursive, components: { ...(recursive.components as object), messages } });
    const started = Date.now();
    expect(resolver.check({ tolerateCycles: true }).success).toBe(true);
    for (let i = 0; i < 3000; i += 1) expect(resolver.inlineSchema(schema("Comment"), `/components/messages/m${i}/payload`).success).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("a doubling chain over a recursive schema stays cheap: the loop is found once and remembered", () => {
    const schemas: Record<string, unknown> = { S0: { items: { $ref: "#/components/schemas/S0" } } };
    for (let i = 1; i <= 40; i += 1) schemas[`S${i}`] = { allOf: [{ $ref: `#/components/schemas/S${i - 1}` }, { $ref: `#/components/schemas/S${i - 1}` }] };
    const started = Date.now();
    const result = createRefResolver(doc({ components: { schemas } })).check({ tolerateCycles: true });
    expect(result.success).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
