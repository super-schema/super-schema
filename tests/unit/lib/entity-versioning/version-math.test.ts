import { describe, it, expect } from "vitest";
import {
  formatVersionLabel,
  parseVersionLabel,
  nextVersionNumber,
  resolveBump,
} from "@/lib/entity-versioning/version-math";

describe("formatVersionLabel / parseVersionLabel", () => {
  it("round-trips MAJOR.MINOR and accepts a leading v and whitespace", () => {
    expect(formatVersionLabel({ major: 2, minor: 1 })).toBe("2.1");
    expect(parseVersionLabel("2.1")).toEqual({ success: true, data: { major: 2, minor: 1 } });
    expect(parseVersionLabel(" v10.0 ")).toEqual({ success: true, data: { major: 10, minor: 0 } });
  });

  it.each(["2", "2.1.3", "abc", "0.1", "-1.0", ""])("rejects %j", (label) => {
    const res = parseVersionLabel(label);
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.code).toBe("VALIDATION_ERROR");
  });

  // Labels become integer-column lookups: a part beyond Int range must be rejected here, not thrown by the database.
  it("accepts parts up to 2^31-1 and nothing above, however many digits", () => {
    expect(parseVersionLabel("2147483647.2147483647")).toEqual({ success: true, data: { major: 2147483647, minor: 2147483647 } });
    expect(parseVersionLabel("1.2147483647")).toEqual({ success: true, data: { major: 1, minor: 2147483647 } });
    for (const label of [
      "2147483648.0", "1.2147483648", "99999999999.0", "1.99999999999", "v99999999999.99999999999",
      `${"9".repeat(400)}.0`, `1.${"9".repeat(400)}`, `${"9".repeat(400)}.${"9".repeat(400)}`,
    ]) {
      const res = parseVersionLabel(label);
      expect(res.success, label.slice(0, 30)).toBe(false);
      if (!res.success) expect(res.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it.each(["1.-1", "-5.0", "1.5.", ".5", "1.", "1,5", " ", "v", "1e3.0", "Infinity.0", "0x10.0"])("rejects garbage %j", (label) => {
    expect(parseVersionLabel(label).success).toBe(false);
  });
});

describe("nextVersionNumber", () => {
  it("starts at 1.0 INITIAL whatever bump is asked for", () => {
    expect(nextVersionNumber(null, "MAJOR")).toEqual({ version: { major: 1, minor: 0 }, changeKind: "INITIAL" });
    expect(nextVersionNumber(null, "MINOR")).toEqual({ version: { major: 1, minor: 0 }, changeKind: "INITIAL" });
  });

  it("MINOR keeps the major and increments the minor", () => {
    expect(nextVersionNumber({ major: 2, minor: 1 }, "MINOR")).toEqual({ version: { major: 2, minor: 2 }, changeKind: "MINOR" });
  });

  it("MAJOR increments the major and resets the minor", () => {
    expect(nextVersionNumber({ major: 2, minor: 1 }, "MAJOR")).toEqual({ version: { major: 3, minor: 0 }, changeKind: "MAJOR" });
  });
});

describe("resolveBump (raise-only)", () => {
  it("defaults to the suggestion", () => {
    expect(resolveBump("MINOR", undefined)).toEqual({ success: true, data: "MINOR" });
    expect(resolveBump("MAJOR", undefined)).toEqual({ success: true, data: "MAJOR" });
  });

  it("allows raising MINOR to MAJOR", () => {
    expect(resolveBump("MINOR", "MAJOR")).toEqual({ success: true, data: "MAJOR" });
  });

  it("refuses lowering MAJOR to MINOR", () => {
    const res = resolveBump("MAJOR", "MINOR");
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.code).toBe("BUMP_TOO_LOW");
  });
});
