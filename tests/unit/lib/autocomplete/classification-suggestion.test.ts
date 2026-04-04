import { describe, it, expect } from "vitest";
import { suggestClassification } from "@/lib/autocomplete/classification-suggestion";

describe("suggestClassification", () => {
  it("suggests PII for personal identifiers", () => {
    expect(suggestClassification("email")?.level).toBe("PII");
    expect(suggestClassification("phone")?.level).toBe("PII");
    expect(suggestClassification("ssn")?.level).toBe("PII");
    expect(suggestClassification("date_of_birth")?.level).toBe("PII");
    expect(suggestClassification("first_name")?.level).toBe("PII");
    expect(suggestClassification("name")?.level).toBe("PII");
  });

  it("suggests SENSITIVE for credentials", () => {
    expect(suggestClassification("password")?.level).toBe("SENSITIVE");
    expect(suggestClassification("api_key")?.level).toBe("SENSITIVE");
    expect(suggestClassification("token")?.level).toBe("SENSITIVE");
    expect(suggestClassification("secret")?.level).toBe("SENSITIVE");
    expect(suggestClassification("private_key")?.level).toBe("SENSITIVE");
  });

  it("suggests SENSITIVE for financial fields", () => {
    expect(suggestClassification("credit_card")?.level).toBe("SENSITIVE");
    expect(suggestClassification("salary")?.level).toBe("SENSITIVE");
    expect(suggestClassification("account_number")?.level).toBe("SENSITIVE");
    expect(suggestClassification("balance")?.level).toBe("SENSITIVE");
    expect(suggestClassification("amount")?.level).toBe("SENSITIVE");
  });

  it("includes a reason string", () => {
    const result = suggestClassification("email");
    expect(result).not.toBeNull();
    expect(result!.reason).toBeTruthy();
    expect(typeof result!.reason).toBe("string");
  });

  it("returns null for unrecognized names", () => {
    expect(suggestClassification("xyz")).toBeNull();
    expect(suggestClassification("")).toBeNull();
  });
});
