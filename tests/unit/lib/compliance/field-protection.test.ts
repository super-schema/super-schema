import { describe, expect, it } from "vitest";
import { fieldProtection, isMethod, parseRetentionToYears } from "@/lib/compliance/field-protection";

const PERIOD_2_YEARS = { strategy: "age-based", period: 2, periodUnit: "years", referenceField: "created_at", action: "delete" };

describe("fieldProtection: anonymization and encryption", () => {
  it("reads the values the Data Protection section of the Governance panel writes (decorators.typespec.governance)", () => {
    const decorators = { typespec: { governance: { anonymization: "hash", encryption: "AES-256" } } };
    expect(fieldProtection(decorators, null)).toMatchObject({ anonymization: "hash", encryption: "AES-256" });
  });

  it("a key the panel wrote as none (null) is none, even where an old legacy key says otherwise", () => {
    const decorators = { typespec: { governance: { anonymization: null, encryption: null } }, policy: { anonymization: "mask", encryption: "AES-256" } };
    expect(fieldProtection(decorators, null)).toMatchObject({ anonymization: null, encryption: null });
  });

  it("a row that never had the new keys keeps its values under the legacy decorators.policy, read as a fallback", () => {
    expect(fieldProtection({ policy: { anonymization: "mask", encryption: "field-level" } }, null)).toMatchObject({
      anonymization: "mask",
      encryption: "field-level",
    });
  });

  it("an empty value is no value", () => {
    expect(fieldProtection({ typespec: { governance: { anonymization: "  " } } }, null).anonymization).toBeNull();
  });

  it("reads the @anonymization of a TypeSpec source, which the sync writes to decorators.governance (root)", () => {
    expect(fieldProtection({ governance: { anonymization: "hash" } }, null).anonymization).toBe("hash");
  });

  it("the panel's key answers before the source's, even as null (the panel's None)", () => {
    expect(fieldProtection({ typespec: { governance: { anonymization: "mask" } }, governance: { anonymization: "hash" } }, null).anonymization).toBe("mask");
    expect(fieldProtection({ typespec: { governance: { anonymization: null } }, governance: { anonymization: "hash" } }, null).anonymization).toBeNull();
  });

  it("without the panel's key, the source's answers before the legacy key", () => {
    expect(fieldProtection({ governance: { anonymization: "hash" }, policy: { anonymization: "mask" } }, null).anonymization).toBe("hash");
    expect(fieldProtection({ governance: {}, policy: { anonymization: "mask" } }, null).anonymization).toBe("mask");
  });

  it("encryption comes from the panel and the legacy key only: a root governance encryption is not read (the source has no such decorator)", () => {
    expect(fieldProtection({ governance: { encryption: "AES-256" } }, null).encryption).toBeNull();
  });

  it("nothing stored gives no values", () => {
    expect(fieldProtection({}, null)).toEqual({ retention: null, retentionYears: null, anonymization: null, encryption: null });
    expect(fieldProtection(null, undefined)).toEqual({ retention: null, retentionYears: null, anonymization: null, encryption: null });
  });
});

describe("fieldProtection: retention lives on the entity", () => {
  it("reads the entity's structured retention policy as its summary and its years", () => {
    expect(fieldProtection({}, { retentionPolicy: PERIOD_2_YEARS })).toMatchObject({
      retention: "Delete after 2 years (created_at)",
      retentionYears: 2,
    });
  });

  it("years for months and days follow the schema's conversion", () => {
    expect(fieldProtection({}, { retentionPolicy: { ...PERIOD_2_YEARS, period: 6, periodUnit: "months" } }).retentionYears).toBe(0.5);
    expect(fieldProtection({}, { retentionPolicy: { ...PERIOD_2_YEARS, period: 90, periodUnit: "days" } }).retentionYears).toBeCloseTo(0.2466, 3);
  });

  it("the entity's policy wins over a legacy value on the field", () => {
    const protection = fieldProtection({ policy: { retention: "10 years" } }, { retentionPolicy: PERIOD_2_YEARS });
    expect(protection).toMatchObject({ retention: "Delete after 2 years (created_at)", retentionYears: 2 });
  });

  it("a legacy string stored on the entity is migrated the way the retention page reads it", () => {
    expect(fieldProtection({}, { retentionPolicy: "7y" })).toMatchObject({ retention: "Delete after 7 years (created_at)", retentionYears: 7 });
  });

  it("an indefinite retention is a retention with no years, so no range matches it", () => {
    expect(fieldProtection({}, { retentionPolicy: { strategy: "indefinite", action: "notify-only" } })).toMatchObject({
      retention: "Retain indefinitely",
      retentionYears: null,
    });
  });

  it("a stored policy that is not a valid one is not read: the legacy field value answers", () => {
    expect(fieldProtection({ policy: { retention: "3 years" } }, { retentionPolicy: { strategy: "nonsense" } })).toMatchObject({
      retention: "3 years",
      retentionYears: 3,
    });
  });

  it("a field of an entity with no policy keeps the legacy field retention, read as a fallback", () => {
    expect(fieldProtection({ policy: { retention: "3 years" } }, { name: "Customer" })).toMatchObject({ retention: "3 years", retentionYears: 3 });
  });

  it("a stored retention text no duration reads is shown as written, not as 'Retain indefinitely' (it is not a period, so no range matches it)", () => {
    expect(fieldProtection({}, { retentionPolicy: "Keep 5 years" })).toMatchObject({ retention: "Keep 5 years", retentionYears: null });
  });

  it("a structured indefinite policy keeps the retention page's summary", () => {
    expect(fieldProtection({}, { retentionPolicy: { strategy: "indefinite", action: "notify-only" } }).retention).toBe("Retain indefinitely");
  });

  it("a @retentionPolicy declared in the TypeSpec source is not read: retention is the entity's", () => {
    expect(fieldProtection({ governance: { retentionPolicy: "3 years" } }, { name: "Customer" })).toMatchObject({ retention: null, retentionYears: null });
  });
});

describe("isMethod: compliance enum values", () => {
  it("compares case and punctuation alike: AES-256 is aes256", () => {
    expect(isMethod("AES256", "AES-256")).toBe(true);
    expect(isMethod("aes-256", "AES-256")).toBe(true);
    expect(isMethod("field-level", "AES-256")).toBe(false);
  });

  it("none is the same as no value and as the value none", () => {
    expect(isMethod(null, "none")).toBe(true);
    expect(isMethod("none", "none")).toBe(true);
    expect(isMethod("None", "none")).toBe(true);
    expect(isMethod("hash", "none")).toBe(false);
  });

  it("no value matches no method", () => {
    expect(isMethod(null, "hash")).toBe(false);
  });
});

describe("parseRetentionToYears", () => {
  it("reads the legacy strings and the structured object", () => {
    expect(parseRetentionToYears("3 years")).toBe(3);
    expect(parseRetentionToYears("30d")).toBeCloseTo(0.0822, 3);
    expect(parseRetentionToYears({ strategy: "age-based", period: 4, periodUnit: "years", action: "delete" })).toBe(4);
    expect(parseRetentionToYears("forever")).toBeNull();
  });
});
