/**
 * Metadata attributes at emission, through the real TypeSpec emitters: `internal` keys never reach a target output, an `abc-primitive`
 * key of a primitive array sits on `items`, Avro carries the values as custom properties, targets that cannot carry them say so, and a
 * tenant without a dictionary gets exactly today's output.
 */
import { describe, expect, it, vi, beforeAll } from "vitest";
import { parse as parseYaml } from "yaml";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { compileEntity } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { emitOfficialTypeSpecTargetFromData, type OfficialTypeSpecTargetResult } from "@/lib/typespec-official/emitter.service";
import type { MetadataAttributeDefinition } from "@/types/schemas/metadata-attribute";
import { assembleAsyncApi3 } from "@/lib/event-specs/assemble";
import type { JsonObject, ResolvedEventSpec } from "@/lib/event-specs/types";
import { createArtifactRenderer } from "@/services/events/artifact-renderer";

vi.mock("server-only", () => ({}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const SECURITY: MetadataAttributeDefinition = {
  key: "x-securityClassification",
  label: "Security classification",
  description: "How sensitive the data is",
  valueSchema: {
    type: "object",
    properties: {
      data_category: {
        type: "string",
        enum: ["ConsumerPersonal", "BusinessPersonal", "BusinessCompany", "EmployeePersonal", "PayPalCompany", "Intrinsic"],
      },
      data_class: { type: "string" },
    },
    required: ["data_category"],
  },
  targets: ["field"],
  scope: "schema",
  placement: "abc-primitive",
  derive: { data_class: "{class}" },
  requiredWhen: "primitive",
  pack: "paypal",
};
const REVIEW: MetadataAttributeDefinition = {
  key: "x-review-note",
  label: "Review note",
  description: "",
  valueSchema: { type: "string" },
  targets: ["field"],
  scope: "internal",
  placement: "field",
  requiredWhen: "never",
};
const METADATA = { definitions: [SECURITY, REVIEW] };

const entity: PrismaEntityInput = {
  id: "ent-cust",
  name: "Customer",
  description: "A customer",
  status: "DRAFT",
  version: 1,
  domainId: "dom",
  metadata: null,
  domain: { id: "dom", name: "Sales", slug: "sales" },
};

const ext = (openapi: Record<string, unknown>) => ({ typespec: { extensions: { openapi } } });
const base = { precision: null, scale: null, nullable: false, isKey: false, fieldNumber: null, description: "", aliases: [] };
const fields: PrismaFieldInput[] = [
  { ...base, id: "f1", name: "email", type: "string", classification: "PII", sortOrder: 0, decorators: ext({ "x-securityClassification": { data_class: "class2", data_category: "ConsumerPersonal" } }) },
  { ...base, id: "f2", name: "tags", type: "array", classification: null, sortOrder: 1, decorators: { arrayElementType: "string", ...ext({ "x-securityClassification": { data_class: "class3", data_category: "Intrinsic" } }) } },
  { ...base, id: "f3", name: "note", type: "string", classification: null, sortOrder: 2, decorators: ext({ "x-review-note": "check with legal" }) },
];

const TARGETS = ["json-schema", "openapi3", "avro", "java-pojo"] as const;
type Target = (typeof TARGETS)[number];
const withMeta = {} as Record<Target, OfficialTypeSpecTargetResult>;
const baseline = {} as Record<Target, OfficialTypeSpecTargetResult>;
const empty = {} as Record<Target, OfficialTypeSpecTargetResult>;

/** The `===== path =====` bundle split back into files (a single file is its bare content). */
function filesOf(output: string): Record<string, string> {
  const parts = output.split(/^===== (.+) =====$/m);
  if (parts.length === 1) return { "": output };
  const out: Record<string, string> = {};
  for (let i = 1; i < parts.length; i += 2) out[parts[i]] = parts[i + 1].replace(/^\n/, "");
  return out;
}
const fileEnding = (output: string, suffix: string): string => {
  const files = filesOf(output);
  const key = Object.keys(files).find((k) => k.endsWith(suffix)) ?? "";
  return files[key];
};

beforeAll(async () => {
  await Promise.all(
    TARGETS.map(async (t) => {
      withMeta[t] = await emitOfficialTypeSpecTargetFromData(entity, fields, t, { metadata: METADATA });
      baseline[t] = await emitOfficialTypeSpecTargetFromData(entity, fields, t);
      empty[t] = await emitOfficialTypeSpecTargetFromData(entity, fields, t, { metadata: { definitions: [] } });
    })
  );
});

describe("metadata attributes at emission (real emitters)", () => {
  it("JSON Schema: the field block stays, the array block moves to items, the internal key is gone", () => {
    expect(withMeta["json-schema"].validationStatus).not.toBe("INVALID");
    const schema = JSON.parse(fileEnding(withMeta["json-schema"].output, "Customer.json"));
    expect(schema.properties.email["x-securityClassification"]).toEqual({ data_class: "class2", data_category: "ConsumerPersonal" });
    expect(schema.properties.tags["x-securityClassification"]).toBeUndefined();
    expect(schema.properties.tags.items["x-securityClassification"].data_class).toBe("class3");
    expect(withMeta["json-schema"].output).not.toContain("x-review-note");
  });

  it("OpenAPI 3: the same under components.schemas.Customer", () => {
    expect(withMeta.openapi3.validationStatus).not.toBe("INVALID");
    const doc = parseYaml(fileEnding(withMeta.openapi3.output, ".yaml"));
    const customer = doc.components.schemas.Customer;
    expect(customer.properties.email["x-securityClassification"]).toEqual({ data_class: "class2", data_category: "ConsumerPersonal" });
    expect(customer.properties.tags["x-securityClassification"]).toBeUndefined();
    expect(customer.properties.tags.items["x-securityClassification"].data_class).toBe("class3");
    expect(withMeta.openapi3.output).not.toContain("x-review-note");
  });

  it("Avro: the email field object carries the property; no internal key", () => {
    expect(withMeta.avro.validationStatus).not.toBe("INVALID");
    const record = JSON.parse(fileEnding(withMeta.avro.output, ".avsc"));
    const email = record.fields.find((f: { name: string }) => f.name === "email");
    expect(email["x-securityClassification"]).toEqual({ data_class: "class2", data_category: "ConsumerPersonal" });
    expect(withMeta.avro.output).not.toContain("x-review-note");
  });

  it("Java POJO: a warning lists the skipped keys", () => {
    expect(withMeta["java-pojo"].warnings.some((w) => w.includes("x-securityClassification"))).toBe(true);
    expect(baseline["java-pojo"].warnings.some((w) => w.includes("x-securityClassification"))).toBe(false);
  });

  it("the canonical source still carries the internal key", () => {
    expect(generateTypeSpec(compileEntity(entity, fields))).toContain("x-review-note");
  });

  it("no dictionary: outputs are byte-identical to the run without metadata", () => {
    for (const t of TARGETS) {
      expect(baseline[t].validationStatus, t).not.toBe("INVALID");
      expect(empty[t].output, t).toBe(baseline[t].output);
      expect(empty[t].warnings, t).toEqual(baseline[t].warnings);
    }
    // Sanity: without metadata nothing is projected (the internal key is emitted as an ordinary extension, as today).
    expect(baseline["json-schema"].output).toContain("x-review-note");
  });

  it("event payloads (the artifact renderer, real emitters): the block is there, on items for the array, no internal key; an AsyncAPI document carries it", async () => {
    const versionDb = {
      entityVersion: {
        findUnique: async () => ({
          id: "v1", entityId: entity.id, major: 1, minor: 0, patch: 0, stage: "RELEASED",
          // The frozen canonical source, overlay and internal key included.
          resolvedSource: generateTypeSpec(compileEntity(entity, fields)),
          fieldSnapshot: fields,
          entity: { name: "Customer", tenantId: "t1", domainId: null, productId: null, product: null },
        }),
      },
      schemaReference: { findMany: async () => [] },
      entity: { findUnique: async () => ({ tenant: { slug: "acme" }, domain: { slug: "sales" }, product: null }) },
    };
    const renderer = createArtifactRenderer({ db: versionDb as never, loadMetadata: async () => METADATA });
    const subject = { kind: "version" as const, entityVersionId: "v1", tenantId: "t1" };
    const [json, avro] = await Promise.all([renderer.render(subject, "json-schema"), renderer.render(subject, "avro")]);
    if (!json.success) throw new Error(json.error.message);
    if (!avro.success) throw new Error(avro.error.message);

    const schema = json.data.artifact.schema as JsonObject;
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.email["x-securityClassification"]).toEqual({ data_class: "class2", data_category: "ConsumerPersonal" });
    expect(props.tags["x-securityClassification"]).toBeUndefined();
    expect((props.tags.items as Record<string, Record<string, unknown>>)["x-securityClassification"].data_class).toBe("class3");
    expect(JSON.stringify(schema)).not.toContain("x-review-note");

    const record = avro.data.artifact.schema as { fields: Array<Record<string, unknown>> };
    expect(record.fields.find((f) => f.name === "email")?.["x-securityClassification"]).toEqual({ data_class: "class2", data_category: "ConsumerPersonal" });
    expect(JSON.stringify(record)).not.toContain("x-review-note");

    const spec: ResolvedEventSpec = {
      productSlug: "sales",
      info: { title: "customers", version: "1.0" },
      servers: [],
      operations: [{ key: "publishCustomer", action: "send", channelRef: "ch", messageRefs: ["m"], traitRefs: [] }],
      channels: [{ id: "ch", name: "customers", productSlug: "sales", address: "customers.v1", protocol: "kafka", profile: { format: "json-schema", dialect: "2020-12" } }],
      messages: [{ id: "m", name: "CustomerChanged", productSlug: "sales", traitRefs: [], payloads: [json.data.artifact, avro.data.artifact] }],
      traits: [],
      components: {},
    };
    const { document } = assembleAsyncApi3(spec);
    const messages = (document.components as JsonObject).messages as Record<string, JsonObject>;
    const payload = JSON.stringify(Object.values(messages).map((m) => m.payload));
    expect(payload).toContain('"x-securityClassification"');
    expect(payload).toContain('"class2"');
    expect(payload).not.toContain("x-review-note");
  });
});

describe("internal keys nested in another attribute value (R10, A1, real emitters)", () => {
  const nestedField: PrismaFieldInput = { ...base, id: "f4", name: "meta", type: "string", classification: null, sortOrder: 3, decorators: ext({ "x-meta": { owner: "team", "x-review-note": "nested secret" } }) };
  it.each(["json-schema", "openapi3", "avro"] as const)("%s: the nested internal key never reaches the output; the rest of the value does", async (t) => {
    const leaky = await emitOfficialTypeSpecTargetFromData(entity, [...fields, nestedField], t);
    // Without a dictionary, the emitter writes the nested value as is (what the projection by top-level key misses).
    if (t !== "avro") expect(leaky.output).toContain("nested secret");
    const out = await emitOfficialTypeSpecTargetFromData(entity, [...fields, nestedField], t, { metadata: METADATA });
    expect(out.validationStatus).not.toBe("INVALID");
    expect(out.output).not.toContain("nested secret");
    expect(out.output).not.toContain("x-review-note");
    if (t !== "avro") expect(out.output).toContain("x-meta");
  });
});
