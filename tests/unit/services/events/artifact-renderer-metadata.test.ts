import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/db", () => ({ prisma: {} }));
import { createArtifactRenderer, type EmitFiles } from "@/services/events/artifact-renderer";
import type { MetadataAttributeDefinition } from "@/types/schemas/metadata-attribute";

const TENANT = "tenant-acme";
const CLASS2 = { data_class: "class2", data_category: "ConsumerPersonal" };
const CLASS3 = { data_class: "class3", data_category: "Intrinsic" };

const SECURITY = {
  key: "x-securityClassification", label: "S", description: "", valueSchema: { type: "object" }, targets: ["field"],
  scope: "schema", placement: "abc-primitive", requiredWhen: "never",
} as MetadataAttributeDefinition;
const REVIEW = {
  key: "x-review-note", label: "R", description: "", valueSchema: { type: "string" }, targets: ["field"],
  scope: "internal", placement: "field", requiredWhen: "never",
} as MetadataAttributeDefinition;

const ext = (openapi: Record<string, unknown>) => ({ typespec: { extensions: { openapi } } });
const snapshot = [
  { id: "f1", name: "email", type: "string", precision: null, scale: null, nullable: false, isKey: false, fieldNumber: 1, description: "", classification: null, aliases: [], sortOrder: 0, decorators: ext({ "x-securityClassification": CLASS2 }) },
  { id: "f2", name: "tags", type: "array", precision: null, scale: null, nullable: false, isKey: false, fieldNumber: 2, description: "", classification: null, aliases: [], sortOrder: 1, decorators: { arrayElementType: "string", ...ext({ "x-securityClassification": CLASS3 }) } },
  { id: "f3", name: "note", type: "string", precision: null, scale: null, nullable: false, isKey: false, fieldNumber: 3, description: "", classification: null, aliases: [], sortOrder: 2, decorators: ext({ "x-review-note": "check" }) },
];
const SOURCE = [
  "model Customer {",
  '  @TypeSpec.JsonSchema.extension("x-securityClassification", #{data_class: "class2", data_category: "ConsumerPersonal"})',
  "  email: string;",
  '  @TypeSpec.JsonSchema.extension("x-securityClassification", #{data_class: "class3", data_category: "Intrinsic"})',
  "  tags: string[];",
  '  @TypeSpec.JsonSchema.extension("x-review-note", #{',
  '    text: "a ) b",',
  "  })",
  "  note: string;",
  "}",
  "",
].join("\n");

function fakeDb() {
  return {
    entityVersion: {
      findUnique: vi.fn(async () => ({
        id: "v1", entityId: "e1", major: 1, minor: 0, patch: 0, stage: "RELEASED", resolvedSource: SOURCE, fieldSnapshot: snapshot,
        entity: { name: "Customer", tenantId: TENANT, domainId: null, productId: null, product: null },
      })),
    },
    schemaReference: { findMany: vi.fn(async () => []) },
    entity: { findUnique: vi.fn(async () => ({ tenant: { slug: "acme" }, domain: null, product: null })) },
  };
}

const subject = { kind: "version" as const, entityVersionId: "v1", tenantId: TENANT };
const BUNDLE = {
  $id: "Customer",
  $defs: {
    Customer: {
      $id: "Customer.json", type: "object",
      properties: { email: { type: "string", "x-securityClassification": CLASS2 }, tags: { type: "array", items: { type: "string" }, "x-securityClassification": CLASS3 } },
    },
  },
};
const AVRO = { type: "record", name: "Customer", namespace: "Acme", fields: [{ name: "email", type: "string" }, { name: "tags", type: { type: "array", items: "string" } }] };

const emitter = (): ReturnType<typeof vi.fn<EmitFiles>> =>
  vi.fn<EmitFiles>(async (pkg) => ({
    success: true,
    data: pkg === "@typespec/avro"
      ? [{ relativePath: "Customer.avsc.json", content: JSON.stringify(AVRO, null, 2) }]
      : [{ relativePath: "Customer", content: JSON.stringify(BUNDLE, null, 2) }],
  }));

describe("artifact renderer with a metadata attribute dictionary", () => {
  it("compiles the source without the internal key's decorator (a multi-line literal), and with it when there is no dictionary", async () => {
    const emitFiles = emitter();
    await createArtifactRenderer({ db: fakeDb() as never, emitFiles, loadMetadata: async () => ({ definitions: [SECURITY, REVIEW] }) }).render(subject, "json-schema");
    expect(emitFiles.mock.calls[0][1]).not.toContain("x-review-note");
    expect(emitFiles.mock.calls[0][1]).toContain("x-securityClassification");
    const plain = emitter();
    await createArtifactRenderer({ db: fakeDb() as never, emitFiles: plain, loadMetadata: async () => undefined }).render(subject, "json-schema");
    expect(plain.mock.calls[0][1]).toContain("x-review-note");
  });

  it("puts the abc-primitive key of a primitive array on items in the JSON Schema payload", async () => {
    const r = await createArtifactRenderer({ db: fakeDb() as never, emitFiles: emitter(), loadMetadata: async () => ({ definitions: [SECURITY, REVIEW] }) }).render(subject, "json-schema");
    const schema = r.success ? (r.data.artifact.schema as Record<string, Record<string, Record<string, unknown>>>) : {};
    expect(schema.properties.email["x-securityClassification"]).toEqual(CLASS2);
    expect(schema.properties.tags["x-securityClassification"]).toBeUndefined();
    expect((schema.properties.tags.items as Record<string, unknown>)["x-securityClassification"]).toEqual(CLASS3);
  });

  it("adds the schema-scope values as Avro properties on the matching record's fields", async () => {
    const r = await createArtifactRenderer({ db: fakeDb() as never, emitFiles: emitter(), loadMetadata: async () => ({ definitions: [SECURITY, REVIEW] }) }).render(subject, "avro");
    const record = r.success ? (r.data.artifact.schema as { fields: Array<Record<string, unknown>> }) : { fields: [] };
    expect(record.fields[0]["x-securityClassification"]).toEqual(CLASS2);
    expect(record.fields[1]["x-securityClassification"]).toEqual(CLASS3);
  });

  it("keys a version's cached render on the dictionary state: a changed dictionary renders again", async () => {
    const emitFiles = emitter();
    let definitions: MetadataAttributeDefinition[] | undefined = [SECURITY, REVIEW];
    const renderer = createArtifactRenderer({ db: fakeDb() as never, emitFiles, loadMetadata: async () => (definitions ? { definitions } : undefined) });
    await renderer.render(subject, "json-schema");
    await renderer.render(subject, "json-schema");
    expect(emitFiles).toHaveBeenCalledTimes(1);
    definitions = [SECURITY, { ...REVIEW, scope: "schema" }];
    await renderer.render(subject, "json-schema");
    expect(emitFiles).toHaveBeenCalledTimes(2);
    definitions = undefined;
    await renderer.render(subject, "json-schema");
    expect(emitFiles).toHaveBeenCalledTimes(3);
  });
});
