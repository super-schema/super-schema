import { describe, it, expect } from "vitest";
import { generationWarningNotice } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/generate-warnings";

describe("generationWarningNotice", () => {
  it("is null when there is nothing to warn about", () => {
    expect(generationWarningNotice(undefined)).toBeNull();
    expect(generationWarningNotice([])).toBeNull();
  });

  it("one warning: singular, the message, one full stop", () => {
    expect(generationWarningNotice(["The column \"order\" is reserved."])).toBe('Generated with 1 warning: The column "order" is reserved.');
    expect(generationWarningNotice(["no full stop at the end"])).toBe("Generated with 1 warning: no full stop at the end.");
  });

  it("several warnings: plural, the first message, then how many more the preview has", () => {
    expect(generationWarningNotice(["a.", "b.", "c."])).toBe("Generated with 3 warnings: a (and 2 more in the preview).");
    expect(generationWarningNotice(["a", "b"])).toBe("Generated with 2 warnings: a (and 1 more in the preview).");
  });

  it("cuts a long first message to about 200 characters", () => {
    const notice = generationWarningNotice(["x".repeat(500)]) as string;

    expect(notice.startsWith(`Generated with 1 warning: ${"x".repeat(199)}…`)).toBe(true);
    expect(notice.endsWith("….")).toBe(true);
    expect(notice.length).toBeLessThan(260);
  });
});
