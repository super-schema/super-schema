import "dotenv/config"; // first: @/lib/db (pulled in by the services) reads DB_PROVIDER at import time
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { resolveLocalRef } from "@/lib/event-specs/json-pointer";
import { exampleFromSchema } from "@/lib/events/example-from-schema";
import type { ArtifactRenderer, RenderedArtifact } from "@/services/events/artifact-renderer";
import { MAX_PIN_SCHEMA_BYTES, PIN_SCHEMA_RENDER_FAILED, renderPinJsonSchema } from "@/services/events/pin-json-schema.service";
import { err, ok, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import { createForeignTenantFixture } from "./foreign-tenant-fixture";
import { cleanupDomains, connectTestDb, createProductScope, TENANT, testContext, unwrap } from "./helpers";

const prisma = connectTestDb();
const domainIds: string[] = [];
afterAll(async () => {
  await cleanupDomains(prisma, domainIds);
  await prisma.$disconnect();
});
afterEach(() => vi.restoreAllMocks());

type Schema = Record<string, unknown>;
const failureOf = (r: Result<unknown>) => (r.success ? null : r.error);

/** What the renderer hands back for JSON Schema: 2020-12, the bundle's other models under `$defs`. */
const RENDERED: Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { id: { type: "string" }, status: { $ref: "#/$defs/Status" }, point: { type: "array", prefixItems: [{ type: "number" }, { type: "number" }] } },
  required: ["id"],
  $defs: { Status: { type: "string", enum: ["NEW", "PAID"] } },
};

function renderOf(schema: unknown): Result<RenderedArtifact> {
  return ok({ artifact: { format: "json-schema", dialect: "2020-12", schema: schema as never }, warnings: [] });
}
/** A renderer that answers `outcome` and remembers what it was asked. */
function stubRenderer(outcome: Result<RenderedArtifact> | (() => never)) {
  const render = vi.fn<ArtifactRenderer["render"]>(async () => (typeof outcome === "function" ? outcome() : outcome));
  return { renderer: { render } as ArtifactRenderer, render };
}

async function scope(ctx: ServiceContext) {
  const sc = await createProductScope(prisma, ctx, "pinschema");
  domainIds.push(sc.domain.id);
  return sc;
}
/** A published-looking version row, written directly (no publish audit rows): the renderers read only `resolvedSource`, the snapshot and the pins. */
async function version(ctx: ServiceContext, entityId: string, resolvedSource: string) {
  return prisma.entityVersion.create({
    data: { entityId, major: 1, minor: 0, sequence: 1, resolvedSource, changeKind: "INITIAL", publishedById: ctx.userId, fieldSnapshot: [{ name: "id", fieldNumber: 1 }] },
  });
}
const asPrisma = (p: object) => p as unknown as PrismaClient;

/** Every string `$ref` anywhere in `node` (a schema is JSON: nothing but `$ref` keywords carries a string under that key). */
function refsOf(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(refsOf);
  if (typeof node !== "object" || node === null) return [];
  return Object.entries(node).flatMap(([key, value]) => (key === "$ref" && typeof value === "string" ? [value] : refsOf(value)));
}
/** The `$ref`s of `schema` that do not lead to anything inside it: `#`, `#/definitions/X` and `#/$defs/X` resolve, everything else dangles. */
function danglingRefs(schema: unknown): string[] {
  return refsOf(schema).filter((ref) => {
    if (!ref.startsWith("#")) return true; // a file or URL: the editor could not follow it
    try {
      return !resolveLocalRef(schema, decodeURIComponent(ref)).found;
    } catch {
      return true; // a malformed escape
    }
  });
}
/** A Proxy over a Prisma object whose listed members are replaced; everything else is the real thing. */
function replacing<T extends object>(target: T, overrides: Record<string, unknown>): T {
  return new Proxy(target, { get: (t, p) => (typeof p === "string" && p in overrides ? overrides[p] : Reflect.get(t, p)) });
}

describe("renderPinJsonSchema: what it renders", () => {
  it("renders a pinned version through the JSON Schema renderer and hands back the draft-07 form of it", async () => {
    const ctx = await testContext(prisma);
    const sc = await scope(ctx);
    const order = await sc.entity("Order");
    const v = await version(ctx, order.id, "model Order {\n  id: string;\n}\n");
    const { renderer, render } = stubRenderer(renderOf(RENDERED));

    const { schema } = unwrap(await renderPinJsonSchema(ctx, { tenantId: TENANT, pin: { entityId: order.id, entityVersionId: v.id } }, { renderer }));

    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith({ kind: "version", entityVersionId: v.id, tenantId: TENANT }, "json-schema");
    expect(schema).toEqual({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { id: { type: "string" }, status: { $ref: "#/definitions/Status" }, point: { type: "array", items: [{ type: "number" }, { type: "number" }] } },
      required: ["id"],
      definitions: { Status: { type: "string", enum: ["NEW", "PAID"] } },
    });
    expect(JSON.stringify(schema)).not.toContain("$defs");
    expect(refsOf(schema)).toEqual(["#/definitions/Status"]);
    expect(danglingRefs(schema)).toEqual([]);
  });

  it("the check for dangling references sees one that leads nowhere, so a renderer change that leaves one fails the real-render test", () => {
    const schema = {
      type: "object",
      properties: { a: { $ref: "#/definitions/A" }, b: { $ref: "#/definitions/Gone" }, c: { $ref: "#" }, d: { $ref: "other.json" }, e: { $ref: "#/$defs/E" }, f: { $ref: "#/%E0%A4%A" } },
      definitions: { A: { type: "string" } },
      $defs: { E: { type: "string" } },
    };
    expect(refsOf(schema)).toHaveLength(6);
    expect(danglingRefs(schema)).toEqual(["#/definitions/Gone", "other.json", "#/%E0%A4%A"]);
  });

  it("renders an unpinned pin as the entity's current draft, the way the Code panel previews it", async () => {
    const ctx = await testContext(prisma);
    const sc = await scope(ctx);
    const order = await sc.entity("Order");
    const { renderer, render } = stubRenderer(renderOf(RENDERED));
    unwrap(await renderPinJsonSchema(ctx, { tenantId: TENANT, pin: { entityId: order.id, entityVersionId: null } }, { renderer }));
    expect(render).toHaveBeenCalledWith({ kind: "draft", entityId: order.id, tenantId: TENANT }, "json-schema");
    // a pin that leaves `entityVersionId` out is the same unpinned pin
    unwrap(await renderPinJsonSchema(ctx, { tenantId: TENANT, pin: { entityId: order.id } as never }, { renderer }));
    expect(render).toHaveBeenLastCalledWith({ kind: "draft", entityId: order.id, tenantId: TENANT }, "json-schema");
  });

  it("renders a real entity end to end: a draft with a nested model and an enum, and a version of it, both usable to generate an example from", async () => {
    const ctx = await testContext(prisma);
    const sc = await scope(ctx);
    const source = "enum Status { NEW, PAID }\nmodel Address {\n  zip: string;\n}\nmodel Order {\n  id: string;\n  qty: int32;\n  status: Status;\n  ship: Address;\n  tags?: string[];\n}\n";
    const order = await prisma.entity.create({
      data: {
        name: "Order", slug: `order-${sc.s}`, tenantId: TENANT, domainId: sc.domain.id, productId: sc.product.id, ownerId: ctx.userId, typespecSource: source,
        fields: { create: [{ name: "id", slug: "id", type: "string", nullable: false, sortOrder: 0, fieldNumber: 1, decorators: {} }] },
      },
    });
    const pinned = await version(ctx, order.id, source);

    for (const pin of [{ entityId: order.id, entityVersionId: null }, { entityId: order.id, entityVersionId: pinned.id }]) {
      const { schema } = unwrap(await renderPinJsonSchema(ctx, { tenantId: TENANT, pin }));
      expect(schema).toMatchObject({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: { id: { type: "string" }, status: { $ref: "#/definitions/Status" }, ship: { $ref: "#/definitions/Address" } },
        definitions: { Status: { enum: ["NEW", "PAID"] }, Address: { properties: { zip: { type: "string" } } } },
      });
      // The editor follows a `$ref` it can resolve and silently skips one it cannot: every reference must lead somewhere inside the schema.
      expect(refsOf(schema).length).toBeGreaterThanOrEqual(2);
      expect(danglingRefs(schema)).toEqual([]);
      expect(unwrap(exampleFromSchema(schema))).toEqual({ id: "string", qty: 0, status: "NEW", ship: { zip: "string" }, tags: ["string"] });
    }
  }, 90_000);
});

// The editor runs a schema's `pattern` in the BROWSER (`new RegExp(pattern, "u")`), where a backtracking one cannot be interrupted. Only a pattern
// that is linear by construction (`isLinearSafePattern`) is sent; the others are removed from this copy, which loses an advisory warning only.
// No test here (or anywhere) ever MATCHES a catastrophic pattern: they only read what the service hands back.
describe("renderPinJsonSchema: a pattern that could freeze the editor never reaches it", () => {
  const CATASTROPHIC = "^(a+)+$";
  const SAFE = "^[a-z]{3}$";

  it("removes `^(a+)+$` from a pinned version's schema (wherever it sits, `$defs` included) and keeps `^[a-z]{3}$`", async () => {
    const ctx = await testContext(prisma);
    const sc = await scope(ctx);
    const order = await sc.entity("Order");
    const v = await version(ctx, order.id, "model Order {\n  id: string;\n}\n");
    const rendered = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        code: { type: "string", pattern: CATASTROPHIC },
        slug: { type: "string", pattern: SAFE },
        status: { $ref: "#/$defs/Status" },
        tags: { type: "array", items: { type: "string", pattern: "^(a|aa)+$" } },
        pattern: { type: "string", description: "a property that is called like the keyword" },
      },
      patternProperties: { "^(x+)+y$": { type: "string" }, "^x-[a-z]+$": { type: "string" } },
      $defs: { Status: { type: "string", pattern: "(a*)*b" } },
    };
    const { renderer } = stubRenderer(renderOf(rendered));

    const { schema } = unwrap(await renderPinJsonSchema(ctx, { tenantId: TENANT, pin: { entityId: order.id, entityVersionId: v.id } }, { renderer }));

    expect(JSON.stringify(schema)).not.toMatch(/\(a\+\)\+|\(a\|aa\)|\(a\*\)\*|\(x\+\)\+/);
    expect(schema).toEqual({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        code: { type: "string" },
        slug: { type: "string", pattern: SAFE },
        status: { $ref: "#/definitions/Status" },
        tags: { type: "array", items: { type: "string" } },
        pattern: { type: "string", description: "a property that is called like the keyword" },
      },
      patternProperties: { "^x-[a-z]+$": { type: "string" } },
      definitions: { Status: { type: "string" } },
    });
    expect(danglingRefs(schema)).toEqual([]);
  });

  it("also removes it from where only a `$ref` can reach it: the editor's validator follows a pointer into a `default`, `const`, `enum`, `example` or `examples` too", async () => {
    const ctx = await testContext(prisma);
    const sc = await scope(ctx);
    const order = await sc.entity("Order");
    const v = await version(ctx, order.id, "model Order {\n  id: string;\n}\n");
    const hidden = { type: "string", pattern: CATASTROPHIC };
    const rendered = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        a: { default: hidden }, b: { const: hidden }, c: { enum: [hidden] }, d: { example: hidden }, e: { examples: [hidden] },
        ref: { $ref: "#/properties/a/default" },
      },
    };
    const { renderer } = stubRenderer(renderOf(rendered));

    const { schema } = unwrap(await renderPinJsonSchema(ctx, { tenantId: TENANT, pin: { entityId: order.id, entityVersionId: v.id } }, { renderer }));

    expect(JSON.stringify(schema)).not.toContain(CATASTROPHIC);
    expect((schema.properties as Record<string, Record<string, unknown>>).a.default).toEqual({ type: "string" });
    expect(danglingRefs(schema)).toEqual([]);
  });

  it("does the same for a real entity version rendered by the TypeSpec CLI: `@pattern` is on the entity, the browser gets only the safe one", async () => {
    const ctx = await testContext(prisma);
    const sc = await scope(ctx);
    const source = `model Account {\n  @pattern("${CATASTROPHIC}")\n  code: string;\n  @pattern("${SAFE}")\n  slug: string;\n}\n`;
    const account = await prisma.entity.create({
      data: {
        name: "Account", slug: `account-${sc.s}`, tenantId: TENANT, domainId: sc.domain.id, productId: sc.product.id, ownerId: ctx.userId, typespecSource: source,
        fields: { create: [{ name: "code", slug: "code", type: "string", nullable: false, sortOrder: 0, fieldNumber: 1, decorators: {} }] },
      },
    });
    const pinned = await version(ctx, account.id, source);

    for (const pin of [{ entityId: account.id, entityVersionId: pinned.id }, { entityId: account.id, entityVersionId: null }]) {
      const { schema } = unwrap(await renderPinJsonSchema(ctx, { tenantId: TENANT, pin }));
      const properties = schema.properties as Record<string, Record<string, unknown>>;
      expect(properties.code).toMatchObject({ type: "string" });
      expect(properties.code).not.toHaveProperty("pattern");
      expect(properties.slug).toMatchObject({ type: "string", pattern: SAFE });
      expect(JSON.stringify(schema)).not.toContain(CATASTROPHIC);
    }
  }, 90_000);
});

describe("renderPinJsonSchema: a very wide entity", () => {
  it("renders a payload of 1,000 properties well inside the size cap, and an example can still be generated from it", async () => {
    const ctx = await testContext(prisma);
    const sc = await scope(ctx);
    const lines = Array.from({ length: 1000 }, (_, i) => `  field${i}: ${i % 2 === 0 ? "string" : "int32"};`);
    const order = await prisma.entity.create({
      data: {
        name: "Wide", slug: `wide-${sc.s}`, tenantId: TENANT, domainId: sc.domain.id, productId: sc.product.id, ownerId: ctx.userId,
        typespecSource: `model Wide {\n${lines.join("\n")}\n}\n`,
        fields: { create: [{ name: "field0", slug: "field0", type: "string", nullable: false, sortOrder: 0, fieldNumber: 1, decorators: {} }] },
      },
    });
    const { schema } = unwrap(await renderPinJsonSchema(ctx, { tenantId: TENANT, pin: { entityId: order.id, entityVersionId: null } }));
    expect(Object.keys(schema.properties as object)).toHaveLength(1000);
    expect(Buffer.byteLength(JSON.stringify(schema), "utf8")).toBeLessThan(MAX_PIN_SCHEMA_BYTES / 2);
    const started = Date.now();
    const example = unwrap(exampleFromSchema(schema)) as Record<string, unknown>;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(Object.keys(example)).toHaveLength(1000);
    expect(example).toMatchObject({ field0: "string", field1: 0 });
  }, 120_000);
});

describe("renderPinJsonSchema: whose entity it may render", () => {
  it("answers NOT_FOUND for another tenant's entity, draft or version pin, without rendering and without a name", async () => {
    const ctx = await testContext(prisma);
    const foreign = await createForeignTenantFixture(prisma, ctx);
    try {
      const { renderer, render } = stubRenderer(renderOf(RENDERED));
      const draft = await renderPinJsonSchema(ctx, { tenantId: TENANT, pin: { entityId: foreign.entity.id, entityVersionId: null } }, { renderer });
      const pinned = await renderPinJsonSchema(ctx, { tenantId: TENANT, pin: { entityId: foreign.entity.id, entityVersionId: foreign.version.id } }, { renderer });
      expect(failureOf(draft)).toEqual({ code: "NOT_FOUND", message: `Entity "${foreign.entity.id}" not found` });
      expect(failureOf(pinned)).toEqual({ code: "NOT_FOUND", message: `Entity "${foreign.entity.id}" not found` });
      expect(JSON.stringify([draft, pinned])).not.toMatch(/Foreign/i);
      expect(render).not.toHaveBeenCalled();

      // the very same pin is served to the tenant that owns it
      unwrap(await renderPinJsonSchema(ctx, { tenantId: foreign.tenant.id, pin: { entityId: foreign.entity.id, entityVersionId: foreign.version.id } }, { renderer }));
      expect(render).toHaveBeenCalledTimes(1);
    } finally {
      await foreign.cleanup();
    }
  }, 60_000);

  it("reads a foreign entity exactly like one that does not exist", async () => {
    const ctx = await testContext(prisma);
    const foreign = await createForeignTenantFixture(prisma, ctx);
    try {
      const { renderer, render } = stubRenderer(renderOf(RENDERED));
      const theirs = await renderPinJsonSchema(ctx, { tenantId: TENANT, pin: { entityId: foreign.entity.id, entityVersionId: null } }, { renderer });
      const nothing = await renderPinJsonSchema(ctx, { tenantId: TENANT, pin: { entityId: foreign.entity.id.replace(/.$/, "x"), entityVersionId: null } }, { renderer });
      expect(failureOf(theirs)?.code).toBe(failureOf(nothing)?.code);
      expect(failureOf(theirs)?.message.replace(foreign.entity.id, "<id>")).toBe(failureOf(nothing)?.message.replace(foreign.entity.id.replace(/.$/, "x"), "<id>"));
      expect(render).not.toHaveBeenCalled();
    } finally {
      await foreign.cleanup();
    }
  }, 60_000);

  it("answers NOT_FOUND for a version that is not a version of the pinned entity (even in the same tenant)", async () => {
    const ctx = await testContext(prisma);
    const sc = await scope(ctx);
    const order = await sc.entity("Order");
    const other = await sc.entity("Other");
    const otherVersion = await version(ctx, other.id, "model Other {\n  id: string;\n}\n");
    const { renderer, render } = stubRenderer(renderOf(RENDERED));
    const result = await renderPinJsonSchema(ctx, { tenantId: TENANT, pin: { entityId: order.id, entityVersionId: otherVersion.id } }, { renderer });
    expect(failureOf(result)).toEqual({ code: "NOT_FOUND", message: `Entity "${order.id}" not found` });
    expect(render).not.toHaveBeenCalled();
  });

  it("rejects what is not a pin before reading anything", async () => {
    const ctx = await testContext(prisma);
    const { renderer, render } = stubRenderer(renderOf(RENDERED));
    const call = (input: unknown) => renderPinJsonSchema(ctx, input as never, { renderer });
    for (const input of [
      null, "pin", { tenantId: "", pin: { entityId: "e" } }, { tenantId: TENANT }, { tenantId: TENANT, pin: null }, { tenantId: TENANT, pin: [] },
      { tenantId: TENANT, pin: { entityId: "" } }, { tenantId: TENANT, pin: { entityId: 5 } }, { tenantId: TENANT, pin: { entityId: "e", entityVersionId: 7 } },
      { tenantId: TENANT, pin: { entityId: "e", entityVersionId: "  " } },
    ]) {
      expect(failureOf(await call(input)), JSON.stringify(input)).toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(render).not.toHaveBeenCalled();
  });

  it("answers the generic DB_ERROR when the ownership read throws, without driver text", async () => {
    const ctx = await testContext(prisma);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const RAW = 'relation "entities" does not exist at 10.0.0.5:5432';
    const broken = { ...ctx, prisma: asPrisma(replacing(prisma, { entity: { findFirst: () => Promise.reject(new Error(RAW)) } })) };
    const { renderer, render } = stubRenderer(renderOf(RENDERED));
    const result = await renderPinJsonSchema(broken, { tenantId: TENANT, pin: { entityId: "e1", entityVersionId: null } }, { renderer });
    expect(failureOf(result)?.code).toBe("DB_ERROR");
    expect(JSON.stringify(result)).not.toContain("10.0.0.5");
    expect(render).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalled();
  });
});

describe("renderPinJsonSchema: what goes wrong", () => {
  it("refuses a schema over 512 KB with TOO_LARGE, and serves one just under it", async () => {
    const ctx = await testContext(prisma);
    const sc = await scope(ctx);
    const order = await sc.entity("Order");
    const pin = { entityId: order.id, entityVersionId: null };
    const sized = (bytes: number) => renderOf({ type: "object", properties: { id: { type: "string", description: "x".repeat(bytes) } } });

    const big = await renderPinJsonSchema(ctx, { tenantId: TENANT, pin }, { renderer: stubRenderer(sized(MAX_PIN_SCHEMA_BYTES)).renderer });
    expect(failureOf(big)).toMatchObject({ code: "TOO_LARGE" });
    expect(failureOf(big)?.message).toMatch(/512 KB/);

    const fits = await renderPinJsonSchema(ctx, { tenantId: TENANT, pin }, { renderer: stubRenderer(sized(MAX_PIN_SCHEMA_BYTES - 1_000)).renderer });
    expect(fits.success).toBe(true);
    expect(MAX_PIN_SCHEMA_BYTES).toBe(512 * 1024);
  });

  it("turns every render failure into the one generic message and logs the original", async () => {
    const ctx = await testContext(prisma);
    const sc = await scope(ctx);
    const order = await sc.entity("Order");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const RAW = "tsp compile failed at /tmp/superschema-tsp-ab12cd/main.tsp:3:5 - error: Unknown identifier Foo";
    const pin = { entityId: order.id, entityVersionId: null };
    const outcomes: Array<Result<RenderedArtifact> | (() => never)> = [
      err({ code: "ARTIFACT_RENDER_FAILED", message: RAW, details: { cause: "EMITTER_FAILED" } }),
      err({ code: "UNRESOLVED_REFERENCE", message: `Order references Customer, which is not an entity at /Users/dev/x/y/z.ts` }),
      () => { throw new Error(RAW); },
      ok({ artifact: { format: "avro", schema: { type: "record", name: "Order", fields: [] } }, warnings: [] }),
      ok({ artifact: { format: "json-schema", dialect: "2020-12", schema: "not an object" }, warnings: [] }),
    ];
    for (const outcome of outcomes) {
      spy.mockClear();
      const result = await renderPinJsonSchema(ctx, { tenantId: TENANT, pin }, { renderer: stubRenderer(outcome).renderer });
      expect(failureOf(result)).toEqual({ code: "ARTIFACT_RENDER_FAILED", message: PIN_SCHEMA_RENDER_FAILED });
      expect(JSON.stringify(result)).not.toMatch(/tsp|\/tmp|\/Users|Unknown identifier/);
      expect(spy).toHaveBeenCalledTimes(1);
    }
  });
});
