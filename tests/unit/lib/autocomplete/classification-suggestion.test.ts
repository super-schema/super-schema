import { describe, it, expect } from "vitest";
import { suggestClassification } from "@/lib/autocomplete/classification-suggestion";

describe("suggestClassification", () => {
  it("suggests PII for personal identifiers", () => {
    expect(suggestClassification("email")).toBe("PII");
    expect(suggestClassification("phone")).toBe("PII");
    expect(suggestClassification("ssn")).toBe("PII");
    expect(suggestClassification("date_of_birth")).toBe("PII");
    expect(suggestClassification("first_name")).toBe("PII");
  });

  it("suggests SENSITIVE for credentials and financial", () => {
    expect(suggestClassification("password")).toBe("SENSITIVE");
    expect(suggestClassification("api_key")).toBe("SENSITIVE");
    expect(suggestClassification("credit_card")).toBe("SENSITIVE");
    expect(suggestClassification("salary")).toBe("SENSITIVE");
  });

  it("suggests INTERNAL for system fields", () => {
    expect(suggestClassification("id")).toBe("INTERNAL");
    expect(suggestClassification("created_at")).toBe("INTERNAL");
    expect(suggestClassification("tenant_id")).toBe("INTERNAL");
  });

  it("suggests PUBLIC for product/content fields", () => {
    expect(suggestClassification("product_name")).toBe("PUBLIC");
    expect(suggestClassification("description")).toBe("PUBLIC");
    expect(suggestClassification("country")).toBe("PUBLIC");
  });

  it("returns null for unrecognized names", () => {
    expect(suggestClassification("xyz")).toBeNull();
    expect(suggestClassification("")).toBeNull();
  });
});
