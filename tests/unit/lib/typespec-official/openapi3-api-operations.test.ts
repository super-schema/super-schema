/**
 * An entity's API operations reach the OpenAPI 3 output as `paths`, through the real `tsp compile` (stand-alone and in a multi-entity
 * closure), and the documents validate with @scalar/openapi-parser.
 */
import { describe, it, expect, vi } from "vitest";
import { parse as parseYaml } from "yaml";

vi.setConfig({ testTimeout: 60_000 });
vi.mock("@/lib/db", () => ({ prisma: {} }));

import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { compileEntity } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import type { ClosureEntity, ReferenceClosure } from "@/lib/references/closure";
import { writeFieldReference, type EntityRef } from "@/lib/references/entity-reference";
import { buildSourceForTarget, emitOfficialTypeSpecTargetFromData } from "@/lib/typespec-official/emitter.service";
import { emitClosure, filesForEntity } from "@/lib/typespec-official/closure-emit";
import { toApiOperations } from "@/lib/api-operations/to-typespec";
import type { ApiOperation } from "@/types/schemas/api-operation";
import { validateOpenApi } from "../../../helpers/corpus/validators";

const field = (name: string, type: string, sortOrder: number, decorators: Record<string, unknown> = {}, isKey = false): PrismaFieldInput => ({
  id: `f-${name}`, name, type, precision: null, scale: null, nullable: false, isKey, fieldNumber: null, description: "", classification: null, aliases: [], decorators, sortOrder,
});

const OPERATIONS: ApiOperation[] = toApiOperations([
  {
    name: "getOrder",
    httpMethod: "GET",
    httpPath: "/orders/{id}",
    summary: "Get an order",
    description: "Returns one order.",
    tags: ["orders"],
    parameters: [
      { name: "id", type: "uuid", location: "path", required: true },
      { name: "X-Trace", type: "string", location: "header", required: false, description: "trace id" },
      { name: "expand", type: "string", location: "query", required: false, isArray: true },
    ],
    responses: [
      { statusCode: 200, type: "Order", description: "The order" },
      { statusCode: 404, type: null, description: "No such order" },
    ],
  },
  {
    name: "createOrder",
    operationId: "orders-create",
    httpMethod: "POST",
    httpPath: "/orders",
    deprecated: true,
    // legacy body parameter
    parameters: [{ name: "order", type: "Order", location: "body", required: true, description: "The new order" }],
    responses: [{ statusCode: 201, type: "Order" }],
  },
  {
    name: "listOrders",
    httpMethod: "GET",
    httpPath: "/orders",
    parameters: [{ name: "since", type: "date-time", location: "query", required: false }],
    responses: [{ statusCode: 200, type: "Order", isArray: true }],
  },
  { name: "deleteOrder", httpMethod: "DELETE", httpPath: "/orders/{id}", parameters: [{ name: "id", type: "uuid", location: "path" }], responses: [{ statusCode: 204 }] },
]);

const ORDER: PrismaEntityInput = {
  id: "o", name: "Order", description: "", status: "DRAFT", version: 1, domainId: "d", metadata: {},
  domain: { id: "d", name: "Sales", slug: "sales" }, apiOperations: OPERATIONS,
};
const UUID_DECORATORS = { typespec: { identity: { format: "uuid" } } };
const ORDER_FIELDS = [field("id", "string", 0, UUID_DECORATORS, true), field("qty", "int32", 1)];

type Doc = { paths: Record<string, Record<string, Record<string, unknown>>>; components?: { schemas?: Record<string, unknown> } };

function assertOrderPaths(doc: Doc, orderRef: RegExp) {
  expect(Object.keys(doc.paths).sort()).toEqual(["/orders", "/orders/{id}"]);
  const get = doc.paths["/orders/{id}"].get as Record<string, unknown> & { parameters: Array<Record<string, unknown>>; responses: Record<string, Record<string, unknown>> };
  expect(get.operationId).toBe("getOrder");
  expect(get.summary).toBe("Get an order");
  expect(get.description).toBe("Returns one order.");
  expect(get.tags).toEqual(["orders"]);
  expect(get.parameters).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }),
      expect.objectContaining({ name: "X-Trace", in: "header", required: false, description: "trace id" }),
      expect.objectContaining({ name: "expand", in: "query", schema: { type: "array", items: { type: "string" } } }),
    ])
  );
  // an array query parameter keeps OpenAPI's default `explode: true` (TypeSpec's own default would write `explode: false`)
  expect(get.parameters.find((p) => p.name === "expand")?.explode).not.toBe(false);
  expect(get.responses["200"].description).toBe("The order");
  expect(JSON.stringify(get.responses["200"].content)).toMatch(orderRef);
  expect(get.responses["404"].description).toBe("No such order");
  expect(get.responses["404"].content).toBeUndefined();

  const post = doc.paths["/orders"].post as Record<string, unknown> & { requestBody: Record<string, unknown>; responses: Record<string, unknown> };
  expect(post.operationId).toBe("orders-create");
  expect(post.deprecated).toBe(true);
  expect(post.requestBody.required).toBe(true);
  expect(post.requestBody.description).toBe("The new order");
  expect(JSON.stringify(post.requestBody.content)).toMatch(orderRef);
  expect(Object.keys(post.responses)).toEqual(["201"]);

  const list = doc.paths["/orders"].get as { parameters: Array<Record<string, unknown>>; responses: Record<string, { content: Record<string, { schema: Record<string, unknown> }> }> };
  expect(list.parameters[0]).toMatchObject({ name: "since", in: "query", schema: { type: "string", format: "date-time" } });
  expect(list.responses["200"].content["application/json"].schema.type).toBe("array");

  expect(Object.keys(doc.paths["/orders/{id}"].delete.responses as object)).toEqual(["204"]);
}

describe("API operations in the OpenAPI 3 output", () => {
  it("stays out of the canonical source and of the other targets", () => {
    const model = compileEntity(ORDER, ORDER_FIELDS);
    expect(model.apiOperations).toHaveLength(4);
    expect(generateTypeSpec(model)).not.toContain("OrderOperations");
    for (const target of ["json-schema", "protobuf", "avro"]) expect(buildSourceForTarget(model, target).source).not.toContain("@route");
  });

  it("a stand-alone entity: compiles, validates, and lists paths / params / requestBody / responses", async () => {
    const result = await emitOfficialTypeSpecTargetFromData(ORDER, ORDER_FIELDS, "openapi3");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect((await validateOpenApi(result.output)).ok).toBe(true);
    const doc = parseYaml(result.output) as Doc;
    assertOrderPaths(doc, /#\/components\/schemas\/Order"/);
    expect(doc.components?.schemas?.Order).toMatchObject({ properties: { id: { type: "string", format: "uuid" } } });
    // response envelopes are not schemas
    expect(Object.keys(doc.components?.schemas ?? {})).toEqual(["Order"]);
  });

  it("reports an operation type that is not in the document and types it unknown", async () => {
    const entity = { ...ORDER, apiOperations: toApiOperations([{ name: "x", httpMethod: "GET", httpPath: "/x", responses: [{ statusCode: 200, type: "Invoice" }] }]) };
    const result = await emitOfficialTypeSpecTargetFromData(entity, ORDER_FIELDS, "openapi3");
    expect(result.validationStatus).toBe("WARNING");
    expect(result.warnings.join("\n")).toMatch(/"Invoice" is not part of this schema/);
    expect((await validateOpenApi(result.output)).ok).toBe(true);
  });

  it("a multi-entity closure: each entity's operations are paths of its own document, with qualified types", async () => {
    const customerRef: EntityRef & { entityId: string } = { entityId: "c", domain: "Sales", product: "Orders", entity: "Customer" };
    const member = (id: string, name: string, fields: PrismaFieldInput[], apiOperations?: ApiOperation[]): ClosureEntity => ({
      entityId: id,
      ref: { entityId: id, domain: "Sales", product: "Orders", entity: name },
      source: "draft",
      fields,
      entity: { id, name, description: "", status: "DRAFT", version: 1, domainId: null, metadata: {}, domain: null, ...(apiOperations ? { apiOperations } : {}) },
    });
    // Order's operations also return a Customer (another member of the closure).
    const withCustomer = [
      ...OPERATIONS,
      ...toApiOperations([{ name: "getBuyer", httpMethod: "GET", httpPath: "/orders/{id}/buyer", parameters: [{ name: "id", type: "uuid", location: "path" }], responses: [{ statusCode: 200, type: "Customer" }] }]),
    ];
    const order = member("o", "Order", [...ORDER_FIELDS, field("buyer", "reference", 2, writeFieldReference({}, customerRef) as Record<string, unknown>)], withCustomer);
    const customer = member("c", "Customer", [field("id", "string", 0, UUID_DECORATORS, true), field("name", "string", 1)]);
    const closure: ReferenceClosure = { root: order, entities: [order, customer], draftEntities: [], cycles: [], upgrades: [], notes: [] };

    const emitted = await emitClosure(closure, "openapi3");
    if (!emitted.success) throw new Error(JSON.stringify(emitted.error));
    expect(emitted.data.warnings.filter((w) => /Operation/.test(w))).toEqual([]);
    const [orderFile] = filesForEntity(emitted.data.files, "o");
    const [customerFile] = filesForEntity(emitted.data.files, "c");
    expect((await validateOpenApi(orderFile.content)).ok).toBe(true);
    const doc = parseYaml(orderFile.content) as Doc;
    const { "/orders/{id}/buyer": buyer, ...rest } = doc.paths;
    assertOrderPaths({ ...doc, paths: rest }, /#\/components\/schemas\/Order"/);
    expect(JSON.stringify(buyer.get.responses)).toMatch(/#\/components\/schemas\/Customer"/);
    // the Customer document has no operations
    expect((parseYaml(customerFile.content) as Doc).paths).toEqual({});
  });
});
