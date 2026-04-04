/**
 * Error mapper — maps TypeSpec line/column errors back to field names
 * using the generator's source map, and generates suggestedFix strings.
 */

import type { CompilationDiagnostic } from "./types";
import type { SourceMapEntry } from "./typespec-generator";

// ---------------------------------------------------------------------------
// Map diagnostics to fields using source map
// ---------------------------------------------------------------------------

export function mapDiagnosticsToFields(
  diagnostics: CompilationDiagnostic[],
  sourceMap: SourceMapEntry[]
): CompilationDiagnostic[] {
  return diagnostics.map((d) => {
    const entry = findFieldForLine(d.line, sourceMap);
    const suggestedFix = d.suggestedFix ?? generateSuggestedFix(d.message, entry?.fieldName);

    return {
      ...d,
      fieldName: d.fieldName ?? entry?.fieldName,
      suggestedFix,
    };
  });
}

function findFieldForLine(
  line: number,
  sourceMap: SourceMapEntry[]
): SourceMapEntry | undefined {
  return sourceMap.find(
    (entry) => line >= entry.startLine && line <= entry.endLine
  );
}

// ---------------------------------------------------------------------------
// Suggested fix generation for common errors
// ---------------------------------------------------------------------------

const KNOWN_ERROR_PATTERNS: Array<{
  pattern: RegExp;
  fix: (match: RegExpMatchArray, fieldName?: string) => string;
}> = [
  {
    pattern: /precision.*scale|scale.*precision/i,
    fix: (_m, fieldName) =>
      `Add precision and scale to decimal field${fieldName ? ` '${fieldName}'` : ""}`,
  },
  {
    pattern: /unknown\s+identifier\s+"(\w+)"/i,
    fix: (m) => `'${m[1]}' is not recognized. Check the spelling or define it first.`,
  },
  {
    pattern: /duplicate.*property|property.*already.*defined/i,
    fix: (_m, fieldName) =>
      `Remove the duplicate property${fieldName ? ` '${fieldName}'` : ""}`,
  },
  {
    pattern: /expected\s+"[;{}]"/i,
    fix: () => "Check for missing semicolons or braces in the generated TypeSpec",
  },
  {
    pattern: /type.*not\s+assignable/i,
    fix: (_m, fieldName) =>
      `Check the type assignment for field${fieldName ? ` '${fieldName}'` : ""}`,
  },
  {
    pattern: /circular/i,
    fix: () =>
      "Break the circular reference by using a string ID instead of a direct model reference",
  },
];

function generateSuggestedFix(
  message: string,
  fieldName?: string
): string | undefined {
  for (const { pattern, fix } of KNOWN_ERROR_PATTERNS) {
    const match = message.match(pattern);
    if (match) {
      return fix(match, fieldName);
    }
  }
  return undefined;
}
