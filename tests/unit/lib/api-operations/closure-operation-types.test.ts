/**
 * The reference closure follows the type names an entity's API operations use (response / request body / parameter = another entity), so
 * that entity is a member of the closure and the OpenAPI 3 document types it (real `tsp compile`, validated by @scalar/openapi-parser)
 * instead of `unknown`. Same rules as the walk's other edges: resolved by name nearest place first among the entities the caller may read,
 * unpinned (published mode reads the latest published version; never published is refused), a name several entities answer to equally
 * well is a note and stays unresolved.
 */
import { describe, it, expect, vi } from "vitest";
import { parse as parseYaml } from "yaml";

vi.setConfig({ testTimeout: 60_000 });
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { loadReferenceClosure, type ClosurePlace } from "@/lib/references/closure";
import { emitClosure, filesForEntity } from "@/lib/typespec-official/closure-emit";
import { emitOfficialTypeSpecTargetFromData } from "@/lib/typespec-official/emitter.service";
import { toApiOperations, type ApiOperationRowLike } from "@/lib/api-operations/to-typespec";
import type { PrismaEntityInput } from "@/lib/compiler/compiler.service";
import { validateOpenApi } from "../../../helpers/corpus/validators";

type Row = {
  id: string;
  name: string;
  domain?: string;
  product?: string;
  tenantId?: string;
  fields?: Array<{ name: string; type: string; isKey?: boolean }>;
  operations?: ApiOperationRowLike[];
  /** A published version: its fields and the operations its snapshot froze. */
  published?: { fields: Array<{ name: string; type: string }>; operations?: ApiOperationRowLike[] };
  metadata?: unknown;
};

const toField = (entityId: string) => (f: { name: string; type: string; isKey?: boolean }, i: number) => ({
  id: `${entityId}-${f.name}`, name: f.name, type: f.type, precision: null, scale: null, nullable: false, isKey: f.isKey ?? false,
  fieldNumber: null, description: "", classification: null, aliases: [], decorators: {}, sortOrder: i,
});

/** A Prisma double with exactly what the closure loader reads (tenant index, metadata, fields, versions, entity-scoped services). */
function fakeDb(rows: Row[]) {
  return {
    entity: {
      findMany: async (args: { where: { tenantId: string } }) =>
        rows
          .filter((r) => (r.tenantId ?? "t1") === args.where.tenantId)
          .map((r) => ({
            id: r.id, name: r.name, description: "", status: "DRAFT", version: 1,
            domainId: r.domain ? `d-${r.domain}` : null,
            productId: r.product ? `p-${r.product}` : null,
            latestVersionId: r.published ? `${r.id}-v1` : null,
            domain: r.domain ? { id: `d-${r.domain}`, name: r.domain, slug: r.domain.toLowerCase() } : null,
            product: r.product ? { name: r.product, domainId: r.domain ? `d-${r.domain}` : null } : null,
          })),
      findUnique: async (args: { where: { id: string } }) => {
        const row = rows.find((r) => r.id === args.where.id);
        return row ? { metadata: row.metadata ?? {} } : null;
      },
    },
    field: {
      findMany: async ({ where }: { where: { entityId: string } }) => (rows.find((r) => r.id === where.entityId)?.fields ?? []).map(toField(where.entityId)),
    },
    entityVersion: {
      findUnique: async ({ where }: { where: { id?: string } }) => {
        const row = rows.find((r) => r.published && `${r.id}-v1` === where.id);
        if (!row?.published) return null;
        return {
          id: `${row.id}-v1`, entityId: row.id, major: 1, minor: 0, patch: 0, stage: "RELEASED", sequence: 10,
          fieldSnapshot: row.published.fields.map(toField(row.id)),
          compatReport: {
            entitySnapshot: {
              name: row.name, description: "", status: "ACTIVE", metadata: {},
              ...(row.published.operations ? { apiOperations: toApiOperations(row.published.operations) } : {}),
            },
          },
        };
      },
    },
    serviceDefinition: {
      findMany: async ({ where }: { where: { entityId: string } }) => {
        const row = rows.find((r) => r.id === where.entityId);
        return row?.operations ? [{ basePath: "/", operations: row.operations }] : [];
      },
    },
  } as never;
}

const getCustomer: ApiOperationRowLike = {
  name: "getBuyer",
  httpMethod: "GET",
  httpPath: "/orders/{id}/buyer",
  parameters: [{ name: "id", type: "uuid", location: "path", required: true }],
  responses: [{ statusCode: 200, type: "Customer", description: "The buyer" }],
};
const ORDER_FIELDS = [{ name: "id", type: "uuid", isKey: true }, { name: "qty", type: "int32" }];
const CUSTOMER_FIELDS = [{ name: "id", type: "uuid", isKey: true }, { name: "name", type: "string" }];
const names = (r: { entities: Array<{ ref: { entity: string } }> }) => r.entities.map((e) => e.ref.entity);

type Doc = { paths: Record<string, Record<string, { responses: Record<string, unknown>; requestBody?: unknown }>>; components?: { schemas?: Record<string, unknown> } };

describe("closure loader: entities named by API operations", () => {
  it("adds the entity an operation returns (no reference field), records the resolution, and the OpenAPI document types it", async () => {
    const db = fakeDb([
      { id: "o", name: "Order", domain: "Sales", product: "Orders", fields: ORDER_FIELDS, operations: [getCustomer] },
      { id: "c", name: "Customer", domain: "Sales", product: "Orders", fields: CUSTOMER_FIELDS },
    ]);
    const loaded = await loadReferenceClosure(db, "t1", "o", "draft");
    if (!loaded.success) throw new Error(JSON.stringify(loaded.error));
    expect(names(loaded.data)).toEqual(["Order", "Customer"]);
    expect(loaded.data.root.operationTypes).toEqual({ Customer: "c" });
    // operation types are not reference edges: no cycle, no graph entry
    expect(loaded.data.cycles).toEqual([]);

    const emitted = await emitClosure(loaded.data, "openapi3");
    if (!emitted.success) throw new Error(JSON.stringify(emitted.error));
    expect(emitted.data.warnings.filter((w) => /Operation|unknown/.test(w))).toEqual([]);
    const [orderFile] = filesForEntity(emitted.data.files, "o");
    expect((await validateOpenApi(orderFile.content)).ok).toBe(true);
    const doc = parseYaml(orderFile.content) as Doc;
    expect(JSON.stringify(doc.paths["/orders/{id}/buyer"].get.responses)).toMatch(/#\/components\/schemas\/Customer"/);
    expect(doc.components?.schemas?.Customer).toMatchObject({ type: "object" });
  });

  it("follows request body and parameter types too, and an entity's own data types are never looked up as entities", async () => {
    const metadata = { custom: { sharedEnums: [{ name: "Status", values: ["open", "closed"] }] } };
    const db = fakeDb([
      {
        id: "o", name: "Order", domain: "Sales", product: "Orders", fields: ORDER_FIELDS, metadata,
        operations: [
          { name: "attach", httpMethod: "POST", httpPath: "/orders/{id}/lines", parameters: [{ name: "id", type: "uuid", location: "path" }, { name: "lines", type: "Line[]", location: "body" }], responses: [{ statusCode: 204 }] },
          { name: "byStatus", httpMethod: "GET", httpPath: "/orders", parameters: [{ name: "status", type: "Status", location: "query" }], responses: [{ statusCode: 200, type: "Order", isArray: true }] },
        ],
      },
      { id: "l", name: "Line", domain: "Sales", product: "Orders", fields: [{ name: "sku", type: "string" }] },
      // an entity named like Order's own enum: the enum wins, this one is not pulled in
      { id: "s", name: "Status", domain: "Sales", product: "Orders", fields: [{ name: "code", type: "string" }] },
    ]);
    const loaded = await loadReferenceClosure(db, "t1", "o", "draft");
    if (!loaded.success) throw new Error(JSON.stringify(loaded.error));
    expect(names(loaded.data)).toEqual(["Order", "Line"]);
    expect(loaded.data.root.operationTypes).toEqual({ Line: "l" });
  });

  it("resolves a name nearest place first, and notes (without resolving) a name several entities answer to equally well", async () => {
    const twoCustomers = [
      { id: "c1", name: "Customer", domain: "Sales", product: "Orders", fields: CUSTOMER_FIELDS },
      { id: "c2", name: "Customer", domain: "Billing", product: "Invoices", fields: CUSTOMER_FIELDS },
    ];
    const near = await loadReferenceClosure(fakeDb([{ id: "o", name: "Order", domain: "Sales", product: "Orders", fields: ORDER_FIELDS, operations: [getCustomer] }, ...twoCustomers]), "t1", "o", "draft");
    if (!near.success) throw new Error(JSON.stringify(near.error));
    expect(near.data.entities.map((e) => e.entityId)).toEqual(["o", "c1"]);

    const far = await loadReferenceClosure(fakeDb([{ id: "o", name: "Order", domain: "Ops", product: "Desk", fields: ORDER_FIELDS, operations: [getCustomer] }, ...twoCustomers]), "t1", "o", "draft");
    if (!far.success) throw new Error(JSON.stringify(far.error));
    expect(names(far.data)).toEqual(["Order"]);
    expect(far.data.notes.join("\n")).toMatch(/operation "getBuyer" uses the type "Customer", which 2 entities answer to equally well/);
  });

  it("only resolves among entities the caller may read: an unreadable one is neither added nor a refusal (it reads as no match)", async () => {
    const db = fakeDb([
      { id: "o", name: "Order", domain: "Sales", product: "Orders", fields: ORDER_FIELDS, operations: [getCustomer] },
      { id: "c", name: "Customer", domain: "Secret", product: "Vault", fields: CUSTOMER_FIELDS },
    ]);
    const reader = (place: ClosurePlace) => place.domainId !== "d-Secret";
    const loaded = await loadReferenceClosure(db, "t1", "o", "draft", { reader });
    if (!loaded.success) throw new Error(JSON.stringify(loaded.error));
    expect(names(loaded.data)).toEqual(["Order"]);
    expect(loaded.data.notes).toEqual([]);
  });

  it("is tenant-scoped: an entity of another tenant never answers", async () => {
    const db = fakeDb([
      { id: "o", name: "Order", domain: "Sales", product: "Orders", fields: ORDER_FIELDS, operations: [getCustomer] },
      { id: "c", name: "Customer", domain: "Sales", product: "Orders", fields: CUSTOMER_FIELDS, tenantId: "t2" },
    ]);
    const loaded = await loadReferenceClosure(db, "t1", "o", "draft");
    if (!loaded.success) throw new Error(JSON.stringify(loaded.error));
    expect(names(loaded.data)).toEqual(["Order"]);
  });

  it("published mode: the frozen operations are followed to the target's latest published version; a never-published target is refused", async () => {
    const order: Row = { id: "o", name: "Order", domain: "Sales", product: "Orders", fields: ORDER_FIELDS, published: { fields: ORDER_FIELDS, operations: [getCustomer] } };
    const published = await loadReferenceClosure(
      fakeDb([order, { id: "c", name: "Customer", domain: "Sales", product: "Orders", fields: [...CUSTOMER_FIELDS, { name: "draftOnly", type: "string" }], published: { fields: CUSTOMER_FIELDS } }]),
      "t1",
      "o",
      "published"
    );
    if (!published.success) throw new Error(JSON.stringify(published.error));
    const customer = published.data.entities.find((e) => e.entityId === "c");
    expect(customer?.source).toBe("published");
    expect(customer?.fields.map((f) => f.name)).toEqual(["id", "name"]);

    const never = await loadReferenceClosure(fakeDb([order, { id: "c", name: "Customer", domain: "Sales", product: "Orders", fields: CUSTOMER_FIELDS }]), "t1", "o", "published");
    expect(never.success).toBe(false);
    if (!never.success) expect(never.error.code).toBe("NEVER_PUBLISHED");
  });
});

describe("OpenAPI 3 output: OPTIONS and arrays of uuids", () => {
  const ORDER: PrismaEntityInput = {
    id: "o", name: "Order", description: "", status: "DRAFT", version: 1, domainId: "d", metadata: {}, domain: { id: "d", name: "Sales", slug: "sales" },
  };
  const fields = ORDER_FIELDS.map(toField("o"));

  it("an OPTIONS operation is left out of the document and the Generate result says why", async () => {
    const apiOperations = toApiOperations([
      { name: "listOrders", httpMethod: "GET", httpPath: "/orders", responses: [{ statusCode: 200, type: "Order", isArray: true }] },
      { name: "preflight", httpMethod: "OPTIONS", httpPath: "/orders", responses: [{ statusCode: 204 }] },
    ]);
    const result = await emitOfficialTypeSpecTargetFromData({ ...ORDER, apiOperations }, fields, "openapi3");
    expect(result.errors).toEqual([]);
    expect(result.warnings.join("\n")).toMatch(/OPTIONS \/orders is not in the OpenAPI document: @typespec\/http can only write GET, PUT, POST, PATCH, DELETE and HEAD/);
    expect((await validateOpenApi(result.output)).ok).toBe(true);
    const doc = parseYaml(result.output) as Doc;
    expect(Object.keys(doc.paths["/orders"])).toEqual(["get"]);
  });

  it("an array of uuids keeps format uuid on its items (query parameter, request body, response), a single uuid stays inline", async () => {
    const apiOperations = toApiOperations([
      {
        name: "getOrders",
        httpMethod: "GET",
        httpPath: "/orders/{id}",
        parameters: [{ name: "id", type: "uuid", location: "path" }, { name: "related", type: "uuid", location: "query", isArray: true }],
        responses: [{ statusCode: 200, type: "uuid", isArray: true }],
      },
      { name: "bulk", httpMethod: "POST", httpPath: "/orders/bulk", requestBody: { type: "uuid", isArray: true }, responses: [{ statusCode: 204 }] },
    ]);
    const result = await emitOfficialTypeSpecTargetFromData({ ...ORDER, apiOperations }, fields, "openapi3");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect((await validateOpenApi(result.output)).ok).toBe(true);
    const doc = parseYaml(result.output) as Doc & {
      paths: Record<string, Record<string, { parameters?: Array<{ name: string; schema: Record<string, unknown> }> }>>;
    };
    const schemas = doc.components?.schemas ?? {};
    // the items resolve (inline or by $ref) to { type: string, format: uuid }
    const deref = (s: unknown): Record<string, unknown> => {
      const ref = (s as { $ref?: string }).$ref;
      return ref ? (schemas[ref.split("/").pop() as string] as Record<string, unknown>) : (s as Record<string, unknown>);
    };
    const get = doc.paths["/orders/{id}"].get;
    const id = get.parameters?.find((p) => p.name === "id");
    expect(id?.schema).toEqual({ type: "string", format: "uuid" });
    const related = get.parameters?.find((p) => p.name === "related");
    expect(related?.schema.type).toBe("array");
    expect(deref(related?.schema.items)).toMatchObject({ type: "string", format: "uuid" });
    const response = (get.responses["200"] as { content: Record<string, { schema: { type: string; items: unknown } }> }).content["application/json"].schema;
    expect(response.type).toBe("array");
    expect(deref(response.items)).toMatchObject({ type: "string", format: "uuid" });
    const body = (doc.paths["/orders/bulk"].post.requestBody as { content: Record<string, { schema: { type: string; items: unknown } }> }).content["application/json"].schema;
    expect(body.type).toBe("array");
    expect(deref(body.items)).toMatchObject({ type: "string", format: "uuid" });
  });

  it("an array of uuids in a multi-entity closure compiles and validates (the scalar is declared per entity, no clash)", async () => {
    const uuidsOp = (path: string): ApiOperationRowLike => ({ name: "ids", httpMethod: "GET", httpPath: path, responses: [{ statusCode: 200, type: "uuid", isArray: true }] });
    const db = fakeDb([
      { id: "o", name: "Order", domain: "Sales", product: "Orders", fields: ORDER_FIELDS, operations: [getCustomer, uuidsOp("/orders/ids")] },
      { id: "c", name: "Customer", domain: "Sales", product: "Orders", fields: CUSTOMER_FIELDS, operations: [uuidsOp("/customers/ids")] },
    ]);
    const loaded = await loadReferenceClosure(db, "t1", "o", "draft");
    if (!loaded.success) throw new Error(JSON.stringify(loaded.error));
    const emitted = await emitClosure(loaded.data, "openapi3");
    if (!emitted.success) throw new Error(JSON.stringify(emitted.error));
    for (const id of ["o", "c"]) {
      const [file] = filesForEntity(emitted.data.files, id);
      expect((await validateOpenApi(file.content)).ok).toBe(true);
      const doc = parseYaml(file.content) as Doc;
      const path = id === "o" ? "/orders/ids" : "/customers/ids";
      const schema = (doc.paths[path].get.responses["200"] as { content: Record<string, { schema: { type: string; items: { $ref?: string } } }> }).content["application/json"].schema;
      expect(schema.type).toBe("array");
      const items = schema.items.$ref ? doc.components?.schemas?.[schema.items.$ref.split("/").pop() as string] : schema.items;
      expect(items).toMatchObject({ type: "string", format: "uuid" });
    }
  });
});
