import { describe, expect, it } from "vitest";

import { formatDateOnly, formatDateTime } from "@/lib/date-format";

describe("date formatting", () => {
  it("formats date-only text with a fixed locale and timezone", () => {
    expect(formatDateOnly("2026-01-02T23:30:00.000Z")).toBe("Jan 2, 2026");
  });

  it("formats date-time text with a fixed locale and timezone", () => {
    expect(formatDateTime("2026-01-02T23:30:00.000Z")).toBe("Jan 2, 2026, 11:30 PM UTC");
  });

  it("returns an em dash for missing or invalid dates", () => {
    expect(formatDateOnly(null)).toBe("—");
    expect(formatDateTime("not-a-date")).toBe("—");
  });
});
