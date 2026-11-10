import type { ClosureEntity } from "@/lib/references/closure";
import { generateClosureTypeSpec } from "@/lib/compiler/closure-source";
import { writeFieldReference } from "@/lib/references/entity-reference";
import { describe, it, expect, vi } from "vitest";
import {
  compileEntity,
  type PrismaEntityInput,
  type PrismaFieldInput,
} from "@/lib/compiler/compiler.service";
import { generateTypeSpecWithDiagnostics } from "@/lib/compiler/typespec-generator";
import { compileTypeSpecWithGovernance } from "@/lib/compiler/typespec-compiler";
import { emitOfficialTypeSpecTargetFromData } from "@/lib/typespec-official/emitter.service";
import { parseTypeSpec } from "@/lib/compiler/typespec-parser";
import { mergeSyncedField } from "@/lib/typespec-sync/merge-fields";
import { storeFieldPresence } from "@/lib/field-attributes";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.setConfig({ testTimeout: 60_000 });
const entity: PrismaEntityInput = {
  id: "e",
  name: "RecordItem",
  description: "",
  status: "DRAFT",
  version: 1,
  domainId: "d",
  metadata: {},
  domain: { id: "d", name: "Sales", slug: "sales" },
};
const field = (patch: Partial<PrismaFieldInput> = {}): PrismaFieldInput => ({
  id: "f",
  name: "value",
  type: "string",
  nullable: false,
  isKey: false,
  fieldNumber: null,
  precision: null,
  scale: null,
  aliases: [],
  description: "",
  decorators: {},
  classification: null,
  sortOrder: 0,
  ...patch,
});
function source(fields: PrismaFieldInput[]) {
  return generateTypeSpecWithDiagnostics(compileEntity(entity, fields), {
    governance: false,
  });
}
async function clean(text: string) {
  const result = await compileTypeSpecWithGovernance(text);
  expect(
    result.diagnostics.filter((d) => d.severity === "error"),
    text,
  ).toEqual([]);
}

describe("field attributes through the real compiler and emitters", () => {
  it("writes one description and no summary, recovering legacy text", async () => {
    const result = source([
      field({
        decorators: {
          typespec: {
            documentation: {
              doc: "Full description",
              summary: "Short description",
            },
          },
        },
      }),
    ]);
    expect(result.source).toContain('@doc("Full description")');
    expect(result.source).not.toContain("@summary");
    await clean(result.source);
  });
  it.each([
    { phases: [], invisible: true },
    { phases: ["Read"], removeVisibility: true },
  ])("compiles the visibility setting %j", async (visibility) => {
    const result = source([
      field({ decorators: { typespec: { visibility } } }),
    ]);
    expect(result.source).toContain(
      visibility.invisible
        ? "@invisible(Lifecycle)"
        : "@removeVisibility(Lifecycle.Create, Lifecycle.Update, Lifecycle.Delete, Lifecycle.Query)",
    );
    await clean(result.source);
  });
  it("declares and compiles every evolution annotation without requiring inaccessible domain settings", async () => {
    const result = source([
      field({
        nullable: true,
        decorators: {
          typespec: {
            versioning: {
              added: "v1",
              removed: "v3",
              madeOptional: "v2",
              renamedFrom: { version: "v2", oldName: "previous" },
              typeChangedFrom: { version: "v2", oldType: "int32" },
            },
          },
        },
      }),
      field({
        id: "f2",
        name: "requiredValue",
        decorators: { typespec: { versioning: { madeRequired: "v2" } } },
      }),
    ]);
    expect(result.source).toContain("enum SuperSchemaVersions");
    expect(result.source).toContain("@TypeSpec.Versioning.renamedFrom");
    expect(result.source).toContain("@TypeSpec.Versioning.madeRequired");
    await clean(result.source);
  });
  it("places a discriminator on its model and permits the field to also be a key", async () => {
    const result = source([
      field({
        name: "kind",
        isKey: true,
        decorators: {
          typespec: { identity: { discriminator: true, key: true } },
        },
      }),
    ]);
    expect(result.source).toMatch(/@discriminator\("kind"\)\nmodel RecordItem/);
    expect(result.source).toContain("  @key");
    await clean(result.source);
  });
  it("rejects an ambiguous discriminator selection", () => {
    expect(
      source([
        field({
          decorators: { typespec: { identity: { discriminator: true } } },
        }),
        field({
          name: "other",
          decorators: { typespec: { identity: { discriminator: true } } },
        }),
      ]).diagnostics,
    ).toEqual([
      expect.objectContaining({ severity: "error", code: "FIELD_ATTRIBUTE" }),
    ]);
  });
  it("emits all four presence/nullability combinations and blank-message deprecation", async () => {
    const fields = [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ].map(([optional, allowNull], i) =>
      field({
        id: `f${i}`,
        name: `field${i}`,
        ...storeFieldPresence(optional, allowNull, {
          typespec: { documentation: { deprecated: "" } },
        }),
        sortOrder: i,
      }),
    );
    const result = await emitOfficialTypeSpecTargetFromData(
      entity,
      fields,
      "json-schema",
    );
    expect(result.errors).toEqual([]);
    const schema = JSON.parse(result.output);
    expect(schema.required).toEqual(["field0", "field2"]);
    expect(schema.properties.field0.type).toBe("string");
    expect(schema.properties.field1.type).toBe("string");
    expect(JSON.stringify(schema.properties.field2)).toContain("null");
    expect(JSON.stringify(schema.properties.field3)).toContain("null");
    for (const property of Object.values(schema.properties) as {
      deprecated?: boolean;
    }[])
      expect(property.deprecated).toBe(true);
  });
  it("preserves lifecycle and evolution through source application", () => {
    const original = field({
      decorators: {
        typespec: {
          visibility: { phases: ["Read"], removeVisibility: true },
          versioning: {
            added: "1.0",
            madeOptional: "2.0",
            renamedFrom: { version: "2.0", oldName: "oldValue" },
          },
        },
      },
    });
    const parsed = parseTypeSpec(source([original]).source)!;
    const merged = mergeSyncedField(original, {
      ...parsed.fields[0],
      decorators: { ...parsed.fields[0].decorators },
    });
    expect(merged.decorators).toMatchObject({
      typespec: {
        visibility: { phases: ["Read"], removeVisibility: true },
        versioning: {
          added: "1.0",
          madeOptional: "2.0",
          renamedFrom: { version: "2.0", oldName: "oldValue" },
        },
      },
    });
  });
  it("compiles evolution on referencing entities with independent namespaces", async () => {
    const child: ClosureEntity = {
      entityId: "child",
      ref: {
        entityId: "child",
        domain: "Sales",
        product: "Accounts",
        entity: "Customer",
      },
      source: "published",
      version: "1.0",
      entity: { ...entity, id: "child", name: "Customer" },
      fields: [
        field({
          name: "name",
          decorators: { typespec: { versioning: { added: "v1" } } },
        }),
      ],
    };
    const root: ClosureEntity = {
      entityId: "root",
      ref: {
        entityId: "root",
        domain: "Sales",
        product: "Orders",
        entity: "Order",
      },
      source: "published",
      version: "1.0",
      entity: { ...entity, id: "root", name: "Order" },
      fields: [
        field({
          name: "buyer",
          type: "reference",
          decorators: writeFieldReference(
            { typespec: { versioning: { added: "v1" } } },
            child.ref,
          ),
        }),
      ],
    };
    await clean(
      generateClosureTypeSpec(
        { entities: [root, child] },
        { target: "json-schema" },
      ).source,
    );
  });
  it.each([
    "json-schema",
    "openapi3",
    "avro",
    "protobuf",
    "java-pojo",
    "postgresql",
    "spanner",
    "bigquery",
  ])(
    "compiles field evolution and external documentation for %s",
    async (target) => {
      const result = await emitOfficialTypeSpecTargetFromData(
        entity,
        [
          field({
            decorators: {
              typespec: {
                versioning: { added: "v1" },
                documentation: {
                  externalDocsUrl: "https://example.com/field",
                  externalDocsDescription: "Reference",
                },
              },
            },
          }),
          field({
            id: "pk",
            name: "id",
            type: "int32",
            isKey: true,
            sortOrder: 1,
          }),
        ],
        target,
      );
      expect(result.errors).toEqual([]);
      expect(result.output).toBeTruthy();
    },
  );
  it("compiles numeric encodings as scalar arguments", async () => {
    await clean(
      source([
        field({
          type: "utcDateTime",
          decorators: {
            typespec: {
              wireFormat: { encode: "unixTimestamp", encodeSubType: "int64" },
            },
          },
        }),
        field({
          name: "large",
          type: "int64",
          decorators: { typespec: { wireFormat: { encode: "string" } } },
        }),
      ]).source,
    );
  });
});

describe("clearing legacy field metadata", () => {
  it("does not emit duplicate deprecation directives and respects an explicit clear", async () => {
    const result = source([
      field({
        decorators: {
          evolution: { deprecated: true },
          typespec: { documentation: { deprecated: "" } },
        },
      }),
    ]);
    expect(result.source.match(/#deprecated/g)).toHaveLength(1);
    await clean(result.source);
    expect(
      source([
        field({
          decorators: {
            evolution: { deprecated: true },
            typespec: { documentation: { deprecated: null } },
          },
        }),
      ]).source,
    ).not.toContain("#deprecated");
  });
  it("applies removal of visibility and deprecation from authored source", () => {
    const existing = field({
      decorators: {
        evolution: { deprecated: true },
        typespec: { visibility: { phases: [], invisible: true } },
      },
    });
    const parsed = parseTypeSpec("model RecordItem {\n  value: string;\n}\n")!;
    const merged = mergeSyncedField(existing, {
      ...parsed.fields[0],
      decorators: { ...parsed.fields[0].decorators },
    });
    expect(merged.decorators).toMatchObject({
      typespec: { documentation: { deprecated: null } },
    });
    expect(
      (merged.decorators.typespec as { visibility?: unknown }).visibility,
    ).toBeUndefined();
  });
  it("recovers summary-only source text into an empty canonical description", () => {
    const parsed = parseTypeSpec(
      'model RecordItem {\n  @summary("Preserve me")\n  value: string;\n}\n',
    )!;
    const merged = mergeSyncedField(field(), {
      ...parsed.fields[0],
      decorators: { ...parsed.fields[0].decorators },
    });
    expect(merged.description).toBe("Preserve me");
  });
});
