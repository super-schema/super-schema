import { describe, it, expect } from "vitest";
import {
  generationWarningToast,
  stagedWarningToast,
  WARNING_TOAST_DURATION_MS,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/generate-warnings";

describe("generationWarningToast", () => {
  it("is null when there is nothing to warn about (the caller shows its usual success toast)", () => {
    expect(generationWarningToast(undefined)).toBeNull();
    expect(generationWarningToast([])).toBeNull();
    expect(generationWarningToast(["  "])).toBeNull();
  });

  it("one warning: a singular title that counts, the warning as the description, long enough to read, line breaks shown", () => {
    const toast = generationWarningToast(['The column "order" is a reserved word in BigQuery.'])!;

    expect(toast.title).toBe("Generated with 1 warning.");
    expect(toast.options).toEqual({
      description: 'The column "order" is a reserved word in BigQuery.',
      duration: 10_000,
      classNames: { description: "whitespace-pre-line" },
    });
    expect(WARNING_TOAST_DURATION_MS).toBe(10_000);
  });

  it("several warnings: a plural title and one warning per line", () => {
    const toast = generationWarningToast(["first.", "second.", "third."])!;

    expect(toast.title).toBe("Generated with 3 warnings.");
    expect(toast.options.description).toBe("first.\nsecond.\nthird.");
  });

  it("lists exactly five, then says how many more there are", () => {
    const five = generationWarningToast(["a", "b", "c", "d", "e"])!;
    expect(five.options.description).toBe("a\nb\nc\nd\ne");

    const eight = generationWarningToast(["a", "b", "c", "d", "e", "f", "g", "h"])!;
    expect(eight.title).toBe("Generated with 8 warnings.");
    expect(eight.options.description).toBe("a\nb\nc\nd\ne\n...and 3 more.");
  });

  it("cuts each listed warning to 200 characters", () => {
    const toast = generationWarningToast(["x".repeat(500), "short"])!;
    const [first, second] = toast.options.description.split("\n");

    expect(first).toBe(`${"x".repeat(199)}…`);
    expect(second).toBe("short");
  });

  it("never mentions a preview (there is none to open)", () => {
    const toast = generationWarningToast(Array.from({ length: 9 }, (_, i) => `w${i}`))!;

    expect(`${toast.title} ${toast.options.description}`).not.toMatch(/preview/i);
  });
});

describe("stagedWarningToast", () => {
  it("is null when no target had a warning", () => {
    expect(stagedWarningToast(3, [{ label: "BigQuery", warnings: [] }, { label: "Avro", warnings: undefined }])).toBeNull();
  });

  it("counts the schemas and the warnings in the title and prefixes each warning with its target", () => {
    const toast = stagedWarningToast(3, [
      { label: "BigQuery", warnings: ['The column "order" is a reserved word in BigQuery.'] },
      { label: "Avro", warnings: [] },
      { label: "Spanner", warnings: ["second one", "third one"] },
    ])!;

    expect(toast.title).toBe("Generated 3 schemas with 3 warnings.");
    expect(toast.options.description).toBe('BigQuery: The column "order" is a reserved word in BigQuery.\nSpanner: second one\nSpanner: third one');
    expect(toast.options.duration).toBe(10_000);
  });

  it("is singular for one schema and one warning, lists five and counts the rest", () => {
    expect(stagedWarningToast(1, [{ label: "Avro", warnings: ["only"] }])!.title).toBe("Generated 1 schema with 1 warning.");

    const many = stagedWarningToast(2, [{ label: "A", warnings: ["1", "2", "3", "4"] }, { label: "B", warnings: ["5", "6", "7"] }])!;
    expect(many.title).toBe("Generated 2 schemas with 7 warnings.");
    expect(many.options.description).toBe("A: 1\nA: 2\nA: 3\nA: 4\nB: 5\n...and 2 more.");
  });
});
