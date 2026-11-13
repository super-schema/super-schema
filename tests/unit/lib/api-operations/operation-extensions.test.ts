/**
 * Metadata attributes on API operations: stored at `Operation.decorators.extensions`, written to TypeSpec as
 * `@TypeSpec.OpenAPI.extension`, kept by the OpenAPI import, and stripped from the emitted OpenAPI when their scope is `internal`.
 */
import { describe, it, expect, vi } from "vitest";
import { parse as parseYaml } from "yaml";

vi.setConfig({ testTimeout: 60_000 });
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { apiOperationsTypeSpec, toApiOperations } from "@/lib/api-operations/to-typespec";
import { operationColumns, operationRecordFromRow, type OperationRow } from "@/lib/api-operations/records";
import { importOpenApiDocument } from "@/lib/api-operations/import-openapi";
import { parseApiOperation } from "@/lib/api-operations/validate";
import { stripInternal, stripInternalFromClosure } from "@/lib/metadata-attributes/emission";
import { emitOfficialTypeSpecTargetFromData } from "@/lib/typespec-official/emitter.service";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { compileEntity } from "@/lib/compiler/compiler.service";
import type { MetadataAttributeDefinition } from "@/types/schemas/metadata-attribute";

const SLO = { response_time_95th_percentile: 200 };
const ROW = {
  name: "getOrder",
  httpMethod: "GET",
  httpPath: "/orders/{id}",
  parameters: [{ name: "id", type: "uuid", location: "path", required: true }],
  responses: [{ statusCode: 200, type: "Order" }],
  decorators: { extensions: { "x-slo": SLO, "x-owner": "payments" } },
};

const def = (key: string, scope: "schema" | "internal"): MetadataAttributeDefinition => ({
  key, label: key, description: "", valueSchema: { type: "string" }, targets: ["operation"], scope, placement: "field", requiredWhen: "never",
});

describe("API operation extensions: storage", () => {
  it("a row's decorators.extensions reads onto the contract operation (x- keys only)", () => {
    const [read] = toApiOperations([{ ...ROW, decorators: { extensions: { "x-slo": SLO, notX: 1 } } }]);
    expect(read.extensions).toEqual({ "x-slo": SLO });
  });

  it("an operation without extensions has no `extensions` key", () => {
    const [read] = toApiOperations([{ ...ROW, decorators: {} }]);
    expect("extensions" in read).toBe(false);
  });

  it("the contract rejects a key that breaks the attribute key rule", () => {
    const parsed = parseApiOperation({ ...toApiOperations([ROW])[0], extensions: { serviceName: "x" } });
    expect(parsed.success).toBe(false);
  });

  it("operationColumns writes decorators.extensions; the record reads them back", () => {
    const [op] = toApiOperations([ROW]);
    expect(operationColumns(op).decorators).toEqual({ extensions: ROW.decorators.extensions });
    const row: OperationRow = {
      id: "o1", serviceId: "s1", name: "getOrder", description: "", httpMethod: "GET", httpPath: "/orders/{id}",
      decorators: { extensions: ROW.decorators.extensions }, parameters: [], responses: [],
    };
    expect(operationRecordFromRow(row).extensions).toEqual(ROW.decorators.extensions);
  });

  it("operationColumns leaves the decorators column alone without extensions, and clears it for an empty map", () => {
    const [plain] = toApiOperations([{ ...ROW, decorators: {} }]);
    expect("decorators" in operationColumns(plain)).toBe(false);
    expect(operationColumns({ ...plain, extensions: {} }).decorators).toEqual({});
  });
});

describe("API operation extensions: TypeSpec", () => {
  it("writes one @TypeSpec.OpenAPI.extension per key on the op", () => {
    const written = apiOperationsTypeSpec(toApiOperations([ROW]), { interfaceName: "OrderOperations", resolveNamedType: (n) => n });
    const text = written.lines.join("\n");
    expect(text).toContain('@TypeSpec.OpenAPI.extension("x-slo", #{response_time_95th_percentile: 200})');
    expect(text).toContain('@TypeSpec.OpenAPI.extension("x-owner", "payments")');
    expect(text.indexOf("x-slo")).toBeLessThan(text.indexOf("op getOrder"));
  });

  it("an operation without extensions writes the same text as before", () => {
    const withNone = apiOperationsTypeSpec(toApiOperations([{ ...ROW, decorators: {} }]), { interfaceName: "I", resolveNamedType: (n) => n });
    expect(withNone.lines.join("\n")).not.toContain("extension(");
  });
});

describe("API operation extensions: OpenAPI import", () => {
  it("keeps operation-level x- keys (and nothing else with x-) in extensions", async () => {
    const result = await importOpenApiDocument({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/pets": {
          get: { operationId: "listPets", "x-slo": SLO, "x-note": "n", summary: "s", responses: { "200": { description: "ok" } } },
        },
      },
    });
    if (!result.success) throw new Error(JSON.stringify(result));
    expect(result.data.operations[0].extensions).toEqual({ "x-slo": SLO, "x-note": "n" });
  });
});

describe("API operation extensions: internal scope", () => {
  const ops = toApiOperations([ROW]);
  const entity: PrismaEntityInput = {
    id: "o", name: "Order", description: "", status: "DRAFT", version: 1, domainId: "d", metadata: {},
    domain: { id: "d", name: "Sales", slug: "sales" }, apiOperations: ops,
  };
  const fields: PrismaFieldInput[] = [
    { id: "f-id", name: "id", type: "string", precision: null, scale: null, nullable: false, isKey: true, fieldNumber: null, description: "", classification: null, aliases: [], decorators: {}, sortOrder: 0 },
  ];

  it("stripInternal drops the internal keys of every operation; same reference when none", () => {
    const model = compileEntity(entity, fields);
    const stripped = stripInternal(model, [def("x-owner", "internal"), def("x-slo", "schema")]);
    expect(stripped.apiOperations?.[0].extensions).toEqual({ "x-slo": SLO });
    expect(model.apiOperations?.[0].extensions).toHaveProperty("x-owner");
    expect(stripInternal(model, [def("x-other", "internal")])).toBe(model);
    const only = compileEntity({ ...entity, apiOperations: toApiOperations([{ ...ROW, decorators: { extensions: { "x-owner": "p" } } }]) }, fields);
    expect(stripInternal(only, [def("x-owner", "internal")]).apiOperations?.[0].extensions).toBeUndefined();
  });

  it("stripInternalFromClosure drops them from each member's operations", () => {
    const member = { entityId: "o", entity: { metadata: {}, apiOperations: ops }, fields: [] as Array<{ decorators?: unknown }> };
    const closure = { entities: [member], root: member };
    const out = stripInternalFromClosure(closure, [def("x-owner", "internal")]);
    expect(out.entities[0].entity.apiOperations?.[0].extensions).toEqual({ "x-slo": SLO });
    expect(out.root?.entity.apiOperations?.[0].extensions).toEqual({ "x-slo": SLO });
    expect(stripInternalFromClosure(closure, [def("x-zzz", "internal")])).toBe(closure);
  });

  it("the OpenAPI output carries a schema key and not an internal one", async () => {
    const withDict = await emitOfficialTypeSpecTargetFromData(entity, fields, "openapi3", {
      metadata: { definitions: [def("x-owner", "internal"), def("x-slo", "schema")] },
    });
    expect(withDict.errors).toEqual([]);
    const doc = parseYaml(withDict.output) as { paths: Record<string, Record<string, Record<string, unknown>>> };
    const get = doc.paths["/orders/{id}"].get;
    expect(get["x-slo"]).toEqual(SLO);
    expect(get["x-owner"]).toBeUndefined();
    const plain = await emitOfficialTypeSpecTargetFromData(entity, fields, "openapi3");
    expect((parseYaml(plain.output) as typeof doc).paths["/orders/{id}"].get["x-owner"]).toBe("payments");
  });
});
