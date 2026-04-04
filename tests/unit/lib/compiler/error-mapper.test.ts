import { describe, it, expect } from "vitest";
import { mapDiagnosticsToFields } from "@/lib/compiler/error-mapper";
import type { CompilationDiagnostic } from "@/lib/compiler/types";
import type { SourceMapEntry } from "@/lib/compiler/typespec-generator";

describe("Error Mapper", () => {
  const sourceMap: SourceMapEntry[] = [
    { fieldName: "id", startLine: 3, endLine: 5 },
    { fieldName: "name", startLine: 6, endLine: 7 },
    { fieldName: "amount", startLine: 8, endLine: 9 },
  ];

  it("maps diagnostics to field names based on line numbers", () => {
    const diagnostics: CompilationDiagnostic[] = [
      { message: "Error on id", line: 4, column: 3, severity: "error" },
      { message: "Error on amount", line: 8, column: 5, severity: "error" },
    ];

    const mapped = mapDiagnosticsToFields(diagnostics, sourceMap);

    expect(mapped[0].fieldName).toBe("id");
    expect(mapped[1].fieldName).toBe("amount");
  });

  it("leaves fieldName undefined when line is not in source map", () => {
    const diagnostics: CompilationDiagnostic[] = [
      { message: "Error outside fields", line: 1, column: 1, severity: "error" },
    ];

    const mapped = mapDiagnosticsToFields(diagnostics, sourceMap);

    expect(mapped[0].fieldName).toBeUndefined();
  });

  it("preserves existing fieldName if already set", () => {
    const diagnostics: CompilationDiagnostic[] = [
      { message: "Error", line: 4, column: 3, severity: "error", fieldName: "customField" },
    ];

    const mapped = mapDiagnosticsToFields(diagnostics, sourceMap);

    expect(mapped[0].fieldName).toBe("customField");
  });

  it("generates suggestedFix for precision/scale errors", () => {
    const diagnostics: CompilationDiagnostic[] = [
      { message: "Missing precision and scale", line: 8, column: 3, severity: "error" },
    ];

    const mapped = mapDiagnosticsToFields(diagnostics, sourceMap);

    expect(mapped[0].suggestedFix).toBeDefined();
    expect(mapped[0].suggestedFix).toContain("precision");
    expect(mapped[0].suggestedFix).toContain("amount");
  });

  it("generates suggestedFix for duplicate property errors", () => {
    const diagnostics: CompilationDiagnostic[] = [
      { message: "duplicate property detected", line: 6, column: 3, severity: "error" },
    ];

    const mapped = mapDiagnosticsToFields(diagnostics, sourceMap);

    expect(mapped[0].suggestedFix).toContain("duplicate");
  });

  it("preserves existing suggestedFix if already set", () => {
    const diagnostics: CompilationDiagnostic[] = [
      {
        message: "Some error",
        line: 4,
        column: 3,
        severity: "error",
        suggestedFix: "My custom fix",
      },
    ];

    const mapped = mapDiagnosticsToFields(diagnostics, sourceMap);

    expect(mapped[0].suggestedFix).toBe("My custom fix");
  });

  it("returns undefined suggestedFix for unknown error patterns", () => {
    const diagnostics: CompilationDiagnostic[] = [
      { message: "Some completely unknown error XYZ", line: 1, column: 1, severity: "warning" },
    ];

    const mapped = mapDiagnosticsToFields(diagnostics, []);

    expect(mapped[0].suggestedFix).toBeUndefined();
  });
});
