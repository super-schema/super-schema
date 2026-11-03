import { describe, it, expect } from "vitest";
import { ok } from "@/types/result";
import {
  formatVersionLabel,
  parseVersionLabel,
  nextVersionNumber,
  resolveBump,
  compareVersions,
  INITIAL_VERSION,
  storedVersionWhere,
} from "@/lib/entity-versioning/version-math";
import { isBumpKind } from "@/lib/entity-versioning/types";

describe("formatVersionLabel / parseVersionLabel", () => {
  it("formats MAJOR.MINOR.PATCH, with a _snapshot suffix for the SNAPSHOT stage", () => {
    expect(formatVersionLabel({ major: 1, minor: 1, patch: 0 })).toBe("1.1.0");
    expect(formatVersionLabel({ major: 1, minor: 1, patch: 0 }, "RELEASED")).toBe("1.1.0");
    expect(formatVersionLabel({ major: 1, minor: 1, patch: 0 }, "SNAPSHOT")).toBe("1.1.0_snapshot");
  });

  it("parses released and snapshot labels, with a leading v and whitespace", () => {
    expect(parseVersionLabel("1.1.0")).toEqual(ok({ major: 1, minor: 1, patch: 0, stage: "RELEASED" }));
    expect(parseVersionLabel(" v10.0.2 ")).toEqual(ok({ major: 10, minor: 0, patch: 2, stage: "RELEASED" }));
    expect(parseVersionLabel("1.1.0_snapshot")).toEqual(ok({ major: 1, minor: 1, patch: 0, stage: "SNAPSHOT" }));
    expect(parseVersionLabel("v2.1.3_snapshot")).toEqual(ok({ major: 2, minor: 1, patch: 3, stage: "SNAPSHOT" }));
  });

  it("reads legacy MAJOR.MINOR labels as PATCH 0 RELEASED", () => {
    expect(parseVersionLabel("2.1")).toEqual(ok({ major: 2, minor: 1, patch: 0, stage: "RELEASED" }));
    expect(parseVersionLabel("v2.1")).toEqual(ok({ major: 2, minor: 1, patch: 0, stage: "RELEASED" }));
  });

  it("round-trips format → parse for both stages", () => {
    const v = { major: 3, minor: 4, patch: 5 };
    expect(parseVersionLabel(formatVersionLabel(v))).toEqual(ok({ ...v, stage: "RELEASED" }));
    expect(parseVersionLabel(formatVersionLabel(v, "SNAPSHOT"))).toEqual(ok({ ...v, stage: "SNAPSHOT" }));
  });

  it.each(["2", "2.1.3.4", "abc", "0.1", "0.1.0", "-1.0", "", "1.0.0_SNAPSHOT", "1.0.0-snapshot", "1.0_snapshot_snapshot"])(
    "rejects %j",
    (label) => {
      const res = parseVersionLabel(label);
      expect(res.success).toBe(false);
      if (!res.success) expect(res.error.code).toBe("VALIDATION_ERROR");
    }
  );

  // Labels become integer-column lookups: a part beyond Int range must be rejected here, not thrown by the database.
  it("accepts parts up to 2^31-1 and nothing above, however many digits", () => {
    expect(parseVersionLabel("2147483647.2147483647.2147483647")).toEqual(
      ok({ major: 2147483647, minor: 2147483647, patch: 2147483647, stage: "RELEASED" })
    );
    expect(parseVersionLabel("1.2147483647")).toEqual(ok({ major: 1, minor: 2147483647, patch: 0, stage: "RELEASED" }));
    for (const label of [
      "2147483648.0", "1.2147483648", "99999999999.0", "1.99999999999", "v99999999999.99999999999",
      `${"9".repeat(400)}.0`, `1.${"9".repeat(400)}`, `${"9".repeat(400)}.${"9".repeat(400)}`,
      "1.0.2147483648", `1.0.${"9".repeat(400)}`, "1.0.2147483648_snapshot",
    ]) {
      const res = parseVersionLabel(label);
      expect(res.success, label.slice(0, 30)).toBe(false);
      if (!res.success) expect(res.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it.each(["1.-1", "-5.0", "1.5.", ".5", "1.", "1,5", " ", "v", "1e3.0", "Infinity.0", "0x10.0", "1.0.-1", "_snapshot", "1.0.0 _snapshot"])(
    "rejects garbage %j",
    (label) => {
      expect(parseVersionLabel(label).success).toBe(false);
    }
  );
});

describe("nextVersionNumber", () => {
  it("starts at 1.0.0 INITIAL whatever bump is asked for", () => {
    expect(INITIAL_VERSION).toEqual({ major: 1, minor: 0, patch: 0 });
    for (const bump of ["MAJOR", "MINOR", "PATCH"] as const) {
      expect(nextVersionNumber(null, bump)).toEqual({ version: { major: 1, minor: 0, patch: 0 }, changeKind: "INITIAL" });
    }
  });

  it("PATCH increments the patch", () => {
    expect(nextVersionNumber({ major: 1, minor: 2, patch: 3 }, "PATCH")).toEqual({
      version: { major: 1, minor: 2, patch: 4 },
      changeKind: "PATCH",
    });
  });

  it("MINOR keeps the major, increments the minor and resets the patch", () => {
    expect(nextVersionNumber({ major: 1, minor: 2, patch: 3 }, "MINOR")).toEqual({
      version: { major: 1, minor: 3, patch: 0 },
      changeKind: "MINOR",
    });
  });

  it("MAJOR increments the major and resets minor and patch", () => {
    expect(nextVersionNumber({ major: 1, minor: 2, patch: 3 }, "MAJOR")).toEqual({
      version: { major: 2, minor: 0, patch: 0 },
      changeKind: "MAJOR",
    });
  });
});

describe("resolveBump (raise-only, PATCH < MINOR < MAJOR)", () => {
  it("defaults to the suggestion", () => {
    for (const bump of ["PATCH", "MINOR", "MAJOR"] as const) expect(resolveBump(bump, undefined)).toEqual(ok(bump));
  });

  it.each([
    ["PATCH", "PATCH"], ["PATCH", "MINOR"], ["PATCH", "MAJOR"], ["MINOR", "MINOR"], ["MINOR", "MAJOR"], ["MAJOR", "MAJOR"],
  ] as const)("allows %s → %s", (suggested, requested) => {
    expect(resolveBump(suggested, requested)).toEqual(ok(requested));
  });

  it.each([["MINOR", "PATCH"], ["MAJOR", "PATCH"], ["MAJOR", "MINOR"]] as const)(
    "refuses lowering %s → %s and names the suggested kind",
    (suggested, requested) => {
      const res = resolveBump(suggested, requested);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.code).toBe("BUMP_TOO_LOW");
        expect(res.error.message).toContain(suggested);
      }
    }
  );
});

describe("compareVersions", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareVersions({ major: 1, minor: 2, patch: 3 }, { major: 1, minor: 2, patch: 3 })).toBe(0);
    expect(compareVersions({ major: 1, minor: 2, patch: 3 }, { major: 1, minor: 2, patch: 4 })).toBeLessThan(0);
    expect(compareVersions({ major: 1, minor: 3, patch: 0 }, { major: 1, minor: 2, patch: 9 })).toBeGreaterThan(0);
    expect(compareVersions({ major: 2, minor: 0, patch: 0 }, { major: 1, minor: 9, patch: 9 })).toBeGreaterThan(0);
    expect(compareVersions({ major: 1, minor: 9, patch: 9 }, { major: 2, minor: 0, patch: 0 })).toBeLessThan(0);
  });
});

describe("isBumpKind", () => {
  it("accepts PATCH, MINOR and MAJOR only", () => {
    expect(["PATCH", "MINOR", "MAJOR"].every(isBumpKind)).toBe(true);
    for (const v of ["patch", "INITIAL", "", null, undefined, 1]) expect(isBumpKind(v)).toBe(false);
  });
});

describe("storedVersionWhere", () => {
  it("filters a stored row by its full number and its stage", () => {
    expect(storedVersionWhere({ major: 2, minor: 1, patch: 7, stage: "RELEASED" })).toEqual({ major: 2, minor: 1, patch: 7, stage: "RELEASED" });
    expect(storedVersionWhere({ major: 2, minor: 1, patch: 0, stage: "SNAPSHOT" })).toEqual({ major: 2, minor: 1, patch: 0, stage: "SNAPSHOT" });
  });

  it("reads a legacy x.y label as the released x.y.0 row", () => {
    const legacy = parseVersionLabel("v2.1");
    expect(legacy.success && storedVersionWhere(legacy.data)).toEqual({ major: 2, minor: 1, patch: 0, stage: "RELEASED" });
  });
});
