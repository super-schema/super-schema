import { describe, it, expect } from "vitest";
import { apiOperationsTypeSpec, primitiveTypeSpecScalar, readApiOperations, toApiOperations } from "@/lib/api-operations/to-typespec";
import type { ApiOperation } from "@/types/schemas/api-operation";

const op = (over: Partial<ApiOperation> = {}): ApiOperation => ({
  name: "getOrder",
  summary: "",
  description: "",
  httpMethod: "GET",
  httpPath: "/orders/{id}",
  tags: [],
  deprecated: false,
  parameters: [{ name: "id", location: "path", type: "string", isArray: false, required: true, description: "" }],
  requestBody: null,
  responses: [{ statusCode: 200, type: "Order", isArray: false, contentType: "application/json", description: "" }],
  ...over,
});

const resolveOrder = (name: string) => (name === "Order" ? "Order" : null);

describe("readApiOperations (adapter)", () => {
  it("reads a legacy row: body parameter -> requestBody, `Order[]` -> array, lowercase method, base path", () => {
    const [read] = toApiOperations(
      [
        {
          name: "createOrders",
          httpMethod: "post",
          httpPath: "orders",
          description: "make",
          parameters: [
            { name: "payload", type: "Order[]", location: "body", required: true, description: "the orders" },
            { name: "dryRun", type: "bool", location: "query", required: false },
          ],
          responses: [{ statusCode: 201, type: "Order[]", description: "created" }, { statusCode: 400, type: null }],
        },
      ],
      { basePath: "/v1/" }
    );
    expect(read.httpMethod).toBe("POST");
    expect(read.httpPath).toBe("/v1/orders");
    expect(read.requestBody).toEqual({ type: "Order", isArray: true, required: true, description: "the orders", contentType: "application/json" });
    expect(read.parameters).toEqual([{ name: "dryRun", location: "query", type: "boolean", isArray: false, required: false, description: "" }]);
    expect(read.responses).toEqual([
      { statusCode: 201, type: "Order", isArray: true, contentType: "application/json", description: "created" },
      { statusCode: 400, type: null, isArray: false, contentType: "application/json", description: "" },
    ]);
  });

  it("reads a Phase A row (Json columns, isArray, sortOrder) and a contract object unchanged", () => {
    const contract = op({ tags: ["orders"], operationId: "fetchOrder" });
    const phaseA = {
      ...contract,
      operationId: null,
      tags: ["a", 3, ""] as unknown,
      requestBody: null,
      parameters: [
        { name: "b", type: "int64", location: "header", isArray: true, required: false, description: "", sortOrder: 2 },
        { name: "a", type: "uuid", location: "cookie", isArray: false, required: true, description: "", sortOrder: 1 },
      ],
    };
    const { operations, issues } = readApiOperations([contract, phaseA]);
    expect(issues).toEqual([]);
    expect(operations[0]).toEqual(contract);
    expect(operations[1].operationId).toBeUndefined();
    expect(operations[1].tags).toEqual(["a"]);
    expect(operations[1].parameters.map((p) => p.name)).toEqual(["a", "b"]);
  });

  it("leaves out an invalid row and reports it, keeping the others", () => {
    const { operations, issues } = readApiOperations([{ name: "bad", httpMethod: "TRACE", httpPath: "/x" }, op()]);
    expect(operations).toHaveLength(1);
    expect(issues).toHaveLength(1);
    expect(issues[0].name).toBe("bad");
  });
});

describe("apiOperationsTypeSpec", () => {
  it("maps the contract primitives to TypeSpec scalars", () => {
    expect(primitiveTypeSpecScalar("date-time")).toBe("utcDateTime");
    expect(primitiveTypeSpecScalar("date")).toBe("plainDate");
    expect(primitiveTypeSpecScalar("float")).toBe("float32");
    expect(primitiveTypeSpecScalar("double")).toBe("float64");
    expect(primitiveTypeSpecScalar("bytes")).toBe("bytes");
    expect(primitiveTypeSpecScalar("Order")).toBeUndefined();
  });

  it("writes route, verb, parameters, body, responses, tags, operationId, deprecation and docs", () => {
    const { lines, warnings } = apiOperationsTypeSpec(
      [
        op({
          description: "Get one",
          summary: "Fetch",
          tags: ["orders"],
          deprecated: true,
          parameters: [
            { name: "id", location: "path", type: "uuid", isArray: false, required: true, description: "" },
            { name: "page-size", location: "query", type: "int32", isArray: false, required: false, description: "Page" },
            { name: "ids", location: "query", type: "int64", isArray: true, required: false, description: "" },
          ],
          responses: [
            { statusCode: 200, type: "Order", isArray: true, contentType: "application/json", description: "" },
            { statusCode: 404, type: null, isArray: false, contentType: "application/json", description: "Not here" },
          ],
        }),
      ],
      { interfaceName: "OrderOperations", resolveNamedType: resolveOrder }
    );
    const text = lines.join("\n");
    expect(warnings).toEqual([]);
    expect(text).toContain("interface OrderOperations {");
    expect(text).toContain('@route("/orders/{id}")');
    expect(text).toContain("@get");
    expect(text).toContain('#deprecated "This operation is deprecated."');
    expect(text).toContain('@tag("orders")');
    expect(text).toContain('@summary("Fetch")');
    expect(text).toContain('@TypeSpec.OpenAPI.operationId("getOrder")');
    expect(text).toContain('@format("uuid") @path("id") id: string');
    expect(text).toContain('@doc("Page") @query("page-size") `page-size`?: int32');
    expect(text).toContain('@query(#{ name: "ids", explode: true }) ids?: int64[]');
    expect(text).toContain("@body body: Order[];");
    expect(text).toContain("model OrderOperations_getOrder_404 {");
  });

  it("types an unknown name `unknown` and skips what cannot be written, with warnings", () => {
    const { lines, warnings } = apiOperationsTypeSpec(
      [
        op({ responses: [{ statusCode: 200, type: "Invoice", isArray: false, contentType: "application/json", description: "" }] }),
        op({ name: "again", httpPath: "/orders/{orderId}" }),
        op({ name: "opts", httpMethod: "OPTIONS" }),
        op({ name: "noParam", httpPath: "/x/{k}", parameters: [{ name: "zz", location: "path", type: "string", isArray: false, required: true, description: "" }], responses: [] }),
      ],
      { interfaceName: "I", resolveNamedType: resolveOrder }
    );
    const text = lines.join("\n");
    expect(text).toContain("@body body: unknown;");
    expect(text).not.toContain("op again");
    expect(text).not.toContain("op opts");
    expect(text).toContain('op noParam(@path("k") k: string): void;');
    expect(warnings.join("\n")).toMatch(/Invoice/);
    expect(warnings.join("\n")).toMatch(/another operation already uses GET/);
    expect(warnings.join("\n")).toMatch(/OPTIONS/);
    expect(warnings.join("\n")).toMatch(/"zz" has no \{zz\}/);
    expect(warnings.join("\n")).toMatch(/\{k\} .* has no path parameter/);
  });

  it("says why an OPTIONS operation is left out (TypeSpec HTTP has no OPTIONS verb)", () => {
    const { lines, warnings } = apiOperationsTypeSpec([op({ name: "preflight", httpMethod: "OPTIONS", httpPath: "/orders" })], { interfaceName: "I", resolveNamedType: resolveOrder });
    expect(lines).toEqual([]);
    expect(warnings).toEqual([
      'Operation "preflight": OPTIONS /orders is not in the OpenAPI document: @typespec/http can only write GET, PUT, POST, PATCH, DELETE and HEAD operations, so the operation is left out.',
    ]);
  });

  it("types an array of uuids by one uuid scalar (declared once), keeping a single uuid a formatted string", () => {
    const uuids = { name: "ids", location: "query" as const, type: "uuid", isArray: true, required: false, description: "" };
    const { lines, warnings } = apiOperationsTypeSpec(
      [
        op({ parameters: [{ name: "id", location: "path", type: "uuid", isArray: false, required: true, description: "" }, uuids] }),
        op({
          name: "bulk",
          httpMethod: "POST",
          httpPath: "/orders/bulk",
          parameters: [],
          requestBody: { type: "uuid", isArray: true, required: true, description: "", contentType: "application/json" },
          responses: [{ statusCode: 200, type: "uuid", isArray: true, contentType: "application/json", description: "The ids" }],
        }),
      ],
      { interfaceName: "OrderOperations", resolveNamedType: resolveOrder }
    );
    const text = lines.join("\n");
    expect(warnings).toEqual([]);
    expect(text.match(/scalar OrderOperationsUuid extends string;/g)).toHaveLength(1);
    expect(text).toContain('@format("uuid")\nscalar OrderOperationsUuid extends string;');
    expect(text).toContain('@format("uuid") @path("id") id: string');
    expect(text).toContain('@query(#{ name: "ids", explode: true }) ids?: OrderOperationsUuid[]');
    expect(text).toContain("@body body: OrderOperationsUuid[]");
    expect(text).not.toMatch(/@format\("uuid"\) @(?:query|body)/);
  });
});

describe("entity snapshot freezes API operations", () => {
  it("round-trips them, drops invalid entries, and omits the key when there are none", async () => {
    const { entitySnapshotReport, readEntitySnapshot } = await import("@/lib/entity-versioning/entity-snapshot");
    const base = { name: "Order", description: "", status: "DRAFT", metadata: {} };
    expect(entitySnapshotReport(base).entitySnapshot).not.toHaveProperty("apiOperations");
    const report = entitySnapshotReport({ ...base, apiOperations: [op()] });
    expect(readEntitySnapshot(report)?.apiOperations).toEqual([op()]);
    const tampered = { entitySnapshot: { ...report.entitySnapshot, apiOperations: [op(), { name: "" }] } };
    expect(readEntitySnapshot(tampered)?.apiOperations).toEqual([op()]);
  });
});
