import { describe, it, expect, beforeEach } from "vitest";
import { MockCompilerService } from "@/lib/compiler/mock-compiler";
import { compileEntity } from "@/lib/compiler/compiler.service";
import { generateTypeSpec, generateTypeSpecWithSourceMap } from "@/lib/compiler/typespec-generator";
import { mapDiagnosticsToFields } from "@/lib/compiler/error-mapper";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";
import type { CompilationDiagnostic } from "@/lib/compiler/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntity(overrides: Partial<PrismaEntityInput> = {}): PrismaEntityInput {
  return {
    id: "entity-1",
    name: "Customer",
    description: "A customer entity",
    status: "DRAFT",
    version: 1,
    domainId: "domain-1",
    metadata: {},
    domain: { id: "domain-1", name: "Sales", slug: "sales" },
    ...overrides,
  };
}

function makeField(overrides: Partial<PrismaFieldInput> = {}): PrismaFieldInput {
  return {
    id: "field-1",
    name: "firstName",
    type: "string",
    precision: null,
    scale: null,
    nullable: false,
    isKey: false,
    fieldNumber: null,
    description: "",
    classification: null,
    aliases: [],
    decorators: {},
    sortOrder: 0,
    ...overrides,
  };
}

/**
 * Simulates the compilation pipeline:
 * 1. compileEntity (Prisma -> IR)
 * 2. generateTypeSpec (IR -> TypeSpec source)
 * 3. ICompilerService.compile (TypeSpec source -> CompilationResult)
 */
async function runPipeline(
  entity: PrismaEntityInput,
  fields: PrismaFieldInput[],
  compiler: MockCompilerService
) {
  const model = compileEntity(entity, fields);
  const { source, sourceMap } = generateTypeSpecWithSourceMap(model);
  const result = await compiler.compile(source);

  if (!result.success) {
    const mappedDiagnostics = mapDiagnosticsToFields(result.diagnostics, sourceMap);
    return { success: false as const, source, diagnostics: mappedDiagnostics };
  }

  return { success: true as const, source, model };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Compilation Pipeline", () => {
  let compiler: MockCompilerService;

  beforeEach(() => {
    compiler = new MockCompilerService();
  });

  describe("success path", () => {
    it("compiles a valid entity with multiple fields successfully", async () => {
      const result = await runPipeline(
        makeEntity(),
        [
          makeField({ name: "id", type: "string", isKey: true, sortOrder: 0 }),
          makeField({ name: "name", type: "string", sortOrder: 1 }),
          makeField({ name: "age", type: "int32", nullable: true, sortOrder: 2 }),
          makeField({ name: "balance", type: "decimal", precision: 10, scale: 2, sortOrder: 3 }),
          makeField({ name: "isActive", type: "boolean", sortOrder: 4 }),
        ],
        compiler
      );

      expect(result.success).toBe(true);
      expect(result.source).toContain("model Customer");
      expect(compiler.compileCalls).toHaveLength(1);
    });

    it("generates valid TypeSpec source that is passed to the compiler", async () => {
      const result = await runPipeline(
        makeEntity(),
        [
          makeField({ name: "id", type: "string", isKey: true, sortOrder: 0 }),
          makeField({
            name: "email",
            type: "string",
            description: "User email",
            decorators: { typespec: { identity: { format: "email" } } },
            sortOrder: 1,
          }),
        ],
        compiler
      );

      expect(result.success).toBe(true);
      const source = compiler.compileCalls[0];
      expect(source).toContain("@key");
      expect(source).toContain('@format("email")');
      expect(source).toContain('@doc("User email")');
    });
  });

  describe("error path", () => {
    it("returns compilation errors with diagnostics", async () => {
      compiler.setConfig({
        errorPatterns: [
          {
            pattern: /model Customer/,
            diagnostics: [
              {
                message: 'unknown identifier "decimal"',
                line: 7,
                column: 5,
                severity: "error" as const,
              },
            ],
          },
        ],
      });

      const result = await runPipeline(
        makeEntity(),
        [
          makeField({ name: "id", type: "string", sortOrder: 0 }),
          makeField({ name: "amount", type: "decimal", sortOrder: 1 }),
        ],
        compiler
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0].message).toContain("decimal");
      }
    });

    it("maps errors to field names via source map", async () => {
      // First, generate the source to find the actual line numbers
      const model = compileEntity(makeEntity(), [
        makeField({ name: "id", type: "string", sortOrder: 0 }),
        makeField({ name: "amount", type: "decimal", sortOrder: 1 }),
      ]);
      const { sourceMap } = generateTypeSpecWithSourceMap(model);

      // Get the line range for "amount" field
      const amountEntry = sourceMap.find((e) => e.fieldName === "amount");
      expect(amountEntry).toBeDefined();

      compiler.setConfig({
        errorPatterns: [
          {
            pattern: /.*/,
            diagnostics: [
              {
                message: "precision and scale required for decimal type",
                line: amountEntry!.startLine,
                column: 3,
                severity: "error" as const,
              },
            ],
          },
        ],
      });

      const result = await runPipeline(
        makeEntity(),
        [
          makeField({ name: "id", type: "string", sortOrder: 0 }),
          makeField({ name: "amount", type: "decimal", sortOrder: 1 }),
        ],
        compiler
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.diagnostics[0].fieldName).toBe("amount");
      }
    });

    it("generates suggestedFix for known error patterns", async () => {
      const diagnostics: CompilationDiagnostic[] = [
        {
          message: "precision and scale required",
          line: 5,
          column: 3,
          severity: "error",
        },
      ];

      const model = compileEntity(makeEntity(), [
        makeField({ name: "amount", type: "decimal", sortOrder: 0 }),
      ]);
      const { sourceMap } = generateTypeSpecWithSourceMap(model);

      const mapped = mapDiagnosticsToFields(diagnostics, sourceMap);

      expect(mapped[0].suggestedFix).toBeDefined();
      expect(mapped[0].suggestedFix).toContain("precision");
      expect(mapped[0].suggestedFix).toContain("scale");
    });

    it("generates suggestedFix for unknown identifier errors", async () => {
      const diagnostics: CompilationDiagnostic[] = [
        {
          message: 'unknown identifier "Foobar"',
          line: 3,
          column: 10,
          severity: "error",
        },
      ];

      const mapped = mapDiagnosticsToFields(diagnostics, []);

      expect(mapped[0].suggestedFix).toContain("Foobar");
      expect(mapped[0].suggestedFix).toContain("not recognized");
    });

    it("generates suggestedFix for circular reference errors", async () => {
      const diagnostics: CompilationDiagnostic[] = [
        {
          message: "circular reference detected",
          line: 1,
          column: 1,
          severity: "error",
        },
      ];

      const mapped = mapDiagnosticsToFields(diagnostics, []);

      expect(mapped[0].suggestedFix).toContain("circular");
    });
  });

  describe("end-to-end pipeline scenarios", () => {
    it("handles an entity with enum fields", async () => {
      const result = await runPipeline(
        makeEntity(),
        [
          makeField({
            name: "status",
            type: "enum",
            aliases: ["ACTIVE", "INACTIVE"],
            sortOrder: 0,
          }),
        ],
        compiler
      );

      expect(result.success).toBe(true);
      expect(result.source).toContain("enum Customer_status");
    });

    it("handles an entity with array and map fields", async () => {
      const result = await runPipeline(
        makeEntity(),
        [
          makeField({
            name: "tags",
            type: "array",
            decorators: { arrayElementType: "string" },
            sortOrder: 0,
          }),
          makeField({
            name: "attrs",
            type: "map",
            decorators: { mapKeyType: "string", mapValueType: "string" },
            sortOrder: 1,
          }),
        ],
        compiler
      );

      expect(result.success).toBe(true);
      expect(result.source).toContain("string[]");
      expect(result.source).toContain("Record<string>");
    });

    it("handles an entity with reference fields", async () => {
      const result = await runPipeline(
        makeEntity(),
        [
          makeField({
            name: "order",
            type: "reference",
            nullable: true,
            decorators: { referencedEntityId: "e-2", referencedEntityName: "Order" },
            sortOrder: 0,
          }),
        ],
        compiler
      );

      expect(result.success).toBe(true);
      expect(result.source).toContain("order?: Order");
    });
  });
});
