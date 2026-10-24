import { describe, expect, it } from "vitest";
import { sanitizeImportedText } from "@/lib/importers/text-safety";

describe("sanitizeImportedText: what PostgreSQL text and JSON can store", () => {
  it("drops every NUL (PostgreSQL text and jsonb cannot hold one)", () => {
    expect(sanitizeImportedText("a\u0000b\u0000\u0000c")).toBe("abc");
    expect(sanitizeImportedText("\u0000")).toBe("");
  });

  it("replaces a lone surrogate, high or low, by U+FFFD", () => {
    expect(sanitizeImportedText("a\ud800b")).toBe("a�b");
    expect(sanitizeImportedText("a\udc00b")).toBe("a�b");
    expect(sanitizeImportedText("\ud800")).toBe("�");
    expect(sanitizeImportedText("\udc00")).toBe("�");
    expect(sanitizeImportedText("\ud800\ud800")).toBe("��");
    expect(sanitizeImportedText("\udc00\ud800")).toBe("��");
  });

  it("keeps a well-formed pair (an emoji), and all other text, unchanged", () => {
    expect(sanitizeImportedText("😀 café\n\t\"quoted\" \\ 日本語")).toBe("😀 café\n\t\"quoted\" \\ 日本語");
    expect(sanitizeImportedText("")).toBe("");
  });

  it("handles both in one text, and is idempotent", () => {
    const once = sanitizeImportedText("x\u0000y\ud83dz😀");
    expect(once).toBe("xy�z😀");
    expect(sanitizeImportedText(once)).toBe(once);
  });

  it("is linear: a long text of surrogates and NULs", () => {
    const text = "\ud800\u0000a".repeat(100_000);
    const started = performance.now();
    const out = sanitizeImportedText(text);
    expect(performance.now() - started).toBeLessThan(200);
    expect(out).toBe("�a".repeat(100_000));
  });
});
