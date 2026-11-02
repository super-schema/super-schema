import type { AuditExportEntry, ComplianceFieldResult, ComplianceFilter, ComplianceGap } from "@/types/schemas/compliance";
import { MAX_EXPORT_ROWS } from "@/types/schemas/compliance";

/*
 * The exports of the compliance pages. Every CSV goes through `toCsv` (one writer) and every file through `downloadFile` (one download).
 */

const FIELD_HEADERS = ["Entity", "Field", "Type", "Classification", "Retention", "Anonymization", "Encryption", "Targets", "Domain"];
const GAP_HEADERS = ["Entity Name", "Field Name", "Gap Type", "Severity", "Suggested Fix"];
const AUDIT_HEADERS = ["Timestamp", "User", "Action", "Entity Type", "Entity ID", "Change Summary"];

const CSV_TYPE = "text/csv;charset=utf-8;";
const JSON_TYPE = "application/json";

type Cell = string | null | undefined;

/**
 * The one CSV writer of the compliance exports: the header row as given, then one line per row with every value quoted (its quotes doubled), so
 * that a value with a comma or a line break stays one cell.
 */
export function toCsv(headers: readonly string[], rows: readonly (readonly Cell[])[]): string {
  const line = (cells: readonly Cell[]) => cells.map((value) => `"${(value ?? "").replace(/"/g, '""')}"`).join(",");
  return [headers.join(","), ...rows.map(line)].join("\n");
}

export function fieldRowsCsv(fields: readonly ComplianceFieldResult[]): string {
  return toCsv(
    FIELD_HEADERS,
    fields.map((f) => [
      f.entityName,
      f.fieldName,
      f.fieldType,
      f.classification,
      f.retention,
      f.anonymization,
      f.encryption,
      (f.targetSystems ?? []).join("; "),
      f.domain,
    ])
  );
}

export function gapRowsCsv(gaps: readonly ComplianceGap[]): string {
  return toCsv(GAP_HEADERS, gaps.map((g) => [g.entityName, g.fieldName, g.gapType, g.severity, g.suggestedFix]));
}

export function auditRowsCsv(entries: readonly AuditExportEntry[]): string {
  return toCsv(
    AUDIT_HEADERS,
    entries.map((e) => [new Date(e.timestamp).toISOString(), e.userName, e.action, e.entityType, e.entityId, e.changeSummary])
  );
}

/** The file name of a report: its date, and the filters that narrow it, so that the name says what the file holds. */
export function generateReportFilename(filters: ComplianceFilter, ext: "csv" | "json"): string {
  const date = new Date().toISOString().split("T")[0];
  const filterParts = [
    ...(filters.classifications || []),
    filters.retention && filters.retention !== "any" ? filters.retention : null,
    filters.anonymization && filters.anonymization !== "any" ? filters.anonymization : null,
  ].filter(Boolean);
  const filterSuffix = filterParts.length > 0 ? `-${filterParts.join("-").toLowerCase()}` : "";
  return `compliance-report-${date}${filterSuffix}.${ext}`;
}

export function generateCsvFilename(filters: ComplianceFilter): string {
  return generateReportFilename(filters, "csv");
}

/** Save `content` as a file: the one download the compliance pages make. */
export function downloadFile(filename: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** What a cut-short export says: how many were made of how many matched, and how to get the rest (`what`: "matching fields", ...). */
export function exportLimitNotice(total: number, what: string): string {
  return `Only the first ${MAX_EXPORT_ROWS.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} ${what} were exported. Narrow the filters to export the rest.`;
}

/** The Query tab's CSV: the fields as the export returned them (every match, not the page on the screen). */
export function exportToCsv(fields: readonly ComplianceFieldResult[], filters: ComplianceFilter): void {
  downloadFile(generateCsvFilename(filters), fieldRowsCsv(fields), CSV_TYPE);
}

export function exportFieldsToJson(fields: readonly ComplianceFieldResult[], filters: ComplianceFilter): void {
  downloadFile(generateReportFilename(filters, "json"), JSON.stringify(fields, null, 2), JSON_TYPE);
}

/** The Gaps tab's CSV: the gaps the tab holds (it reads every gap of the tenant at once, so they are all of them). */
export function exportGapsToCsv(gaps: readonly ComplianceGap[], filters: ComplianceFilter): void {
  downloadFile(generateReportFilename(filters, "csv"), gapRowsCsv(gaps), CSV_TYPE);
}

export function exportGapsToJson(gaps: readonly ComplianceGap[], filters: ComplianceFilter): void {
  downloadFile(generateReportFilename(filters, "json"), JSON.stringify(gaps, null, 2), JSON_TYPE);
}

/** The Audit Trail's CSV: the entries as the export returned them. */
export function exportAuditTrailToCsv(entries: readonly AuditExportEntry[], today: Date = new Date()): void {
  downloadFile(`audit-trail-${today.toISOString().split("T")[0]}.csv`, auditRowsCsv(entries), CSV_TYPE);
}

/** The CSV of the fields, the header row included (the content of `exportToCsv`, for the tests and the callers that want the text). */
export function generateCsvContent(fields: readonly ComplianceFieldResult[]): string {
  return fieldRowsCsv(fields);
}
