import { describe, it, expect, beforeEach } from "vitest";
import { MockCompilerService } from "@/lib/compiler/mock-compiler";
import type { SuperSchemaModel } from "@/types/super-schema-model";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModel(name = "TestEntity"): SuperSchemaModel {
  return {
    entity: {
      id: "e-1",
      name,
      domain: "test",
      domainId: "d-1",
      description: "Test entity",
      status: "DRAFT",
      version: 1,
      metadata: {},
    },
    fields: [],
    relationships: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MockCompilerService", () => {
  let service: MockCompilerService;

  beforeEach(() => {
    service = new MockCompilerService();
  });

  describe("compile", () => {
    it("returns success by default", async () => {
      const result = await service.compile("model Foo {}");

      expect(result.success).toBe(true);
      expect(result.diagnostics).toEqual([]);
      expect(result.generatedSource).toBe("model Foo {}");
    });

    it("records compile calls", async () => {
      await service.compile("model A {}");
      await service.compile("model B {}");

      expect(service.compileCalls).toEqual(["model A {}", "model B {}"]);
    });

    it("returns configured compile result", async () => {
      service.setConfig({
        compileResult: {
          success: false,
          diagnostics: [
            {
              message: "Syntax error",
              line: 1,
              column: 5,
              severity: "error",
            },
          ],
        },
      });

      const result = await service.compile("invalid");

      expect(result.success).toBe(false);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].message).toBe("Syntax error");
    });

    it("returns errors for matching error patterns", async () => {
      service.setConfig({
        errorPatterns: [
          {
            pattern: /INVALID/,
            diagnostics: [
              {
                message: "Found invalid keyword",
                line: 1,
                column: 1,
                severity: "error",
              },
            ],
          },
        ],
      });

      const successResult = await service.compile("model Valid {}");
      expect(successResult.success).toBe(true);

      const errorResult = await service.compile("model INVALID {}");
      expect(errorResult.success).toBe(false);
      expect(errorResult.diagnostics[0].message).toBe("Found invalid keyword");
    });
  });

  describe("emit", () => {
    it("returns default mock emit result", async () => {
      const result = await service.emit(makeModel("Foo"), "json-schema", []);

      expect(result.targetFormat).toBe("json-schema");
      expect(result.output).toContain("Mock json-schema output for Foo");
      expect(result.warnings).toEqual([]);
    });

    it("records emit calls", async () => {
      const model = makeModel();
      await service.emit(model, "json-schema", []);
      await service.emit(model, "protobuf", [{ sourceType: "string", targetType: "string", targetFormat: "protobuf", mappedType: "string", isOverride: false }]);

      expect(service.emitCalls).toHaveLength(2);
      expect(service.emitCalls[0].target).toBe("json-schema");
      expect(service.emitCalls[1].target).toBe("protobuf");
      expect(service.emitCalls[1].policies).toHaveLength(1);
    });

    it("returns configured emit result", async () => {
      service.setConfig({
        emitResult: {
          output: '{"type": "object"}',
          warnings: [{ message: "Missing description" }],
          targetFormat: "json-schema",
        },
      });

      const result = await service.emit(makeModel(), "json-schema", []);

      expect(result.output).toBe('{"type": "object"}');
      expect(result.warnings).toHaveLength(1);
    });
  });

  describe("validate", () => {
    it("returns valid by default", async () => {
      const result = await service.validate('{"type": "object"}', "json-schema");

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("records validate calls", async () => {
      await service.validate("output", "json-schema");

      expect(service.validateCalls).toHaveLength(1);
      expect(service.validateCalls[0].output).toBe("output");
      expect(service.validateCalls[0].targetFormat).toBe("json-schema");
    });

    it("returns configured validation result", async () => {
      service.setConfig({
        validateResult: {
          valid: false,
          errors: [{ message: "Invalid schema" }],
        },
      });

      const result = await service.validate("bad", "json-schema");

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
    });
  });

  describe("reset", () => {
    it("clears all recorded calls", async () => {
      await service.compile("model A {}");
      await service.emit(makeModel(), "json-schema", []);
      await service.validate("output", "json-schema");

      service.reset();

      expect(service.compileCalls).toHaveLength(0);
      expect(service.emitCalls).toHaveLength(0);
      expect(service.validateCalls).toHaveLength(0);
    });
  });

  describe("constructor config", () => {
    it("accepts config in constructor", async () => {
      const svc = new MockCompilerService({
        compileResult: {
          success: true,
          diagnostics: [],
          generatedSource: "// custom",
        },
      });

      const result = await svc.compile("anything");
      expect(result.generatedSource).toBe("// custom");
    });
  });
});
