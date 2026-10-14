import type { Diagnostic, DiagnosticSeverity } from "./types";

/** Locale-independent string order (UTF-16 code units) — keeps output stable across machines. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function diagnostic(severity: DiagnosticSeverity, code: string, message: string, pointer: string): Diagnostic {
  return { severity, code, message, pointer };
}

const SEVERITY_RANK: Record<DiagnosticSeverity, number> = { error: 0, warning: 1, info: 2 };

/** De-duplicate and order diagnostics: severity, then pointer, then code, then message. */
export function normalizeDiagnostics(list: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const unique: Diagnostic[] = [];
  for (const d of list) {
    const id = `${d.severity}\u0000${d.code}\u0000${d.pointer}\u0000${d.message}`;
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(d);
  }
  return unique.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      compareStrings(a.pointer, b.pointer) ||
      compareStrings(a.code, b.code) ||
      compareStrings(a.message, b.message),
  );
}

export function hasErrors(list: Diagnostic[]): boolean {
  return list.some((d) => d.severity === "error");
}
