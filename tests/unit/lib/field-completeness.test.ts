import { describe, it, expect } from "vitest";
import {
  getFieldCompleteness,
  getEntityCompleteness,
  canEmit,
} from "@/lib/validation/field-completeness";

describe("getFieldCompleteness", () => {
  it("returns complete when name, type, and classification are set", () => {
    const result = getFieldCompleteness({
      name: "email",
      type: "string",
      classification: "PII",
      precision: null,
      scale: null,
    });
    expect(result.status).toBe("complete");
    expect(result.missing).toEqual([]);
  });

  it("returns error when name is missing", () => {
    const result = getFieldCompleteness({
      name: "",
      type: "string",
      classification: "PII",
      precision: null,
      scale: null,
    });
    expect(result.status).toBe("error");
    expect(result.missing).toContain("name");
  });

  it("returns error when type is missing", () => {
    const result = getFieldCompleteness({
      name: "email",
      type: "",
      classification: "PII",
      precision: null,
      scale: null,
    });
    expect(result.status).toBe("error");
    expect(result.missing).toContain("type");
  });

  it("returns suggestion when classification is missing (defaults to SENSITIVE)", () => {
    const result = getFieldCompleteness({
      name: "email",
      type: "string",
      classification: null,
      precision: null,
      scale: null,
    });
    expect(result.status).toBe("suggestion");
    expect(result.suggestions).toContain("classification (defaults to SENSITIVE)");
  });

  it("returns error for decimal without precision and scale", () => {
    const result = getFieldCompleteness({
      name: "amount",
      type: "decimal",
      classification: "SENSITIVE",
      precision: null,
      scale: null,
    });
    expect(result.status).toBe("error");
    expect(result.missing).toContain("precision");
    expect(result.missing).toContain("scale");
  });

  it("returns complete for decimal with precision and scale", () => {
    const result = getFieldCompleteness({
      name: "amount",
      type: "decimal",
      classification: "SENSITIVE",
      precision: 10,
      scale: 2,
    });
    expect(result.status).toBe("complete");
  });

  it("returns error with multiple missing fields", () => {
    const result = getFieldCompleteness({
      name: "",
      type: "",
      classification: null,
      precision: null,
      scale: null,
    });
    expect(result.status).toBe("error");
    expect(result.missing).toEqual(["name", "type"]);
    expect(result.suggestions).toContain("classification (defaults to SENSITIVE)");
  });
});

describe("getEntityCompleteness", () => {
  it("returns 0% for empty fields array", () => {
    const result = getEntityCompleteness([]);
    expect(result.percentage).toBe(0);
    expect(result.total).toBe(0);
  });

  it("returns 100% when all fields are complete", () => {
    const fields = [
      { name: "id", type: "string", classification: "INTERNAL", precision: null, scale: null },
      { name: "email", type: "string", classification: "PII", precision: null, scale: null },
    ];
    const result = getEntityCompleteness(fields);
    expect(result.percentage).toBe(100);
    expect(result.complete).toBe(2);
  });

  it("returns 50% when half the fields are complete", () => {
    const fields = [
      { name: "id", type: "string", classification: "INTERNAL", precision: null, scale: null },
      { name: "email", type: "string", classification: null, precision: null, scale: null },
    ];
    const result = getEntityCompleteness(fields);
    expect(result.percentage).toBe(50);
    expect(result.complete).toBe(1);
  });
});

describe("canEmit", () => {
  it("allows emission when all fields are complete", () => {
    const fields = [
      { name: "id", type: "string", classification: "INTERNAL", precision: null, scale: null },
    ];
    expect(canEmit(fields).allowed).toBe(true);
  });

  it("blocks emission when any field has errors", () => {
    const fields = [
      { name: "id", type: "string", classification: "INTERNAL", precision: null, scale: null },
      { name: "", type: "", classification: null, precision: null, scale: null },
    ];
    const result = canEmit(fields);
    expect(result.allowed).toBe(false);
    expect(result.incompleteCount).toBe(1);
  });

  it("blocks emission when no fields exist", () => {
    expect(canEmit([]).allowed).toBe(false);
  });
});
