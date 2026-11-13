/**
 * Metadata attributes as Protobuf custom options, through the real TypeSpec protobuf emitter: the emitted set carries
 * `superschema/metadata_options.proto` and the entity's `.proto` imports it and sets the options; both parse (protobufjs, with the real
 * descriptor.proto) and every option they set is an extension the options file declares. `internal` keys never appear, and a tenant
 * without a dictionary gets exactly today's output. Event payloads (one self-contained `.proto`) keep their payload and say so.
 */
import { describe, expect, it, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, Root, Field } from "protobufjs";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { compileEntity } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { emitOfficialTypeSpecTargetFromData, type OfficialTypeSpecTargetResult } from "@/lib/typespec-official/emitter.service";
import type { MetadataEmissionContext } from "@/lib/metadata-attributes/emission";
import { PAYPAL_SECURITY_CLASSIFICATION_PACK } from "@/lib/metadata-attributes/packs/paypal-security-classification";
import { createArtifactRenderer } from "@/services/events/artifact-renderer";

vi.mock("server-only", () => ({}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const SECURITY = { ...PAYPAL_SECURITY_CLASSIFICATION_PACK.definitions[0], pack: PAYPAL_SECURITY_CLASSIFICATION_PACK.id, protobufOptionNumber: 50000 };
const REVIEW = {
  key: "x-review-note",
  label: "Review note",
  description: "",
  valueSchema: { type: "string" as const },
  targets: ["field" as const],
  scope: "internal" as const,
  placement: "field" as const,
  requiredWhen: "never" as const,
  protobufOptionNumber: 50001,
};
const OWNER = {
  key: "x-owner",
  label: "Owner",
  description: "",
  valueSchema: { type: "object" as const, properties: { team: { type: "string" as const } } },
  targets: ["entity" as const],
  scope: "schema" as const,
  placement: "field" as const,
  requiredWhen: "never" as const,
  protobufOptionNumber: 50002,
};
const METADATA: MetadataEmissionContext = { definitions: [SECURITY, REVIEW, OWNER] };

const entity: PrismaEntityInput = {
  id: "ent-cust",
  name: "Customer",
  description: "A customer",
  status: "DRAFT",
  version: 1,
  domainId: "dom",
  metadata: { custom: { extensions: { "x-owner": { team: "crm" } } } },
  domain: { id: "dom", name: "Sales", slug: "sales" },
};

const ext = (openapi: Record<string, unknown>) => ({ typespec: { extensions: { openapi } } });
const base = { precision: null, scale: null, nullable: false, isKey: false, fieldNumber: null, description: "", aliases: [] };
const fields: PrismaFieldInput[] = [
  { ...base, id: "f1", name: "email", type: "string", classification: "PII", sortOrder: 0, decorators: ext({ "x-securityClassification": { data_class: "class2", data_category: "ConsumerPersonal" } }) },
  { ...base, id: "f2", name: "tags", type: "array", classification: null, sortOrder: 1, decorators: { arrayElementType: "string", ...ext({ "x-securityClassification": { data_class: "class3", data_category: "Intrinsic" } }) } },
  { ...base, id: "f3", name: "note", type: "string", classification: null, sortOrder: 2, decorators: ext({ "x-review-note": "check with legal" }) },
  { ...base, id: "f4", name: "bad", type: "string", classification: null, sortOrder: 3, decorators: ext({ "x-securityClassification": { data_class: "class9", data_category: "Intrinsic" } }) },
];

let withMeta: OfficialTypeSpecTargetResult;
let baseline: OfficialTypeSpecTargetResult;
let empty: OfficialTypeSpecTargetResult;
let internalOnly: OfficialTypeSpecTargetResult;

/** The `===== path =====` bundle split back into files (a single file is its bare content). */
function filesOf(output: string): Record<string, string> {
  const parts = output.split(/^===== (.+) =====$/m);
  if (parts.length === 1) return { "": output };
  const out: Record<string, string> = {};
  for (let i = 1; i < parts.length; i += 2) out[parts[i]] = parts[i + 1].replace(/^\n/, "");
  return out;
}

beforeAll(async () => {
  [withMeta, baseline, empty, internalOnly] = await Promise.all([
    emitOfficialTypeSpecTargetFromData(entity, fields, "protobuf", { metadata: METADATA }),
    emitOfficialTypeSpecTargetFromData(entity, fields, "protobuf"),
    emitOfficialTypeSpecTargetFromData(entity, fields, "protobuf", { metadata: { definitions: [] } }),
    emitOfficialTypeSpecTargetFromData(entity, fields, "protobuf", { metadata: { definitions: [REVIEW] } }),
  ]);
});

describe("metadata attributes as Protobuf custom options (real emitter)", () => {
  it("emits the options file and the annotated entity proto", () => {
    expect(withMeta.validationStatus).not.toBe("INVALID");
    const files = filesOf(withMeta.output);
    const options = files["superschema/metadata_options.proto"];
    expect(options).toBeDefined();
    expect(options).toContain("message XSecurityClassificationValue {\n  string data_class = 1;\n  string data_category = 2;\n}");
    expect(options).toContain("extend google.protobuf.FieldOptions {\n  XSecurityClassificationValue x_security_classification = 50000;\n}");
    expect(options).toContain("extend google.protobuf.MessageOptions {\n  XOwnerValue x_owner = 50002;\n}");
    const [protoPath] = Object.keys(files).filter((p) => p !== "superschema/metadata_options.proto");
    const proto = files[protoPath];
    expect(proto).toContain('import "superschema/metadata_options.proto";');
    expect(proto).toContain('string email = 1 [(.superschema.metadata.x_security_classification) = { data_class: "class2" data_category: "ConsumerPersonal" }];');
    expect(proto).toContain('repeated string tags = 2 [(.superschema.metadata.x_security_classification) = { data_class: "class3" data_category: "Intrinsic" }];');
    expect(proto).toContain('option (.superschema.metadata.x_owner) = { team: "crm" };');
    expect(withMeta.output).not.toContain("x-review-note");
    expect(withMeta.output).not.toContain("x_review_note");
  });

  it("a value that fails its value schema is skipped with a warning naming the field and the key", () => {
    const proto = Object.entries(filesOf(withMeta.output)).find(([p]) => p !== "superschema/metadata_options.proto")![1];
    expect(proto).toMatch(/^ {2}string bad = 4;$/m);
    const warning = withMeta.warnings.find((w) => w.includes('"bad"'));
    expect(warning).toContain("x-securityClassification");
    expect(withMeta.warnings.some((w) => w.includes("has no place for metadata attributes"))).toBe(false);
  });

  it("both .proto files parse together with descriptor.proto, and every option set is a declared extension of the right options message", () => {
    const files = filesOf(withMeta.output);
    const root = new Root();
    parse(readFileSync(join(process.cwd(), "node_modules/protobufjs/google/protobuf/descriptor.proto"), "utf8"), root, { keepCase: true });
    parse(files["superschema/metadata_options.proto"], root, { keepCase: true });
    for (const [path, content] of Object.entries(files)) if (path !== "superschema/metadata_options.proto") parse(content, root, { keepCase: true });
    expect(() => root.resolveAll()).not.toThrow();

    const customer = root.lookupType("Customer");
    expect(customer.fields.email.options?.["(.superschema.metadata.x_security_classification).data_category"]).toBe("ConsumerPersonal");
    expect(customer.options?.["(.superschema.metadata.x_owner).team"]).toBe("crm");
    const declared = (name: string) => root.lookup(`superschema.metadata.${name}`) as Field | null;
    for (const content of Object.values(files)) {
      for (const m of content.matchAll(/\(\.superschema\.metadata\.(\w+)\)/g)) {
        expect(declared(m[1]), m[1]).toBeInstanceOf(Field);
      }
    }
    expect(declared("x_security_classification")?.extend).toBe("google.protobuf.FieldOptions");
    expect(declared("x_owner")?.extend).toBe("google.protobuf.MessageOptions");
  });

  it("no dictionary, or only internal attributes: output byte-identical to the run without metadata", () => {
    expect(baseline.validationStatus).not.toBe("INVALID");
    expect(empty.output).toBe(baseline.output);
    expect(empty.warnings).toEqual(baseline.warnings);
    expect(internalOnly.output).not.toContain("superschema");
    expect(internalOnly.output).not.toContain("x-review-note");
  });

  it("the canonical source still carries the internal key", () => {
    expect(generateTypeSpec(compileEntity(entity, fields))).toContain("x-review-note");
  });

  it("event payloads keep one self-contained .proto and note the attributes that were not emitted", async () => {
    const versionDb = {
      entityVersion: {
        findUnique: async () => ({
          id: "v1", entityId: entity.id, major: 1, minor: 0, patch: 0, stage: "RELEASED",
          resolvedSource: generateTypeSpec(compileEntity(entity, fields)),
          fieldSnapshot: fields,
          entity: { name: "Customer", tenantId: "t1", domainId: null, productId: null, product: null },
        }),
      },
      schemaReference: { findMany: async () => [] },
      entity: { findUnique: async () => ({ tenant: { slug: "acme" }, domain: { slug: "sales" }, product: null }) },
    };
    const subject = { kind: "version" as const, entityVersionId: "v1", tenantId: "t1" };
    const rendered = await createArtifactRenderer({ db: versionDb as never, loadMetadata: async () => METADATA }).render(subject, "protobuf");
    if (!rendered.success) throw new Error(rendered.error.message);
    expect(rendered.data.artifact.format).toBe("protobuf");
    expect(String(rendered.data.artifact.schema)).not.toContain("superschema");
    const note = rendered.data.notes?.find((n) => n.code === "METADATA_ATTRIBUTES_NOT_EMITTED");
    expect(note?.message).toContain("x-securityClassification");
    expect(note?.message).not.toContain("x-review-note");

    const plain = await createArtifactRenderer({ db: versionDb as never, loadMetadata: async () => undefined }).render(subject, "protobuf");
    if (!plain.success) throw new Error(plain.error.message);
    expect(plain.data.notes).toBeUndefined();
    expect(plain.data.artifact.schema).toEqual(rendered.data.artifact.schema);
  });
});
