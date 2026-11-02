import { describe, it, expect } from "vitest";
import {
  generateCsvContent,
  generateCsvFilename,
  toCsv,
} from "@/features/compliance/exportCsv";
import { computeDiff } from "@/features/compliance/AuditDiffViewer";
import type { ComplianceFieldResult } from "@/types/schemas/compliance";

const MOCK_FIELDS: ComplianceFieldResult[] = [
  {
    entityId: "ent-1",
    entityName: "Customer",
    fieldId: "fld-1",
    fieldName: "email",
    fieldType: "string",
    classification: "PII",
    retention: "3 years",
    anonymization: "hash",
    encryption: "AES-256",
    targetSystems: ["BigQuery", "Avro"],
    domain: "Commerce",
    domainId: "dom-1",
    domainSlug: "commerce",
    productSlug: "orders",
  },
  {
    entityId: "ent-1",
    entityName: "Customer",
    fieldId: "fld-2",
    fieldName: "name",
    fieldType: "string",
    classification: "PII",
    retention: "3 years",
    anonymization: "mask",
    encryption: null,
    targetSystems: [],
    domain: "Commerce",
    domainId: "dom-1",
    domainSlug: "commerce",
    productSlug: "orders",
  },
  {
    entityId: "ent-2",
    entityName: "Order",
    fieldId: "fld-3",
    fieldName: "status",
    fieldType: "enum",
    classification: "INTERNAL",
    retention: null,
    anonymization: null,
    encryption: null,
    targetSystems: ["OpenAPI"],
    domain: "Commerce",
    domainId: "dom-1",
    domainSlug: "commerce",
    productSlug: "orders",
  },
];

describe("Compliance Export", () => {
  describe("toCsv: the one CSV writer", () => {
    it("writes the header row as given and every value quoted", () => {
      expect(toCsv(["A", "B"], [["x", "y"]])).toBe('A,B\n"x","y"');
    });

    it("doubles the quotes in a value, and keeps a comma or a line break inside its cell", () => {
      expect(toCsv(["A"], [['say "hi", then\nbye']])).toBe('A\n"say ""hi"", then\nbye"');
    });

    it("writes a missing value as an empty cell", () => {
      expect(toCsv(["A", "B", "C"], [["x", null, undefined]])).toBe('A,B,C\n"x","",""');
    });
  });

  describe("generateCsvContent", () => {
    it("includes correct headers", () => {
      const csv = generateCsvContent(MOCK_FIELDS);
      const headerLine = csv.split("\n")[0];
      expect(headerLine).toContain("Entity");
      expect(headerLine).toContain("Field");
      expect(headerLine).toContain("Type");
      expect(headerLine).toContain("Classification");
      expect(headerLine).toContain("Retention");
      expect(headerLine).toContain("Anonymization");
      expect(headerLine).toContain("Encryption");
      expect(headerLine).toContain("Targets");
      expect(headerLine).toContain("Domain");
    });

    it("includes all field data", () => {
      const csv = generateCsvContent(MOCK_FIELDS);
      const lines = csv.split("\n");

      // Header + 3 data rows
      expect(lines).toHaveLength(4);

      // Check first data row contains Customer data
      expect(lines[1]).toContain("Customer");
      expect(lines[1]).toContain("email");
      expect(lines[1]).toContain("PII");
      expect(lines[1]).toContain("3 years");
      expect(lines[1]).toContain("hash");
      expect(lines[1]).toContain("AES-256");
    });

    it("includes all results regardless of pagination", () => {
      const csv = generateCsvContent(MOCK_FIELDS);
      const dataLines = csv.split("\n").slice(1);
      expect(dataLines).toHaveLength(3);
    });

    it("handles null values as empty strings", () => {
      const csv = generateCsvContent(MOCK_FIELDS);
      const lines = csv.split("\n");
      // Third row (Order/status) has null retention/anonymization/encryption
      expect(lines[3]).toContain('""');
    });

    it("joins target systems with semicolons", () => {
      const csv = generateCsvContent(MOCK_FIELDS);
      const lines = csv.split("\n");
      expect(lines[1]).toContain("BigQuery; Avro");
    });

    it("escapes quotes in values", () => {
      const fieldWithQuote: ComplianceFieldResult = {
        ...MOCK_FIELDS[0],
        fieldName: 'field"name',
      };
      const csv = generateCsvContent([fieldWithQuote]);
      expect(csv).toContain('field""name');
    });
  });

  describe("generateCsvFilename", () => {
    it("includes date in filename", () => {
      const filename = generateCsvFilename({});
      const datePattern = /compliance-report-\d{4}-\d{2}-\d{2}\.csv/;
      expect(filename).toMatch(datePattern);
    });

    it("includes filter values in filename when filters active", () => {
      const filename = generateCsvFilename({
        classifications: ["PII", "SENSITIVE"],
      });
      expect(filename).toContain("pii");
      expect(filename).toContain("sensitive");
      expect(filename.endsWith(".csv")).toBe(true);
    });

    it("excludes 'any' retention from filename", () => {
      const filename = generateCsvFilename({ retention: "any" });
      expect(filename).not.toContain("any");
    });

    it("includes non-any retention in filename", () => {
      const filename = generateCsvFilename({
        retention: "lt_1_year",
      });
      expect(filename).toContain("lt_1_year");
    });
  });
});

describe("AuditDiffViewer — computeDiff", () => {
  it("detects added properties", () => {
    const diffs = computeDiff({}, { name: "test" });
    expect(diffs).toHaveLength(1);
    expect(diffs[0].type).toBe("added");
    expect(diffs[0].key).toBe("name");
    expect(diffs[0].after).toBe("test");
  });

  it("detects removed properties", () => {
    const diffs = computeDiff({ name: "test" }, {});
    expect(diffs).toHaveLength(1);
    expect(diffs[0].type).toBe("removed");
    expect(diffs[0].key).toBe("name");
    expect(diffs[0].before).toBe("test");
  });

  it("detects changed properties", () => {
    const diffs = computeDiff(
      { name: "old", type: "string" },
      { name: "new", type: "string" }
    );
    const changed = diffs.filter((d) => d.type === "changed");
    expect(changed).toHaveLength(1);
    expect(changed[0].key).toBe("name");
    expect(changed[0].before).toBe("old");
    expect(changed[0].after).toBe("new");
  });

  it("detects unchanged properties", () => {
    const diffs = computeDiff(
      { name: "same", type: "string" },
      { name: "same", type: "string" }
    );
    expect(diffs).toHaveLength(2);
    expect(diffs.every((d) => d.type === "unchanged")).toBe(true);
  });

  it("handles mixed changes", () => {
    const diffs = computeDiff(
      { name: "old", removed: "value" },
      { name: "new", added: "value" }
    );
    const types = diffs.map((d) => d.type).sort();
    expect(types).toEqual(["added", "changed", "removed"]);
  });

  it("handles empty objects", () => {
    const diffs = computeDiff({}, {});
    expect(diffs).toHaveLength(0);
  });

  it("handles complex nested values", () => {
    const diffs = computeDiff(
      { config: { a: 1, b: 2 } },
      { config: { a: 1, b: 3 } }
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0].type).toBe("changed");
  });
});
