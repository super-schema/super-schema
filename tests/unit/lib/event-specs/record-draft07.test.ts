/**
 * C-I4 end to end: a TypeSpec `Record<T>` keeps its value type in the draft-07 payload (the 2020-12 emitter writes it
 * as `unevaluatedProperties`, which draft-07 lacks — the down-converter now maps it to `additionalProperties`).
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { compileEntity } from "@/lib/compiler/compiler.service";
import type { PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { inlineJsonSchemaBundle } from "@/lib/events/json-schema-bundle";
import { downConvertToDraft07 } from "@/lib/event-specs/json-schema-downconvert";
import type { JsonObject } from "@/lib/event-specs/types";

vi.mock("server-only", () => ({}));

let runTypeSpecEmitterFiles: typeof import("@/lib/typespec-official/emitter.service").runTypeSpecEmitterFiles;
beforeAll(async () => {
  ({ runTypeSpecEmitterFiles } = await import("@/lib/typespec-official/emitter.service"));
});

const field = (name: string, type: string, decorators: Record<string, unknown> = {}): PrismaFieldInput => ({
  id: name,
  name,
  type,
  precision: null,
  scale: null,
  nullable: false,
  isKey: false,
  fieldNumber: null,
  description: "",
  classification: null,
  aliases: [],
  decorators,
  sortOrder: 0,
});

describe("Record<T> in the draft-07 payload", () => {
  it("keeps the map value type as additionalProperties", async () => {
    const source = generateTypeSpec(
      compileEntity(
        {
          id: "e1",
          name: "Child",
          description: "",
          status: "DRAFT",
          version: 1,
          domainId: "d1",
          metadata: {},
          domain: { id: "d1", name: "Sales", slug: "sales" },
        },
        [
          field("tags", "map", { mapKeyType: "string", mapValueType: "int32" }),
          field("labels", "map", { mapKeyType: "string", mapValueType: "string" }),
        ],
      ),
      { governance: false },
    );
    expect(source).toContain("tags: Record<int32>;");

    const emitted = await runTypeSpecEmitterFiles("@typespec/json-schema", `import "@typespec/json-schema";\n\n${source}`, {
      emitAllModels: true,
      "file-type": "json",
      bundleId: "Child",
    });
    if (!emitted.success) throw new Error(emitted.error.message);
    const bundle = JSON.parse(emitted.data[0].content) as JsonObject;
    const inlined = inlineJsonSchemaBundle(bundle, "Child");
    if (!inlined.success) throw new Error(inlined.error.message);

    // 2020-12: the value type rides in `unevaluatedProperties` …
    const defs2020 = inlined.data.$defs as Record<string, JsonObject>;
    expect(defs2020.RecordInt32.unevaluatedProperties).toMatchObject({ type: "integer" });

    // … and survives the draft-07 down-conversion as `additionalProperties`, with no dropped-keyword warning.
    const { schema, warnings } = downConvertToDraft07(inlined.data);
    const defs07 = schema.definitions as Record<string, JsonObject>;
    expect(defs07.RecordInt32).toMatchObject({ type: "object", additionalProperties: { type: "integer" } });
    expect(defs07.RecordString).toMatchObject({ type: "object", additionalProperties: { type: "string" } });
    expect(defs07.RecordInt32.unevaluatedProperties).toBeUndefined();
    expect(warnings.filter((w) => w.keyword === "unevaluatedProperties")).toEqual([]);
  }, 120_000);
});
