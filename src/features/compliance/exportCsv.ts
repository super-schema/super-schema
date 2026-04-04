import type { ComplianceFieldResult, ComplianceFilter } from "@/types/schemas/compliance";

/**
 * Generate and download a CSV file from compliance field results.
 */
export function exportToCsv(
  fields: ComplianceFieldResult[],
  filters: ComplianceFilter
): void {
  const headers = [
    "Entity",
    "Field",
    "Type",
    "Classification",
    "Retention",
    "Anonymization",
    "Encryption",
    "Targets",
    "Domain",
  ];

  const rows = fields.map((f) => [
    f.entityName,
    f.fieldName,
    f.fieldType,
    f.classification || "",
    f.retention || "",
    f.anonymization || "",
    f.encryption || "",
    (f.targetSystems || []).join("; "),
    f.domain,
  ]);

  const csv = [
    headers.join(","),
    ...rows.map((r) =>
      r.map((v) => `"${(v || "").replace(/"/g, '""')}"`).join(",")
    ),
  ].join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = generateCsvFilename(filters);
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Generate CSV content as a string (for testing).
 */
export function generateCsvContent(
  fields: ComplianceFieldResult[],
  includeGapType?: boolean
): string {
  const headers = [
    "Entity",
    "Field",
    "Type",
    "Classification",
    "Retention",
    "Anonymization",
    "Encryption",
    "Targets",
    "Domain",
  ];

  if (includeGapType) {
    headers.push("Gap Type");
  }

  const rows = fields.map((f) => {
    const row = [
      f.entityName,
      f.fieldName,
      f.fieldType,
      f.classification || "",
      f.retention || "",
      f.anonymization || "",
      f.encryption || "",
      (f.targetSystems || []).join("; "),
      f.domain,
    ];
    return row;
  });

  return [
    headers.join(","),
    ...rows.map((r) =>
      r.map((v) => `"${(v || "").replace(/"/g, '""')}"`).join(",")
    ),
  ].join("\n");
}

export function generateCsvFilename(filters: ComplianceFilter): string {
  const date = new Date().toISOString().split("T")[0];
  const parts = [
    ...(filters.classifications || []),
    filters.retention && filters.retention !== "any" ? filters.retention : null,
    filters.anonymization && filters.anonymization !== "any"
      ? filters.anonymization
      : null,
  ].filter(Boolean);
  const suffix =
    parts.length > 0 ? `-${parts.join("-").toLowerCase()}` : "";
  return `compliance-report-${date}${suffix}.csv`;
}
