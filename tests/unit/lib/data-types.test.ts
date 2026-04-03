import { describe, it, expect } from "vitest";
import {
  DATA_TYPE_HIERARCHY,
  ALL_DATA_TYPES,
  getTypesByCategory,
  getTypeInfo,
  isDecimalType,
} from "@/lib/data-types";

describe("DATA_TYPE_HIERARCHY", () => {
  it("contains all expected categories", () => {
    const categories = [...new Set(DATA_TYPE_HIERARCHY.map((t) => t.category))];
    expect(categories).toContain("Number");
    expect(categories).toContain("String");
    expect(categories).toContain("Boolean");
    expect(categories).toContain("Bytes");
    expect(categories).toContain("Date & Time");
    expect(categories).toContain("Structured");
    expect(categories).toContain("Special");
  });

  it("has unique IDs for all types", () => {
    const ids = DATA_TYPE_HIERARCHY.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("maps parent references to existing types", () => {
    for (const type of DATA_TYPE_HIERARCHY) {
      if (type.parent) {
        const parent = DATA_TYPE_HIERARCHY.find((t) => t.id === type.parent);
        expect(parent, `Parent "${type.parent}" of "${type.id}" not found`).toBeDefined();
      }
    }
  });

  it("includes TypeSpec scalar names for all types", () => {
    for (const type of DATA_TYPE_HIERARCHY) {
      expect(type.typespecScalar).toBeTruthy();
    }
  });

  it("includes integer subtypes", () => {
    const integerChildren = DATA_TYPE_HIERARCHY.filter((t) => t.parent === "integer");
    const ids = integerChildren.map((t) => t.id);
    expect(ids).toContain("int8");
    expect(ids).toContain("int16");
    expect(ids).toContain("int32");
    expect(ids).toContain("int64");
    expect(ids).toContain("safeint");
    expect(ids).toContain("uint8");
    expect(ids).toContain("uint16");
    expect(ids).toContain("uint32");
    expect(ids).toContain("uint64");
  });

  it("includes float subtypes", () => {
    const floatChildren = DATA_TYPE_HIERARCHY.filter((t) => t.parent === "float");
    const ids = floatChildren.map((t) => t.id);
    expect(ids).toContain("float32");
    expect(ids).toContain("float64");
  });
});

describe("ALL_DATA_TYPES", () => {
  it("is a flat array of all type IDs", () => {
    expect(ALL_DATA_TYPES.length).toBe(DATA_TYPE_HIERARCHY.length);
    for (const type of DATA_TYPE_HIERARCHY) {
      expect(ALL_DATA_TYPES).toContain(type.id);
    }
  });
});

describe("getTypesByCategory", () => {
  it("returns all categories in order", () => {
    const result = getTypesByCategory();
    const categoryNames = result.map((c) => c.category);
    expect(categoryNames).toEqual([
      "Number",
      "String",
      "Boolean",
      "Bytes",
      "Date & Time",
      "Structured",
      "Special",
    ]);
  });

  it("groups types correctly under Number", () => {
    const result = getTypesByCategory();
    const numberGroup = result.find((c) => c.category === "Number")!;
    const ids = numberGroup.types.map((t) => t.id);
    expect(ids).toContain("numeric");
    expect(ids).toContain("integer");
    expect(ids).toContain("int32");
    expect(ids).toContain("float64");
    expect(ids).toContain("decimal");
    expect(ids).toContain("decimal128");
  });

  it("groups date types under Date & Time", () => {
    const result = getTypesByCategory();
    const dateGroup = result.find((c) => c.category === "Date & Time")!;
    const ids = dateGroup.types.map((t) => t.id);
    expect(ids).toContain("plainDate");
    expect(ids).toContain("plainTime");
    expect(ids).toContain("utcDateTime");
    expect(ids).toContain("offsetDateTime");
    expect(ids).toContain("duration");
    expect(ids).toContain("unixTimestamp32");
  });
});

describe("getTypeInfo", () => {
  it("returns type info for valid ID", () => {
    const info = getTypeInfo("int32");
    expect(info).toBeDefined();
    expect(info!.label).toBe("int32");
    expect(info!.typespecScalar).toBe("int32");
    expect(info!.category).toBe("Number");
    expect(info!.parent).toBe("integer");
  });

  it("returns undefined for unknown ID", () => {
    expect(getTypeInfo("nonexistent")).toBeUndefined();
  });

  it("returns decimal info with precision/scale requirements", () => {
    const info = getTypeInfo("decimal");
    expect(info!.requiresPrecision).toBe(true);
    expect(info!.requiresScale).toBe(true);
  });

  it("returns decimal128 info with precision/scale requirements", () => {
    const info = getTypeInfo("decimal128");
    expect(info!.requiresPrecision).toBe(true);
    expect(info!.requiresScale).toBe(true);
  });
});

describe("isDecimalType", () => {
  it("returns true for decimal", () => {
    expect(isDecimalType("decimal")).toBe(true);
  });

  it("returns true for decimal128", () => {
    expect(isDecimalType("decimal128")).toBe(true);
  });

  it("returns false for other types", () => {
    expect(isDecimalType("integer")).toBe(false);
    expect(isDecimalType("string")).toBe(false);
    expect(isDecimalType("float64")).toBe(false);
  });
});
