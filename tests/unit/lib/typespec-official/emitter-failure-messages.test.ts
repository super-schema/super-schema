/**
 * An emitter that compiles cleanly but has nothing to write (no model it emits) never creates its output directory.
 * That is "no files" (`EMITTER_NO_OUTPUT`) — not a raw `ENOENT ... scandir <temp path>` reported as `EMITTER_FAILED`.
 * Likewise a failed compile reaches the Schemas tab as its error diagnostics only, never the compiler's banner or the
 * throw-away workspace path.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
import { emitOfficialTypeSpecTargetFromData, runTypeSpecEmitterFiles } from "@/lib/typespec-official/emitter.service";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";

describe("runTypeSpecEmitterFiles: an emitter that writes nothing", () => {
  it("reports EMITTER_NO_OUTPUT, not a scandir failure with the temp workspace path", async () => {
    // @typespec/json-schema emits only models in a @jsonSchema namespace (or with emitAllModels): this one has neither.
    const result = await runTypeSpecEmitterFiles("@typespec/json-schema", 'import "@typespec/json-schema";\nmodel A { x: string; }\n', {});

    expect(result).toMatchObject({ success: false, error: { code: "EMITTER_NO_OUTPUT" } });
    const message = !result.success ? result.error.message : "";
    expect(message).toContain("@typespec/json-schema");
    expect(message).not.toMatch(/scandir|ENOENT|superschema-tsp/);
  }, 60_000);
});

describe("a failed DB target shows its diagnostics, not the raw compiler output", () => {
  const entity: PrismaEntityInput = {
    id: "e1",
    name: "Keyless",
    description: "",
    status: "active",
    version: 1,
    domainId: "d1",
    metadata: {},
    domain: { id: "d1", name: "payments", slug: "payments" },
  };
  const noKey: PrismaFieldInput[] = [
    { id: "f1", name: "amount", type: "decimal", precision: 10, scale: 2, nullable: false, isKey: false, fieldNumber: null, description: "", classification: null, aliases: [], decorators: {}, sortOrder: 0 },
  ];

  it.each([["spanner"], ["postgresql"], ["bigquery"]])("%s: a table without a primary key is INVALID with one readable error", async (target) => {
    const result = await emitOfficialTypeSpecTargetFromData(entity, noKey, target);

    expect(result.validationStatus).toBe("INVALID");
    expect(result.output).toBe("");
    expect(result.errors).toHaveLength(1);
    const message = result.errors[0].message;
    expect(message).toMatch(/missing-primary-key: Table 'Keyless' must have at least one @primaryKey property\./);
    expect(message).not.toMatch(/TypeSpec compiler v|superschema-tsp|\/var\/|Compiling|Found \d+ error/);
  }, 60_000);
});
