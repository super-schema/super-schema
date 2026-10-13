/**
 * OpenAPI import via the official @typespec/openapi3 converter + the real
 * @typespec/compiler. Runs an actual conversion + compile in Node, so it
 * verifies the end-to-end path (not a mock of the converter).
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

// server-only throws outside an RSC bundle; neutralize it for the Node test
// (transitively imported via typespec-compiler.ts).
vi.mock("server-only", () => ({}));

let importOpenApiDocumentAction: typeof import("@/app/(dashboard)/schemas/[domainSlug]/openapi-import-actions").importOpenApiDocumentAction;

beforeAll(async () => {
  ({ importOpenApiDocumentAction } = await import(
    "@/app/(dashboard)/schemas/[domainSlug]/openapi-import-actions"
  ));
});

const PETSTORE_JSON = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Petstore", version: "1.0.0" },
  paths: {
    "/pets/{petId}": {
      get: {
        operationId: "getPet",
        parameters: [
          { name: "petId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "A pet",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Pet" } },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: "object",
        required: ["id", "name"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          age: { type: "integer" },
        },
      },
    },
  },
});

const PETSTORE_YAML = `
openapi: "3.0.0"
info:
  title: Petstore
  version: "1.0.0"
paths:
  /pets:
    get:
      operationId: listPets
      responses:
        "200":
          description: A list of pets
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: "#/components/schemas/Pet"
components:
  schemas:
    Pet:
      type: object
      required: [id]
      properties:
        id:
          type: string
`;

describe("OpenAPI import action (real converter + compiler)", () => {
  it("imports an entity and an operation from an OpenAPI JSON document", async () => {
    const result = await importOpenApiDocumentAction(PETSTORE_JSON);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const petModel = result.data.models.find((m) => m.name === "Pet");
    expect(petModel).toBeDefined();
    const fieldNames = petModel!.fields.map((f) => f.name);
    expect(fieldNames).toEqual(expect.arrayContaining(["id", "name", "age"]));

    const allOps = result.data.services.flatMap((s) => s.operations);
    expect(allOps.some((op) => op.name === "getPet")).toBe(true);
  });

  it("imports an entity and operation from an OpenAPI YAML document", async () => {
    const result = await importOpenApiDocumentAction(PETSTORE_YAML);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.models.some((m) => m.name === "Pet")).toBe(true);
    const allOps = result.data.services.flatMap((s) => s.operations);
    expect(allOps.length).toBeGreaterThan(0);
  });

  it("rejects empty content", async () => {
    const result = await importOpenApiDocumentAction("");
    expect(result.success).toBe(false);
  });

  it("rejects invalid YAML/JSON", async () => {
    const result = await importOpenApiDocumentAction("{ not: valid: yaml: : :");
    expect(result.success).toBe(false);
  });
});
