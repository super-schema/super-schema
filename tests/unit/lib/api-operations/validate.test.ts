import { describe, expect, it } from "vitest";

import { operationRecordFromRow } from "@/lib/api-operations/records";
import {
  checkAgainstSiblings,
  checkApiOperation,
  checkServiceOperations,
  liftLegacyBodyParameters,
  parseApiOperation,
  pathTemplateKey,
  toOpenApiDocument,
  validateApiOperation,
  validateApiOperations,
  validateOpenApiDocument,
} from "@/lib/api-operations/validate";
import type { ApiOperation } from "@/types/schemas/api-operation";

const op = (over: Partial<ApiOperation> = {}): ApiOperation => {
  const parsed = parseApiOperation({
    name: "getOrder",
    httpMethod: "GET",
    httpPath: "/orders/{id}",
    parameters: [{ name: "id", type: "string", location: "path", required: true }],
    responses: [{ statusCode: 200, type: "Order" }],
    ...over,
  });
  if (!parsed.success) throw new Error(JSON.stringify(parsed.issues));
  return parsed.data;
};

const messages = (issues: { message: string }[]) => issues.map((i) => i.message).join(" | ");

describe("parseApiOperation", () => {
  it("applies the contract defaults and normalizes (method case, trimmed name / tags, empty operationId, path params required)", () => {
    const parsed = parseApiOperation({
      name: " getOrder ", httpMethod: "get", httpPath: " /orders/{id} ", operationId: "  ", tags: [" a ", "a", ""],
      parameters: [{ name: "id", type: "string", location: "path", required: false }],
    });
    expect(parsed).toEqual({
      success: true,
      data: {
        name: "getOrder", operationId: undefined, summary: "", description: "", httpMethod: "GET", httpPath: "/orders/{id}",
        tags: ["a"], deprecated: false, requestBody: null, responses: [],
        parameters: [{ name: "id", type: "string", isArray: false, location: "path", required: true, description: "" }],
      },
    });
  });

  it("reports readable issues with their field path (never zod's 'received undefined')", () => {
    const parsed = parseApiOperation({ httpMethod: "FETCH", httpPath: "x", parameters: [{ type: "string", location: "body2" }], responses: [{ statusCode: 700 }] });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const byPath = Object.fromEntries(parsed.issues.map((i) => [i.path, i.message]));
    expect(byPath).toMatchObject({
      name: "is required",
      httpMethod: expect.stringMatching(/^must be one of GET, POST/),
      httpPath: 'must start with "/"',
      "parameters.0.name": "is required",
      "parameters.0.location": expect.stringMatching(/^must be one of path, query, header, cookie/),
      "responses.0.statusCode": "must be at most 599",
    });
    expect(messages(parsed.issues)).not.toMatch(/undefined/);
  });

  it("rejects a non-object payload", () => {
    expect(parseApiOperation(null)).toMatchObject({ success: false });
    expect(parseApiOperation([])).toMatchObject({ success: false });
  });
});

describe("liftLegacyBodyParameters", () => {
  it("turns the first `body` parameter into the request body and drops every body parameter", () => {
    const lifted = liftLegacyBodyParameters({
      name: "x",
      parameters: [
        { name: "q", type: "string", location: "query", required: false },
        { name: "body", type: "Order", location: "body", required: false, description: "d" },
        { name: "body2", type: "Other", location: "body", required: true },
      ],
    }) as Record<string, unknown>;
    expect(lifted.parameters).toEqual([{ name: "q", type: "string", location: "query", required: false }]);
    expect(lifted.requestBody).toEqual({ type: "Order", isArray: false, required: false, description: "d" });
  });

  it("keeps an explicit request body over a legacy body parameter, and leaves payloads without one untouched", () => {
    const explicit = { type: "Explicit" };
    expect((liftLegacyBodyParameters({ parameters: [{ location: "body", type: "Order" }], requestBody: explicit }) as { requestBody: unknown }).requestBody).toBe(explicit);
    const plain = { parameters: [{ location: "query" }] };
    expect(liftLegacyBodyParameters(plain)).toBe(plain);
    expect(liftLegacyBodyParameters("x")).toBe("x");
  });
});

describe("checkApiOperation", () => {
  it("accepts a well-formed operation", () => {
    expect(checkApiOperation(op())).toEqual([]);
    expect(
      checkApiOperation(
        op({
          name: "createOrder", httpMethod: "POST", httpPath: "/orders", operationId: "postOrder",
          parameters: [{ name: "X-Request-Id", type: "uuid", location: "header", required: false, isArray: false, description: "" }],
          requestBody: { type: "Order", isArray: false, contentType: "application/json", required: true, description: "" },
          responses: [{ statusCode: 201, type: "acme.Order", isArray: true, contentType: "application/json", description: "" }, { statusCode: 204, type: null, isArray: false, contentType: "application/json", description: "" }],
        })
      )
    ).toEqual([]);
  });

  it.each<[string, Partial<ApiOperation>, RegExp]>([
    ["a path parameter missing from the path", { httpPath: "/orders" }, /path parameter "id" does not appear in the path/],
    ["a placeholder without a path parameter", { httpPath: "/orders/{id}/lines/{lineId}" }, /\{lineId\} in the path has no path parameter/],
    ["a placeholder twice", { httpPath: "/orders/{id}/{id}" }, /appears more than once/],
    ["a placeholder that is not an identifier", { httpPath: "/orders/{order-id}", parameters: [] }, /"\{order-id\}" must be an identifier/],
    ["an unbalanced brace", { httpPath: "/orders/{id}}" }, /unbalanced/],
    ["a query string in the path", { httpPath: "/orders/{id}?x=1" }, /must not contain/],
    ["a name that is not an identifier", { name: "get-order" }, /"get-order" must be an identifier/],
    ["an operationId that is not an identifier", { operationId: "1abc" }, /"1abc" must be an identifier/],
    ["a query parameter name that is not an identifier", { parameters: [{ name: "id", type: "string", location: "path", required: true, isArray: false, description: "" }, { name: "page size", type: "int32", location: "query", required: false, isArray: false, description: "" }] }, /"page size" must be an identifier/],
    ["a header name with a space", { parameters: [{ name: "id", type: "string", location: "path", required: true, isArray: false, description: "" }, { name: "X Bad", type: "string", location: "header", required: false, isArray: false, description: "" }] }, /not a valid header name/],
    ["a duplicate parameter", { parameters: [{ name: "id", type: "string", location: "path", required: true, isArray: false, description: "" }, { name: "id", type: "string", location: "path", required: true, isArray: false, description: "" }] }, /duplicate path parameter "id"/],
    ["a duplicate header, case-insensitively", { parameters: [{ name: "id", type: "string", location: "path", required: true, isArray: false, description: "" }, { name: "X-A", type: "string", location: "header", required: false, isArray: false, description: "" }, { name: "x-a", type: "string", location: "header", required: false, isArray: false, description: "" }] }, /duplicate header parameter/],
    ["an invalid type name", { responses: [{ statusCode: 200, type: "Order[]", isArray: false, contentType: "application/json", description: "" }] }, /"Order\[\]" is not a primitive type or a valid type name/],
    ["a duplicate status code", { responses: [{ statusCode: 200, type: null, isArray: false, contentType: "application/json", description: "" }, { statusCode: 200, type: null, isArray: false, contentType: "application/json", description: "" }] }, /duplicate status code 200/],
    ["a bad media type", { requestBody: { type: "Order", isArray: false, contentType: "json", required: true, description: "" } }, /"json" is not a media type/],
  ])("reports %s", (_label, over, message) => {
    expect(messages(checkApiOperation(op(over)))).toMatch(message);
  });
});

describe("sibling rules", () => {
  it("normalizes path templates (placeholder names, trailing slash)", () => {
    expect(pathTemplateKey("/orders/{id}/")).toBe("/orders/{}");
    expect(pathTemplateKey("/")).toBe("/");
  });

  it("rejects the same method on the same path template, whatever the placeholder is called", () => {
    const sibling = op({ name: "readOrder", httpPath: "/orders/{orderId}", parameters: [{ name: "orderId", type: "string", location: "path", required: true, isArray: false, description: "" }] });
    expect(messages(checkAgainstSiblings(op(), [sibling]))).toMatch(/GET \/orders\/\{id\} is already defined by "readOrder"/);
  });

  it("rejects a differently-spelled template on another method (OpenAPI would see one path twice), accepts the same spelling", () => {
    const put = op({ name: "putOrder", httpMethod: "PUT", httpPath: "/orders/{orderId}", parameters: [{ name: "orderId", type: "string", location: "path", required: true, isArray: false, description: "" }] });
    expect(messages(checkAgainstSiblings(op(), [put]))).toMatch(/names its path parameters differently/);
    expect(checkAgainstSiblings(op(), [op({ name: "putOrder", httpMethod: "PUT" })])).toEqual([]);
  });

  it("rejects a duplicate effective operationId (operationId, else name)", () => {
    expect(messages(checkAgainstSiblings(op({ httpMethod: "PUT" }), [op()]))).toMatch(/operationId "getOrder" is already used/);
    expect(messages(checkAgainstSiblings(op({ name: "a", operationId: "shared", httpMethod: "PUT" }), [op({ operationId: "shared" })]))).toMatch(/"shared" is already used/);
  });

  it("checkServiceOperations prefixes each issue with its operation index", () => {
    const issues = checkServiceOperations([op(), op({ name: "dup", httpPath: "/orders/{id}/" })]);
    expect(issues).toEqual([{ path: "operations.1.httpPath", message: expect.stringMatching(/already defined by "getOrder"/) }]);
  });
});

describe("toOpenApiDocument + @scalar/openapi-parser", () => {
  it("assembles a valid OpenAPI 3.1 document with placeholder component schemas", async () => {
    const doc = toOpenApiDocument(
      [
        op({ tags: ["orders"], summary: "Get", deprecated: true }),
        op({
          name: "createOrder", httpMethod: "POST", httpPath: "/orders", parameters: [],
          requestBody: { type: "Order", isArray: true, contentType: "application/json", required: true, description: "orders" },
          responses: [{ statusCode: 201, type: "Order", isArray: false, contentType: "application/json", description: "" }, { statusCode: 204, type: null, isArray: false, contentType: "application/json", description: "" }],
        }),
      ],
      { title: "Orders", basePath: "/api/" }
    );
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths ?? {})).toEqual(["/api/orders/{id}", "/api/orders"]);
    expect(doc.paths?.["/api/orders/{id}"]?.get).toMatchObject({
      operationId: "getOrder", summary: "Get", tags: ["orders"], deprecated: true,
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: { "200": { description: "200 response", content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } } } },
    });
    expect(doc.paths?.["/api/orders"]?.post?.requestBody).toEqual({
      required: true, description: "orders",
      content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Order" } } } },
    });
    expect(doc.components?.schemas).toEqual({ Order: { type: "object" } });
    expect(await validateOpenApiDocument(doc)).toEqual([]);
  });

  it("maps every primitive and validates", async () => {
    const primitives = ["string", "int32", "int64", "float", "double", "boolean", "date", "date-time", "uuid", "bytes"];
    const doc = toOpenApiDocument([
      op({
        name: "search", httpPath: "/search", responses: [],
        parameters: primitives.map((type, i) => ({ name: `p${i}`, type, location: "query" as const, required: false, isArray: i % 2 === 0, description: "" })),
      }),
    ]);
    expect(doc.components).toBeUndefined();
    expect(await validateOpenApiDocument(doc)).toEqual([]);
  });

  it("reports what the OpenAPI schema rejects, without ajv's combinator noise", async () => {
    const issues = await validateOpenApiDocument({
      openapi: "3.1.0", info: { title: "x", version: "1" },
      paths: { "/a/{id}": { get: { parameters: [{ name: "id", in: "path", required: false, schema: { type: "string" } }], responses: { "200": { description: "ok" } } } } },
    });
    expect(issues.length).toBeGreaterThan(0);
    expect(messages(issues)).toMatch(/^OpenAPI: /);
    expect(messages(issues)).not.toMatch(/if must match/);
  });
});

describe("validateApiOperation / validateApiOperations", () => {
  it("passes a valid operation and returns it normalized", async () => {
    expect(await validateApiOperation({ name: "getOrder", httpMethod: "get", httpPath: "/orders/{id}", parameters: [{ name: "id", type: "string", location: "path" }] })).toMatchObject({
      valid: true,
      operation: { httpMethod: "GET", parameters: [{ required: true }] },
    });
  });

  it("stops at the first failing stage: shape, then rules, then siblings", async () => {
    expect(await validateApiOperation({ name: "x" })).toMatchObject({ valid: false, issues: expect.arrayContaining([{ path: "httpMethod", message: "is required" }]) });
    expect(await validateApiOperation({ name: "x", httpMethod: "GET", httpPath: "/a/{id}" })).toMatchObject({ valid: false });
    expect(await validateApiOperation({ name: "x", httpMethod: "GET", httpPath: "/orders" }, [op({ name: "y", httpPath: "/orders", parameters: [] })])).toMatchObject({
      valid: false, issues: [{ path: "httpPath", message: expect.stringMatching(/already defined/) }],
    });
  });

  it("stores an OPTIONS operation with a warning that it is not generated (never blocking the save)", async () => {
    const one = await validateApiOperation({ name: "preflight", httpMethod: "options", httpPath: "/orders" });
    expect(one).toMatchObject({ valid: true, operation: { httpMethod: "OPTIONS" } });
    expect(one.valid && one.warnings).toEqual([{ path: "httpMethod", message: expect.stringMatching(/left out of the generated OpenAPI document/) }]);
    const plain = await validateApiOperation({ name: "getOrders", httpMethod: "GET", httpPath: "/orders" });
    expect(plain.valid && plain.warnings).toEqual([]);
    const service = await validateApiOperations([
      { name: "getOrders", httpMethod: "GET", httpPath: "/orders" },
      { name: "preflight", httpMethod: "OPTIONS", httpPath: "/orders" },
    ]);
    expect(service.valid && service.warnings).toEqual([{ path: "operations.1.httpMethod", message: expect.stringMatching(/OPTIONS/) }]);
  });

  it("validates a whole service and returns its OpenAPI document", async () => {
    const result = await validateApiOperations([
      { name: "listOrders", httpMethod: "GET", httpPath: "/orders", responses: [{ statusCode: 200, type: "Order", isArray: true }] },
      { name: "getOrder", httpMethod: "GET", httpPath: "/orders/{id}", parameters: [{ name: "id", type: "string", location: "path" }] },
    ]);
    expect(result.valid).toBe(true);
    if (result.valid) expect(Object.keys(result.document.paths ?? {})).toEqual(["/orders", "/orders/{id}"]);

    const bad = await validateApiOperations([{ name: "a", httpMethod: "GET", httpPath: "/x" }, { name: "b", httpMethod: "GET" }]);
    expect(bad).toMatchObject({ valid: false, issues: [{ path: "operations.1.httpPath", message: "is required" }] });
  });
});

describe("operationRecordFromRow (stored rows -> contract)", () => {
  const row = {
    id: "op-1", serviceId: "svc-1", name: "createOrder", description: "", httpMethod: "post", httpPath: "orders",
    parameters: [
      { name: "q", type: "string", location: "query", required: false, description: "", sortOrder: 1 },
      { name: "body", type: "Order", location: "body", required: true, description: "the order", sortOrder: 0 },
      { name: "h", type: "string", location: "weird", required: false, description: "", sortOrder: 2 },
    ],
    responses: [
      { statusCode: 404, type: null, description: "", sortOrder: 1 },
      { statusCode: 201, type: "Order", description: "created", sortOrder: 0 },
    ],
  };

  it("maps a pre-contract row: legacy body parameter -> requestBody, method upper-cased, defaults, sortOrder respected", () => {
    expect(operationRecordFromRow(row)).toEqual({
      id: "op-1", serviceId: "svc-1", name: "createOrder", summary: "", description: "", httpMethod: "POST", httpPath: "/orders",
      tags: [], deprecated: false,
      requestBody: { type: "Order", isArray: false, contentType: "application/json", required: true, description: "the order" },
      parameters: [
        { name: "q", type: "string", isArray: false, location: "query", required: false, description: "" },
        { name: "h", type: "string", isArray: false, location: "query", required: false, description: "" },
      ],
      responses: [
        { statusCode: 201, type: "Order", isArray: false, contentType: "application/json", description: "created" },
        { statusCode: 404, type: null, isArray: false, contentType: "application/json", description: "" },
      ],
    });
  });

  it("reads the contract columns, preferring a stored request body and ignoring malformed JSON", () => {
    const rec = operationRecordFromRow({
      ...row, operationId: "postOrder", summary: "S", tags: ["a"], deprecated: true,
      requestBody: { type: "Stored", isArray: true, contentType: "application/xml", required: false, description: "" },
    });
    expect(rec).toMatchObject({ operationId: "postOrder", summary: "S", tags: ["a"], deprecated: true, requestBody: { type: "Stored", isArray: true } });
    expect(operationRecordFromRow({ ...row, parameters: [], tags: "nope", requestBody: { type: 5 } })).toMatchObject({ tags: [], requestBody: null });
  });
});
