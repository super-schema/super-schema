/**
 * Acceptance test (plan Task 14): the user's `user event` JSON Schema through the whole import -> persist -> compile -> emit chain,
 * with the app's real emitters (@typespec/json-schema and the sibling BigQuery package). Pasted as text there is no base URL, so
 * both `$ref`s are unresolvable by design and must stay dangling references.
 */
import { describe, expect, it, vi, beforeAll } from "vitest";
// These tests shell out to the real TypeSpec compiler / emitters (~1 s each); under load the 5 s default is too tight.
vi.setConfig({ testTimeout: 60_000 });
import type { Prisma } from "@/generated/prisma/client";
import { createImportedEntities, type ImportedEntityInput } from "@/services/imported-entities";
import { compileEntity, type PrismaEntityInput, type PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { toAssetImportResult } from "@/lib/importers/multi-asset";
import { buildImportAssetsPayload } from "@/lib/importers/import-payload";
import { danglingReferenceOf } from "@/components/custom/ImportDialog/ParsedFieldDetails";
import { getSchemaTargetCatalog } from "@/lib/schema-targets/catalog";
import { activeDanglingRef } from "@/lib/field-dangling";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { getTargetRequirements, primaryKeyIneligibility } from "@/lib/schema-targets/requirements";

vi.mock("server-only", () => ({}));

const USER_EVENT = {
  type: "object",
  description: "A user event containing user level customer id information used to link a user across different tenants.",
  properties: {
    component: {
      type: "string",
      description: "Name of the source component logging the user event(s).",
      minLength: 1,
      maxLength: 100,
      pattern: "^([A-Za-z0-9-_])+$",
      "x-securityClassification": { data_class: "class4", data_category: "Intrinsic" },
    },
    tenant: {
      type: "string",
      description: "Name of the adjacency to PayPal.",
      minLength: 1,
      maxLength: 100,
      pattern: "^[a-z0-9_]+$",
      "x-securityClassification": { data_class: "class4", data_category: "PayPalCompany" },
    },
    created_time: {
      description: "Event creation timestamp.",
      $ref: "common_components/v4/schema/json/openapi-2.0/date_time.json",
      "x-securityClassification": { data_class: "class4", data_category: "Intrinsic" },
    },
    user_links: {
      type: "array",
      description: "List of list of users and their customer ids along with tenant information.",
      minItems: 1,
      maxItems: 100,
      items: { $ref: "user_links.json" },
    },
  },
  required: ["user_links", "created_time", "tenant"],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any> & { name: string; type: string; nullable: boolean; isKey: boolean; decorators: Record<string, any> };

let imported: ReturnType<typeof importUserEvent>;
let rows: Row[];
let metadata: Record<string, unknown> | undefined;

function importUserEvent() {
  const parsed = parseJsonSchemaDocument(JSON.stringify(USER_EVENT));
  if (!parsed.success) throw new Error(parsed.error.message);
  return parsed.data;
}

async function persist(): Promise<void> {
  const result = toAssetImportResult(imported);
  const payload = buildImportAssetsPayload(result, {
    domainId: "d", selectedModels: [], selectedEntities: [0], selectedEnums: [], selectedScalars: [],
    selectedUnions: [], selectedServices: [], selectedDecorators: [],
  });
  payload.entities[0].name = "UserEvent";
  const create = vi.fn(async ({ data }: { data: { name: string } }) => ({ id: `id-${data.name}` }));
  const tx = { entity: { create, findFirst: vi.fn().mockResolvedValue(null) } } as unknown as Prisma.TransactionClient;
  await createImportedEntities(tx, {
    entities: [payload.entities[0] as unknown as ImportedEntityInput],
    productScope: { tenantId: "t", domainId: "d", productId: "p" },
    productId: "p",
    ownerId: "u",
    sourceFormat: "jsonschema",
    isNameFree: async () => true,
    skip: () => {},
    refs: new Map(),
  });
  const data = create.mock.calls[0][0].data as unknown as { metadata?: Record<string, unknown>; fields: { create: Row[] } };
  rows = data.fields.create;
  metadata = data.metadata;
}

const entity = (): PrismaEntityInput => ({
  id: "e1", name: "UserEvent", description: "", status: "DRAFT", version: 1, domainId: "d", metadata,
  domain: { id: "d", name: "Sales", slug: "sales" },
});
const prismaFields = (keys: string[] = []): PrismaFieldInput[] =>
  rows.map((r, i) => ({
    id: `f${i}`, name: r.name, type: r.type, precision: null, scale: null, nullable: r.nullable, isKey: keys.includes(r.name),
    fieldNumber: null, description: (r.description as string) ?? "", classification: (r.classification as string) ?? null,
    aliases: [], decorators: r.decorators, sortOrder: i,
  })) as PrismaFieldInput[];

beforeAll(async () => {
  imported = importUserEvent();
  await persist();
});

const row = (name: string) => rows.find((r) => r.name === name)!;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const importedField = (name: string): any => imported.entities[0].fields.find((f) => f.name === name)!;

describe("user event schema: import", () => {
  it("yields one entity with the four fields", () => {
    expect(imported.entities).toHaveLength(1);
    expect(rows.map((r) => r.name)).toEqual(["component", "tenant", "created_time", "user_links"]);
  });

  it("respects the required list", () => {
    expect(row("component").nullable).toBe(true);
    for (const name of ["tenant", "created_time", "user_links"]) expect(row(name).nullable).toBe(false);
  });

  it("maps x-securityClassification to classification + data category", () => {
    for (const [name, category] of [["component", "Intrinsic"], ["tenant", "PayPalCompany"], ["created_time", "Intrinsic"]]) {
      expect(row(name).classification).toBe("class4");
      expect(row(name).decorators.classification).toEqual({ level: "class4" });
      expect(row(name).decorators.governance).toEqual({ dataClass: "class4", dataCategory: category });
    }
    expect(row("user_links").classification ?? null).toBeNull();
  });

  it("keeps the constraints", () => {
    expect(row("component").decorators.typespec.validation).toEqual({ minLength: 1, maxLength: 100, pattern: "^([A-Za-z0-9-_])+$" });
    expect(row("tenant").decorators.typespec.validation).toEqual({ minLength: 1, maxLength: 100, pattern: "^[a-z0-9_]+$" });
    expect(row("user_links").decorators.typespec.validation).toEqual({ minItems: 1, maxItems: 100 });
  });

  it("keeps the x-securityClassification block verbatim in the field extensions", () => {
    expect(row("component").decorators.typespec.extensions.openapi).toEqual({
      "x-securityClassification": { data_class: "class4", data_category: "Intrinsic" },
    });
    expect(row("tenant").decorators.typespec.extensions.openapi).toEqual({
      "x-securityClassification": { data_class: "class4", data_category: "PayPalCompany" },
    });
    expect(row("created_time").decorators.typespec.extensions.openapi).toEqual({
      "x-securityClassification": { data_class: "class4", data_category: "Intrinsic" },
    });
  });

  it("imports created_time and the items of user_links as low-confidence references (a pasted text has no base URL)", () => {
    const created = importedField("created_time");
    expect(created).toMatchObject({ type: "reference", confidence: "low", referencedEntityName: "date_time" });
    expect(created.originalType).toBe("common_components/v4/schema/json/openapi-2.0/date_time.json");
    const links = importedField("user_links");
    expect(links).toMatchObject({ type: "array", confidence: "low", referencedEntityName: "user_links" });
    // The raw $ref string is the persisted marker (also for pasted text); the array's marker is about its ITEMS.
    expect(created.danglingRef).toMatchObject({ ref: "common_components/v4/schema/json/openapi-2.0/date_time.json" });
    expect(created.danglingRef.element).toBeUndefined();
    expect(links.danglingRef).toMatchObject({ ref: "user_links.json", element: true });
    expect(row("created_time").decorators.danglingRef).toMatchObject({ ref: "common_components/v4/schema/json/openapi-2.0/date_time.json" });
    expect(row("user_links").decorators.danglingRef).toMatchObject({ ref: "user_links.json", element: true });
    const names = new Set(imported.entities.map((e) => e.name));
    expect(danglingReferenceOf(created, names)).toBeDefined();
    expect(danglingReferenceOf(links, names)).toBeDefined();
  });

  it("keeps the description of created_time next to its $ref", () => {
    expect(row("created_time").description).toBe("Event creation timestamp.");
  });
});

describe("user event schema: emission with the real emitters", () => {
  let emit: typeof import("@/lib/typespec-official/emitter.service").emitOfficialTypeSpecTargetFromData;
  beforeAll(async () => {
    ({ emitOfficialTypeSpecTargetFromData: emit } = await import("@/lib/typespec-official/emitter.service"));
  });

  const resolvedOnly = () => prismaFields().filter((f) => f.type !== "reference" && f.type !== "array");

  it("compiles the entity to the IR (compileEntity)", () => {
    const model = compileEntity(entity(), prismaFields());
    expect(model.entity.name).toBe("UserEvent");
    expect(model.fields.map((f) => f.name)).toEqual(["component", "tenant", "created_time", "user_links"]);
  });

  it("re-emits the resolvable fields as JSON Schema with one x-securityClassification per field, descriptions, constraints, required", async () => {
    const result = await emit(entity(), resolvedOnly(), "json-schema");
    expect(result.errors).toEqual([]);
    const schema = (JSON.parse(result.output) as { $defs: { UserEvent: { properties: Record<string, Record<string, unknown>>; required?: string[] } } }).$defs.UserEvent;
    expect(schema.properties.component).toMatchObject({
      type: "string", minLength: 1, maxLength: 100, pattern: "^([A-Za-z0-9-_])+$",
      description: "Name of the source component logging the user event(s).",
      "x-securityClassification": { data_class: "class4", data_category: "Intrinsic" },
    });
    expect(schema.properties.tenant).toMatchObject({
      pattern: "^[a-z0-9_]+$", "x-securityClassification": { data_class: "class4", data_category: "PayPalCompany" },
    });
    expect(schema.required).toEqual(["tenant"]);
    expect(result.output.match(/x-securityClassification/g)).toHaveLength(2); // both extension spellings collapse into one key
  });

  // An unresolved external $ref is kept losslessly: the field is generated as `unknown` carrying the raw reference, so the
  // entity compiles and the emitted schema still says where the type lives.
  it.each(["json-schema", "openapi3"])("%s: the FULL entity generates and keeps the raw $ref strings, constraints and classification blocks", async (target) => {
    const result = await emit(entity(), prismaFields(), target);
    expect(result.errors).toEqual([]);
    expect(result.output).toContain("common_components/v4/schema/json/openapi-2.0/date_time.json");
    expect(result.output).toContain("user_links.json");
    expect(result.output).toContain("minItems");
    expect(result.output).toContain("maxItems");
    expect(result.output.match(/x-securityClassification/g)).toHaveLength(3);
  });

  it("json-schema: created_time is { $ref } and user_links is an array with items { $ref } and its bounds", async () => {
    const result = await emit(entity(), prismaFields(), "json-schema");
    const schema = (JSON.parse(result.output) as { $defs: { UserEvent: { properties: Record<string, Record<string, unknown>>; required: string[] } } }).$defs.UserEvent;
    expect(schema.properties.created_time).toMatchObject({
      $ref: "common_components/v4/schema/json/openapi-2.0/date_time.json",
      description: "Event creation timestamp.",
      "x-securityClassification": { data_class: "class4", data_category: "Intrinsic" },
    });
    expect(schema.properties.user_links).toMatchObject({ type: "array", minItems: 1, maxItems: 100, items: { $ref: "user_links.json" } });
    expect([...schema.required].sort()).toEqual(["created_time", "tenant", "user_links"]);
  });

  it("asks for a primary key for BigQuery before one is set; the array field is no candidate", () => {
    const asked = getTargetRequirements("bigquery", {
      name: "UserEvent",
      // The shape loadRequirementShape builds: `dangling` from the persisted marker.
      fields: prismaFields().map((f) => ({
        name: f.name, isKey: f.isKey, nullable: f.nullable, type: f.type,
        dangling: activeDanglingRef(f.type, f.decorators as Record<string, unknown>) !== undefined,
      })),
    });
    expect(asked.missing).toHaveLength(1);
    expect(asked.missing[0].code).toBe("primary-key");
    // created_time is an unresolved reference and user_links an array: neither can identify a row.
    expect(asked.missing[0].candidates).toEqual(["component", "tenant"]);
    for (const name of ["created_time", "user_links"]) {
      const f = prismaFields().find((x) => x.name === name)!;
      expect(primaryKeyIneligibility({ name, type: f.type, dangling: activeDanglingRef(f.type, f.decorators as Record<string, unknown>) !== undefined })).not.toBeNull();
    }
    expect(asked.missing[0].suggested).toEqual(["tenant"]);
  });

  it("emits BigQuery DDL for the resolvable fields once tenant is the key", async () => {
    const result = await emit(entity(), resolvedOnly().map((f) => ({ ...f, isKey: f.name === "tenant" })), "bigquery");
    expect(result.errors).toEqual([]);
    expect(result.output).toMatch(/tenant/);
    expect(result.output).toMatch(/component/);
  });

  it("BigQuery keeps the dangling reference fields as STRING / ARRAY<STRING> columns and says so in a note", async () => {
    const result = await emit(entity(), prismaFields(["tenant"]), "bigquery");
    expect(result.errors).toEqual([]);
    expect(result.output).toContain("created_time STRING NOT NULL");
    expect(result.output).toContain("user_links ARRAY<STRING> NOT NULL");
    expect(result.output).toContain("PRIMARY KEY (tenant) NOT ENFORCED");
    expect(result.output).toContain("created_time: declared reference; stored as STRING");
  });

  // Every target the Schemas tab offers for a typespec-cli emitter: none may fail on the unresolved references.
  const ENABLED = getSchemaTargetCatalog().filter((t) => t.runtime === "typespec-cli" && t.enabledInSchemaTab).map((t) => t.key);

  it("has targets to check", () => {
    expect(ENABLED).toEqual(expect.arrayContaining(["json-schema", "openapi3", "bigquery", "postgresql", "spanner"]));
  });

  it.each(ENABLED)("%s: generation succeeds for the user event entity (tenant as the key) with zero error diagnostics", async (target) => {
    const result = await emit(entity(), prismaFields(["tenant"]), target);
    expect(result.errors).toEqual([]);
    expect(result.output.length).toBeGreaterThan(0);
  });

  it.each(["bigquery", "postgresql", "spanner"])("%s: the unresolved references stay STRING-typed columns with a visible note", async (target) => {
    const result = await emit(entity(), prismaFields(["tenant"]), target);
    expect(result.output).toMatch(/created_time: declared reference; stored as/);
    expect(result.output).toMatch(/user_links: declared reference\[\]; stored as/);
  });

  it.each(["avro", "java-pojo", "protobuf"])("%s: the unresolved references degrade with a visible warning naming the raw reference", async (target) => {
    const result = await emit(entity(), prismaFields(["tenant"]), target);
    expect(result.errors).toEqual([]);
    expect(result.validationStatus).toBe("WARNING");
    expect(result.warnings.join("\n")).toContain("common_components/v4/schema/json/openapi-2.0/date_time.json");
    expect(result.warnings.join("\n")).toContain("user_links.json");
  });

  // Every decorator the generator can emit that is invalid on `unknown` (format, secret, encode, min/max, pattern, discriminator ...)
  // on a dangling field, plus a classification: no target may report an error.
  const loaded = (): PrismaFieldInput[] =>
    prismaFields(["tenant"]).map((f) =>
      f.name === "created_time"
        ? {
            ...f,
            decorators: {
              ...(f.decorators as Record<string, unknown>),
              typespec: {
                ...((f.decorators as { typespec?: Record<string, unknown> }).typespec ?? {}),
                identity: { format: "date-time", secret: true, discriminator: true },
                validation: { minLength: 1, maxLength: 9, pattern: "^a$", minValue: 1, maxValue: 5 },
                wireFormat: { encode: "base64", encodedNames: { "application/json": "createdTime" } },
              },
            },
          }
        : f,
    );

  it.each(ENABLED)("%s: a dangling field carrying format, secret, encode, min/max, pattern, discriminator and a classification compiles without errors", async (target) => {
    const result = await emit(entity(), loaded(), target);
    expect(result.errors).toEqual([]);
  });

  it("the skipped decorators never reach the source of a dangling field (the rest stays)", () => {
    const text = generateTypeSpec(compileEntity(entity(), loaded()), { governance: false });
    const block = text.slice(text.indexOf('@doc("Event creation timestamp.")'), text.indexOf("created_time: unknown;"));
    for (const bad of ["@format", "@encode(", "@minLength", "@maxLength", "@pattern", "@minValue", "@discriminator"]) expect(block).not.toContain(bad);
    for (const good of ["@secret", "@encodedName", '@TypeSpec.JsonSchema.extension("$ref"', '"x-securityClassification"']) expect(block).toContain(good);
  });

  it("a hostile raw reference survives verbatim in the JSON Schema and cannot break out of the string", async () => {
    const hostile = 'a\nb ${x} */ `t` "); model Evil { evil: string; } //\\ x.json';
    const fields = prismaFields(["tenant"]).map((f) =>
      f.name === "created_time"
        ? { ...f, decorators: { ...(f.decorators as Record<string, unknown>), danglingRef: { ref: hostile, reason: "x" } } }
        : f,
    );
    const result = await emit(entity(), fields, "json-schema");
    expect(result.errors).toEqual([]);
    const schema = JSON.parse(result.output) as { $defs: Record<string, { properties: Record<string, { $ref?: string }> }> };
    expect(Object.keys(schema.$defs)).toEqual(["UserEvent"]);
    expect(schema.$defs.UserEvent.properties.created_time.$ref).toBe(hostile);
  });
});
