import { describe, expect, it } from "vitest";

import { schemaLabel, summarizeOpenApi } from "@/lib/api-operations/openapi-preview";

const DOC = {
  openapi: "3.0.0",
  info: { title: "Orders", version: "1.0" },
  paths: {
    "/orders": {
      parameters: [{ $ref: "#/components/parameters/Tenant" }],
      get: {
        operationId: "listOrders",
        tags: ["orders"],
        parameters: [{ name: "limit", in: "query", schema: { type: "integer", format: "int32" } }],
        responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Order" } } } } } },
      },
      post: {
        deprecated: true,
        requestBody: { $ref: "#/components/requestBodies/OrderBody" },
        responses: { "204": { description: "none" } },
      },
    },
  },
  components: {
    parameters: { Tenant: { name: "X-Tenant", in: "header", required: true, schema: { type: "string" } } },
    requestBodies: { OrderBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } } } },
    schemas: { Order: { type: "object", required: ["id"], properties: { id: { type: "integer", format: "int64" }, note: { type: "string" } } } },
  },
};

describe("summarizeOpenApi", () => {
  it("lists operations with resolved params / bodies and sampled examples", () => {
    const s = summarizeOpenApi(DOC);
    if (s.error !== undefined) throw new Error(s.error);
    expect(s).toMatchObject({ title: "Orders", version: "1.0", openapi: "3.0.0" });
    const [list, create] = s.operations;
    expect(list).toMatchObject({
      method: "GET", path: "/orders", operationId: "listOrders", tags: ["orders"],
      parameters: [
        { name: "X-Tenant", in: "header", required: true, type: "string" },
        { name: "limit", in: "query", required: false, type: "integer (int32)" },
      ],
    });
    expect(list.responses[0].body?.type).toBe("Order[]");
    expect(JSON.parse(list.responses[0].body!.example)).toEqual([{ id: 0, note: "string" }]);
    expect(create).toMatchObject({ method: "POST", deprecated: true, requestBody: { type: "Order", required: true, contentType: "application/json" } });
    expect(create.responses).toEqual([{ status: "204", description: "none", body: null }]);
  });

  it("reads YAML text, and refuses what is not an OpenAPI document", () => {
    expect(summarizeOpenApi("openapi: 3.1.0\ninfo: {title: a, version: '1'}\npaths: {}")).toMatchObject({ operations: [] });
    expect(summarizeOpenApi("a: [")).toEqual({ error: "The generated document is not valid YAML" });
    expect(summarizeOpenApi("a: 1")).toEqual({ error: "Not an OpenAPI document" });
  });

  it("labels schemas", () => {
    expect(schemaLabel({ anyOf: [{ $ref: "#/components/schemas/A" }, { type: "null" }] })).toBe("A");
    expect(schemaLabel({ oneOf: [{ $ref: "#/x/A" }, { $ref: "#/x/B" }] })).toBe("A | B");
    expect(schemaLabel({ type: ["string", "null"], format: "date" })).toBe("string (date)");
    expect(schemaLabel(undefined)).toBe("any");
  });
});
