import { describe, expect, it, vi } from "vitest";
import { stringify as toYaml } from "yaml";

import {
  fetchOpenApiText,
  importOpenApiDocument,
  MAX_IMPORTED_OPERATIONS,
  parseOpenApiText,
} from "@/lib/api-operations/import-openapi";
import { validateApiOperations } from "@/lib/api-operations/validate";

// The classic Swagger Petstore (OpenAPI 3.0.0 example from the OAI repository), with a few realistic extras.
const PETSTORE_30 = `
openapi: "3.0.0"
info:
  version: 1.0.0
  title: Swagger Petstore
  license:
    name: MIT
servers:
  - url: http://petstore.swagger.io/v1
paths:
  /pets:
    get:
      summary: List all pets
      operationId: listPets
      tags:
        - pets
      parameters:
        - name: limit
          in: query
          description: How many items to return at one time (max 100)
          required: false
          schema:
            type: integer
            format: int32
      responses:
        '200':
          description: A paged array of pets
          headers:
            x-next:
              description: A link to the next page of responses
              schema:
                type: string
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Pets"
        default:
          description: unexpected error
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Error"
    post:
      summary: Create a pet
      operationId: createPets
      tags:
        - pets
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Pet"
      responses:
        '201':
          description: Null response
        default:
          description: unexpected error
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Error"
  /pets/{petId}:
    parameters:
      - $ref: "#/components/parameters/PetId"
    get:
      summary: Info for a specific pet
      operationId: showPetById
      tags:
        - pets
      responses:
        '200':
          description: Expected response to a valid request
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Pet"
        '404':
          $ref: "#/components/responses/NotFound"
    delete:
      operationId: deletePet
      deprecated: true
      responses:
        '204':
          description: Deleted
components:
  parameters:
    PetId:
      name: petId
      in: path
      required: true
      description: The id of the pet to retrieve
      schema:
        $ref: "#/components/schemas/PetIdentifier"
  responses:
    NotFound:
      description: Not found
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/Error"
  schemas:
    PetIdentifier:
      type: string
      format: uuid
    Pet:
      type: object
      required:
        - id
        - name
      properties:
        id:
          type: integer
          format: int64
        name:
          type: string
        tag:
          type: string
    Pets:
      type: array
      items:
        $ref: "#/components/schemas/Pet"
    Error:
      type: object
      required:
        - code
        - message
      properties:
        code:
          type: integer
          format: int32
        message:
          type: string
`;

const SWAGGER_20 = {
  swagger: "2.0",
  info: { title: "Orders", version: "2.1" },
  host: "api.example.com",
  basePath: "/v2",
  schemes: ["https"],
  consumes: ["application/json"],
  produces: ["application/json"],
  paths: {
    "/orders": {
      get: {
        operationId: "listOrders",
        tags: ["orders"],
        parameters: [
          { name: "status", in: "query", type: "string", enum: ["open", "closed"] },
          { name: "since", in: "query", type: "string", format: "date-time" },
          { name: "ids", in: "query", type: "array", items: { type: "string", format: "uuid" }, collectionFormat: "csv" },
          { name: "X-Request-Id", in: "header", type: "string", required: true },
        ],
        responses: { "200": { description: "orders", schema: { type: "array", items: { $ref: "#/definitions/Order" } } } },
      },
      post: {
        operationId: "createOrder",
        parameters: [{ name: "body", in: "body", required: true, description: "the order", schema: { $ref: "#/definitions/Order" } }],
        responses: { "201": { description: "created", schema: { $ref: "#/definitions/Order" } }, "400": { description: "bad" } },
      },
    },
    "/orders/{order-id}": {
      get: {
        operationId: "orders.get",
        parameters: [{ name: "order-id", in: "path", required: true, type: "integer", format: "int64" }],
        responses: { "200": { description: "one", schema: { $ref: "#/definitions/Order" } } },
      },
    },
  },
  definitions: {
    Order: { type: "object", properties: { id: { type: "integer", format: "int64" }, total: { type: "number" } } },
  },
};

const OPENAPI_31 = {
  openapi: "3.1.0",
  info: { title: "Library", version: "1.0.0" },
  paths: {
    "/books/{isbn}": {
      put: {
        operationId: "replaceBook",
        summary: "Replace a book",
        parameters: [
          { name: "isbn", in: "path", required: true, schema: { type: "string" } },
          { name: "session", in: "cookie", schema: { type: ["string", "null"] } },
          { name: "dryRun", in: "query", schema: { type: "boolean" } },
        ],
        requestBody: {
          content: {
            "application/xml": { schema: { $ref: "#/components/schemas/Book" } },
            "application/json; charset=utf-8": { schema: { $ref: "#/components/schemas/Book" } },
          },
        },
        responses: {
          "200": { description: "ok", content: { "application/json": { schema: { anyOf: [{ $ref: "#/components/schemas/Book" }, { type: "null" }] } } } },
          "2XX": { description: "other success" },
        },
        callbacks: { onDone: { "{$request.body#/cb}": { post: { responses: { "200": { description: "x" } } } } } },
      },
      patch: {
        operationId: "patchBook",
        requestBody: { content: { "application/json": { schema: { oneOf: [{ $ref: "#/components/schemas/Book" }, { $ref: "#/components/schemas/Magazine" }] } } } },
        parameters: [{ name: "isbn", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } } } } } } },
      },
      trace: {
        parameters: [{ name: "isbn", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "trace" } },
      },
    },
  },
  webhooks: { newBook: { post: { responses: { "200": { description: "ok" } } } } },
  components: {
    schemas: {
      Book: { type: "object", properties: { isbn: { type: "string" } } },
      Magazine: { type: "object", properties: { issue: { type: "integer" } } },
    },
  },
};

function expectOk<T>(result: { success: true; data: T } | { success: false; error: { message: string } }): T {
  if (!result.success) throw new Error(`expected success, got: ${result.error.message}`);
  return result.data;
}

describe("parseOpenApiText: Petstore 3.0 (YAML)", () => {
  it("maps every operation: params (path-level + $ref), request body, typed responses, tags, deprecated", async () => {
    const data = expectOk(await parseOpenApiText(PETSTORE_30));
    expect(data.sourceVersion).toBe("3.0.0");
    expect(data.title).toBe("Swagger Petstore");
    expect(data.operations.map((o) => `${o.httpMethod} ${o.httpPath} ${o.name}`)).toEqual([
      "GET /pets listPets",
      "POST /pets createPets",
      "GET /pets/{petId} showPetById",
      "DELETE /pets/{petId} deletePet",
    ]);
    const [list, create, show, del] = data.operations;
    expect(list).toMatchObject({
      summary: "List all pets",
      tags: ["pets"],
      parameters: [{ name: "limit", location: "query", type: "int32", isArray: false, required: false, description: expect.stringMatching(/How many/) }],
      // `Pets` is a named array of Pet: Pet[]
      responses: [{ statusCode: 200, type: "Pet", isArray: true, contentType: "application/json", description: "A paged array of pets" }],
    });
    expect(create.requestBody).toEqual({ type: "Pet", isArray: false, contentType: "application/json", required: true, description: "" });
    expect(create.responses).toEqual([{ statusCode: 201, type: null, isArray: false, contentType: "application/json", description: "Null response" }]);
    // the path-level $ref'd parameter, its primitive-only component schema collapsed to uuid
    expect(show.parameters).toEqual([{ name: "petId", location: "path", type: "uuid", isArray: false, required: true, description: "The id of the pet to retrieve" }]);
    expect(show.responses).toEqual([
      { statusCode: 200, type: "Pet", isArray: false, contentType: "application/json", description: "Expected response to a valid request" },
      { statusCode: 404, type: "Error", isArray: false, contentType: "application/json", description: "Not found" },
    ]);
    expect(del).toMatchObject({ deprecated: true, parameters: [{ name: "petId", location: "path" }] });
    expect(data.referencedTypes).toEqual(["Error", "Pet"]);
    expect(data.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/default response is not supported/), expect.stringMatching(/Server URLs are not imported/)]));
  });

  it("produces operations the whole-service validation accepts", async () => {
    const data = expectOk(await parseOpenApiText(PETSTORE_30));
    const result = await validateApiOperations(data.operations);
    expect(result.valid).toBe(true);
  });

  it("accepts the same document as JSON", async () => {
    const { parse } = await import("yaml");
    const data = expectOk(await parseOpenApiText(JSON.stringify(parse(PETSTORE_30))));
    expect(data.operations).toHaveLength(4);
  });
});

describe("Swagger 2.0", () => {
  it("is upgraded: body parameter -> request body, definitions -> type names, array params, renamed path param and operationId", async () => {
    const data = expectOk(await parseOpenApiText(toYaml(SWAGGER_20)));
    expect(data.sourceVersion).toBe("2.0");
    const byName = Object.fromEntries(data.operations.map((o) => [o.name, o]));
    expect(Object.keys(byName)).toEqual(["listOrders", "createOrder", "orders_get"]);
    expect(byName.listOrders.parameters).toEqual([
      { name: "status", location: "query", type: "string", isArray: false, required: false, description: "" },
      { name: "since", location: "query", type: "date-time", isArray: false, required: false, description: "" },
      { name: "ids", location: "query", type: "uuid", isArray: true, required: false, description: "" },
      { name: "X-Request-Id", location: "header", type: "string", isArray: false, required: true, description: "" },
    ]);
    expect(byName.listOrders.responses[0]).toMatchObject({ statusCode: 200, type: "Order", isArray: true });
    expect(byName.createOrder.requestBody).toMatchObject({ type: "Order", isArray: false, contentType: "application/json" });
    expect(byName.createOrder.responses.map((r) => r.statusCode)).toEqual([201, 400]);
    expect(byName.orders_get.httpPath).toBe("/orders/{order_id}");
    expect(byName.orders_get.parameters).toEqual([{ name: "order_id", location: "path", type: "int64", isArray: false, required: true, description: "" }]);
    expect(data.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/renamed to "order_id"/), expect.stringMatching(/operationId "orders.get" is not an identifier/)])
    );
  });
});

describe("OpenAPI 3.1", () => {
  it("maps 3.1 constructs and reports what the contract cannot hold", async () => {
    const data = expectOk(await importOpenApiDocument(structuredClone(OPENAPI_31)));
    expect(data.operations.map((o) => o.name)).toEqual(["replaceBook", "patchBook"]);
    const [replace, patch] = data.operations;
    expect(replace.parameters).toEqual([
      { name: "isbn", location: "path", type: "string", isArray: false, required: true, description: "" },
      { name: "session", location: "cookie", type: "string", isArray: false, required: false, description: "" },
      { name: "dryRun", location: "query", type: "boolean", isArray: false, required: false, description: "" },
    ]);
    // JSON preferred over XML, media type parameters dropped; OpenAPI's default `required: false`
    expect(replace.requestBody).toEqual({ type: "Book", isArray: false, contentType: "application/json", required: false, description: "" });
    // "Book or null" is Book
    expect(replace.responses).toEqual([{ statusCode: 200, type: "Book", isArray: false, contentType: "application/json", description: "ok" }]);
    expect(patch.requestBody).toBeNull();
    expect(patch.responses).toEqual([{ statusCode: 200, type: null, isArray: false, contentType: "application/json", description: "ok" }]);
    const w = data.warnings.join("\n");
    expect(w).toMatch(/callbacks are not imported/);
    expect(w).toMatch(/status code range is not supported/);
    expect(w).toMatch(/oneOf schema \(2 alternatives\) is not supported/);
    expect(w).toMatch(/inline object schema has no named type/);
    expect(w).toMatch(/TRACE method is not supported/);
    expect(w).toMatch(/Webhooks are not imported/);
    expect(w).toMatch(/only the "application\/json; charset=utf-8" content is imported/);
  });

  it("does not follow an external $ref (reported, nothing fetched)", async () => {
    const doc = {
      openapi: "3.1.0",
      info: { title: "x", version: "1" },
      paths: { "/a": { get: { responses: { "200": { description: "x", content: { "application/json": { schema: { $ref: "https://example.com/a.json" } } } } } } } },
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const data = expectOk(await importOpenApiDocument(doc));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(data.operations[0]).toMatchObject({ name: "getA", responses: [{ statusCode: 200, type: null }] });
    expect(data.warnings.join("\n")).toMatch(/external reference "https:\/\/example.com\/a.json" is not followed/);
  });

  it("skips an operation that breaks a contract rule, keeps the others", async () => {
    const doc = {
      openapi: "3.1.0",
      info: { title: "x", version: "1" },
      paths: {
        "/a/{id}": { get: { operationId: "getA", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "x" } } } },
        // same template as /a/{id}, other spelling, same method: a duplicate for the contract
        "/a/{key}": { get: { operationId: "getAByKey", parameters: [{ name: "key", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "x" } } } },
      },
    };
    const data = expectOk(await importOpenApiDocument(doc));
    expect(data.operations.map((o) => o.name)).toEqual(["getA"]);
    expect(data.warnings.join("\n")).toMatch(/GET \/a\/\{key\}: skipped \(.*already defined/);
  });
});

describe("refusals", () => {
  it.each([
    ["empty content", "   ", "PARSE_ERROR", /Empty/],
    ["malformed YAML", "openapi: 3.0.0\ninfo: [unclosed", "PARSE_ERROR", /not valid YAML or JSON/],
    ["a non-object document", "- a\n- b", "PARSE_ERROR", /must be an object/],
    ["no version", "info: {title: x}\npaths: {}", "UNSUPPORTED_VERSION", /Not an OpenAPI document/],
    ["OpenAPI 4", 'openapi: "4.0.0"\ninfo: {title: x, version: "1"}\npaths: {}', "UNSUPPORTED_VERSION", /"4.0.0" is not supported/],
    ["Swagger 1.2", 'swagger: "1.2"\ninfo: {title: x, version: "1"}', "UNSUPPORTED_VERSION", /"1.2" is not supported/],
    ["an invalid document", 'openapi: "3.0.3"\ninfo: {version: "1"}\npaths: {"/a": {get: {}}}', "VALIDATION_ERROR", /not valid/],
  ])("%s", async (_label, content, code, message) => {
    const result = await parseOpenApiText(content);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe(code);
    expect(result.error.message).toMatch(message);
  });

  it("refuses a document over the import size cap before parsing it", async () => {
    const huge = `openapi: "3.0.0"\ninfo: {title: x, version: "1"}\npaths: {}\n# ${"x".repeat(1024 * 1024 + 10)}`;
    const result = await parseOpenApiText(huge);
    expect(result).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR", message: expect.stringMatching(/too large/) } });
  });

  it("refuses a YAML alias fan-out", async () => {
    const lines = ['openapi: "3.0.0"', "a: &a [x, x, x, x, x, x, x, x, x, x]"];
    for (let i = 0; i < 20; i++) lines.push(`b${i}: &b${i} [${Array(10).fill(i === 0 ? "*a" : `*b${i - 1}`).join(", ")}]`);
    const result = await parseOpenApiText(lines.join("\n"));
    expect(result.success).toBe(false);
  });
});

describe("a large document", () => {
  it(`takes at most ${MAX_IMPORTED_OPERATIONS} operations and says how many were skipped`, async () => {
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < 300; i++) {
      paths[`/r${i}/{id}`] = {
        get: { operationId: `get${i}`, parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "x" } } },
        delete: { operationId: `del${i}`, parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "204": { description: "x" } } },
      };
    }
    const started = Date.now();
    const data = expectOk(await importOpenApiDocument({ openapi: "3.0.3", info: { title: "big", version: "1" }, paths }));
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(data.operations).toHaveLength(MAX_IMPORTED_OPERATIONS);
    expect(data.warnings.join("\n")).toMatch(/Only the first 500 operations are imported; 100 more were skipped/);
  });
});

describe("fetchOpenApiText", () => {
  const publicLookup = async () => ["93.184.216.34"];

  it("fetches through the guarded fetcher", async () => {
    const fetchHttp = vi.fn().mockResolvedValue(PETSTORE_30);
    const result = await fetchOpenApiText("https://example.com/petstore.yaml", { fetchHttp, lookup: publicLookup });
    expect(result).toEqual({ success: true, data: PETSTORE_30 });
    expect(fetchHttp).toHaveBeenCalledWith("https://example.com/petstore.yaml");
  });

  it.each([
    ["http (not https)", "http://example.com/a.yaml", /only https/],
    ["a local file", "file:///etc/passwd", /not allowed/],
  ])("refuses %s without fetching", async (_label, url, reason) => {
    const fetchHttp = vi.fn();
    const result = await fetchOpenApiText(url, { fetchHttp, lookup: publicLookup });
    expect(result).toMatchObject({ success: false, error: { code: "FETCH_ERROR", message: expect.stringMatching(reason) } });
    expect(fetchHttp).not.toHaveBeenCalled();
  });

  it("refuses a host that resolves to a private address (SSRF)", async () => {
    const fetchHttp = vi.fn();
    const result = await fetchOpenApiText("https://internal.example/a.yaml", { fetchHttp, lookup: async () => ["10.0.0.5"] });
    expect(result).toMatchObject({ success: false, error: { code: "FETCH_ERROR" } });
    expect(fetchHttp).not.toHaveBeenCalled();
  });

  it("refuses an empty or overlong URL", async () => {
    expect(await fetchOpenApiText("  ")).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
    expect(await fetchOpenApiText(`https://example.com/${"a".repeat(3000)}`)).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
  });
});
