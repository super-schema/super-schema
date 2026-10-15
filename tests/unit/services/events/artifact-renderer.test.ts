import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/db", () => ({ prisma: {} }));
import { createArtifactRenderer, type EmitFiles } from "@/services/events/artifact-renderer";

type V = { id: string; entityId: string; major: number; minor: number; resolvedSource: string; fieldSnapshot: unknown; entity: { name: string } };
const versions: Record<string, V> = {
  vOrder: {
    id: "vOrder", entityId: "eOrder", major: 2, minor: 1, entity: { name: "Order" },
    resolvedSource: "namespace Custom;\nmodel Order {\n  id: string;\n  address: Address;\n}\n",
    fieldSnapshot: [{ name: "id", fieldNumber: 1 }, { name: "address", fieldNumber: 2 }],
  },
  vAddress: { id: "vAddress", entityId: "eAddress", major: 1, minor: 0, entity: { name: "Address" }, resolvedSource: "model Address {\n  street: string;\n}\n", fieldSnapshot: [{ name: "street", fieldNumber: null }] },
  vAddress2: { id: "vAddress2", entityId: "eAddress", major: 2, minor: 0, entity: { name: "Address" }, resolvedSource: "model Address {\n  line1: string;\n}\n", fieldSnapshot: [] },
  vCustomer: { id: "vCustomer", entityId: "eCustomer", major: 1, minor: 0, entity: { name: "Customer" }, resolvedSource: "model Customer {\n  home: Address;\n}\n", fieldSnapshot: [] },
  vBroken: { id: "vBroken", entityId: "eBroken", major: 1, minor: 0, entity: { name: "Broken" }, resolvedSource: "model Broken {\n  id: string;\n}\n", fieldSnapshot: [] },
};
const fieldPins: Record<string, string[]> = { vOrder: ["vAddress"], vCustomer: ["vAddress2"], vMixed: [] };

function fakeDb(extraPins: Record<string, string[]> = {}) {
  const pins = { ...fieldPins, ...extraPins };
  return {
    entityVersion: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => versions[where.id] ?? null) },
    schemaReference: { findMany: vi.fn(async ({ where }: { where: { fromId: string } }) => (pins[where.fromId] ?? []).map((toId) => ({ toId }))) },
    entity: { findUnique: vi.fn(async () => ({ tenant: { slug: "acme" }, domain: { slug: "payments" }, product: { slug: "checkout" } })) },
  };
}

const order = { kind: "version" as const, entityVersionId: "vOrder" };

describe("artifact renderer", () => {
  it("renders Avro from the combined program and picks <Root>.avsc.json", async () => {
    const emitFiles = vi.fn<EmitFiles>(async () => ({
      success: true,
      data: [
        { relativePath: "Address.avsc.json", content: '{"type":"record","name":"Address","fields":[]}' },
        { relativePath: "Order.avsc.json", content: '{"type":"record","name":"Order","fields":[]}' },
      ],
    }));
    const renderer = createArtifactRenderer({ db: fakeDb() as never, emitFiles });
    const r = await renderer.render(order, "avro");
    expect(r).toEqual({ success: true, data: { artifact: { format: "avro", schema: { type: "record", name: "Order", fields: [] } }, warnings: [] } });
    const [pkg, source, options] = emitFiles.mock.calls[0];
    expect(pkg).toBe("@typespec/avro");
    expect(options).toEqual({});
    expect(source).toContain("namespace Acme.Payments.Checkout;");
    expect(source).not.toContain("namespace Custom;");
    expect(source.indexOf("model Order")).toBeLessThan(source.indexOf("model Address"));
  });

  it("caches immutable versions (one emit for two renders) and does not cache failures", async () => {
    const emitFiles = vi.fn<EmitFiles>(async () => ({ success: true, data: [{ relativePath: "Order.avsc.json", content: '{"type":"record","name":"Order"}' }] }));
    const renderer = createArtifactRenderer({ db: fakeDb() as never, emitFiles });
    await renderer.render(order, "avro");
    await renderer.render(order, "avro");
    expect(emitFiles).toHaveBeenCalledTimes(1);

    const failing = vi.fn<EmitFiles>(async () => ({ success: false, error: { code: "EMITTER_FAILED", message: "boom" } }));
    const r2 = createArtifactRenderer({ db: fakeDb() as never, emitFiles: failing });
    const first = await r2.render({ kind: "version", entityVersionId: "vBroken" }, "avro");
    expect(!first.success && first.error).toEqual({ code: "ARTIFACT_RENDER_FAILED", message: "Broken@1.0 → avro: boom" });
    await r2.render({ kind: "version", entityVersionId: "vBroken" }, "avro");
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("renders JSON Schema once as a 2020-12 bundle and inlines it", async () => {
    const bundle = {
      $id: "Order",
      $defs: {
        Order: { $id: "Order.json", type: "object", properties: { address: { $ref: "Address.json" } } },
        Address: { $id: "Address.json", type: "object", properties: { street: { type: "string" } } },
      },
    };
    const emitFiles = vi.fn<EmitFiles>(async () => ({ success: true, data: [{ relativePath: "Order", content: JSON.stringify(bundle) }] }));
    const r = await createArtifactRenderer({ db: fakeDb() as never, emitFiles }).render(order, "json-schema");
    expect(r.success && r.data.artifact).toMatchObject({
      format: "json-schema", dialect: "2020-12",
      schema: { type: "object", properties: { address: { $ref: "#/$defs/Address" } }, $defs: { Address: { type: "object" } } },
    });
    expect(emitFiles.mock.calls[0][0]).toBe("@typespec/json-schema");
    expect(emitFiles.mock.calls[0][1]).toContain('import "@typespec/json-schema";');
    expect(emitFiles.mock.calls[0][2]).toEqual({ emitAllModels: true, "file-type": "json", bundleId: "Order" });
  });

  it("renders protobuf with @package, field numbers from every version, and the root message first", async () => {
    const proto = 'syntax = "proto3";\n\nmessage Address {\n  string street = 1;\n}\n\nmessage Order {\n  string id = 1;\n  Address address = 2;\n}\n';
    const emitFiles = vi.fn<EmitFiles>(async () => ({ success: true, data: [{ relativePath: "main.proto", content: proto }] }));
    const r = await createArtifactRenderer({ db: fakeDb() as never, emitFiles }).render(order, "protobuf");
    const text = r.success ? (r.data.artifact.schema as string) : "";
    expect(text.indexOf("// @RootNode\nmessage Order")).toBeGreaterThan(-1);
    expect(text.indexOf("message Order")).toBeLessThan(text.indexOf("message Address"));
    const source = emitFiles.mock.calls[0][1];
    expect(source).toContain("@package\nnamespace Acme.Payments.Checkout;");
    expect(source).toContain("@field(1)\n  id: string;");
    expect(source).toContain("@field(2)\n  address: Address;");
    expect(source).toContain("@field(1)\n  street: string;");
  });

  it("refuses two versions of one entity in a single program", async () => {
    const renderer = createArtifactRenderer({ db: fakeDb({ vOrder: ["vAddress", "vCustomer"] }) as never, emitFiles: vi.fn() });
    const r = await renderer.render(order, "avro");
    expect(!r.success && r.error.code).toBe("CONFLICTING_PINS");
  });
});

describe("artifact renderer — legacy @tag lines and draft subjects", () => {
  const legacy: V = {
    id: "vLegacy", entityId: "eLegacy", major: 1, minor: 0, entity: { name: "Legacy" }, fieldSnapshot: [],
    resolvedSource: '@tag("sales")\nmodel Legacy {\n  id: string;\n  @tag("classification:PII")\n  ssn: string;\n  @doc("mentions @tag(x) inline")\n  note: string;\n}\n',
  };
  const avroFiles = [{ relativePath: "Legacy.avsc.json", content: '{"type":"record","name":"Legacy"}' }];

  it("strips legacy @tag lines (frozen pre-Track-F resolvedSource) before compiling, in every format", async () => {
    for (const format of ["avro", "json-schema", "protobuf"] as const) {
      const emitFiles = vi.fn<EmitFiles>(async () => ({
        success: true,
        data: format === "json-schema"
          ? [{ relativePath: "Legacy", content: JSON.stringify({ $id: "Legacy", $defs: { Legacy: { $id: "Legacy.json", type: "object" } } }) }]
          : format === "protobuf"
            ? [{ relativePath: "main.proto", content: "message Legacy {\n  string id = 1;\n}\n" }]
            : avroFiles,
      }));
      const db = { ...fakeDb(), entityVersion: { findUnique: vi.fn(async () => legacy) } };
      const r = await createArtifactRenderer({ db: db as never, emitFiles }).render({ kind: "version", entityVersionId: "vLegacy" }, format);
      expect(r.success).toBe(true);
      const source = emitFiles.mock.calls[0][1];
      expect(source).not.toMatch(/^\s*@tag\(/m);
      expect(source).toContain("model Legacy {");
      expect(source).toContain('@doc("mentions @tag(x) inline")');
    }
  });

  function draftDb(refLatestVersionId: string | null) {
    const draft = {
      id: "eDraft", name: "Draft", metadata: {},
      typespecSource: '@tag("x")\nmodel Draft {\n  address: Address;\n}\n',
      fields: [{ id: "f1", name: "address", fieldNumber: null, decorators: { referencedEntityId: "eAddress", referencedEntityName: "Address" } }],
    };
    const base = fakeDb();
    return {
      ...base,
      entity: {
        findUnique: vi.fn(async ({ select }: { select: Record<string, unknown> }) =>
          "typespecSource" in select ? draft : { tenant: { slug: "acme" }, domain: { slug: "payments" }, product: { slug: "checkout" } }),
        findMany: vi.fn(async () => [{ id: "eAddress", name: "Address", latestVersionId: refLatestVersionId }]),
      },
    };
  }

  it("renders a draft against the latest published version of every entity it references, and never caches it", async () => {
    const emitFiles = vi.fn<EmitFiles>(async () => ({ success: true, data: [{ relativePath: "Draft.avsc.json", content: '{"type":"record","name":"Draft"}' }] }));
    const renderer = createArtifactRenderer({ db: draftDb("vAddress") as never, emitFiles });
    const subject = { kind: "draft" as const, entityId: "eDraft" };
    const r = await renderer.render(subject, "avro");
    expect(r.success && r.data.artifact.schema).toMatchObject({ name: "Draft" });
    const source = emitFiles.mock.calls[0][1];
    expect(source).toContain("model Draft {");
    expect(source).toContain("model Address {");
    expect(source).not.toMatch(/^\s*@tag\(/m);
    await renderer.render(subject, "avro");
    expect(emitFiles).toHaveBeenCalledTimes(2);
  });

  it("names the unpublished entity when a draft references one", async () => {
    const r = await createArtifactRenderer({ db: draftDb(null) as never, emitFiles: vi.fn() }).render({ kind: "draft", entityId: "eDraft" }, "avro");
    expect(!r.success && r.error.code).toBe("UNPUBLISHED_REFERENCE");
    expect(!r.success && r.error.message).toContain("Address");
  });
});
