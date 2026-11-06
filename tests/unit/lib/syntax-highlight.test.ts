/**
 * Unit tests for syntax highlighting tokenizers
 */

import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { highlightSQL, highlightJSON, highlightYAML, highlightLine } from "@/lib/syntax-highlight";

// Helper to get the markup string from a React node
function render(node: React.ReactNode): string {
  return renderToStaticMarkup(node as React.ReactElement);
}

// ---------------------------------------------------------------------------
// SQL highlighting
// ---------------------------------------------------------------------------

describe("highlightSQL", () => {
  it("highlights SQL keywords with the shared keyword color", () => {
    const result = render(highlightSQL("CREATE TABLE users ("));
    expect(result).toContain("syntax-keyword");
    expect(result).toContain("CREATE");
    expect(result).toContain("TABLE");
  });

  it("highlights SQL types with the shared type color", () => {
    const result = render(highlightSQL("  id STRING NOT NULL,"));
    expect(result).toContain("syntax-type");
    expect(result).toContain("STRING");
    expect(result).toContain("syntax-keyword"); // NOT NULL as keywords
  });

  it("highlights comments with the shared comment color", () => {
    const result = render(highlightSQL("  -- WARNING: lossy mapping"));
    expect(result).toContain("syntax-comment");
    expect(result).toContain("italic");
  });

  it("highlights string literals with the shared string color", () => {
    const result = render(highlightSQL("  description='Hello World'"));
    expect(result).toContain("syntax-string");
  });

  it("highlights numbers with the shared constant color", () => {
    const result = render(highlightSQL("  precision 38"));
    expect(result).toContain("syntax-constant");
    expect(result).toContain("38");
  });
});

// ---------------------------------------------------------------------------
// JSON highlighting
// ---------------------------------------------------------------------------

describe("highlightJSON", () => {
  it("highlights JSON keys with the shared key color", () => {
    const result = render(highlightJSON('  "name": "John"'));
    expect(result).toContain("syntax-key");
  });

  it("highlights JSON string values with the shared string color", () => {
    const result = render(highlightJSON('  "name": "John"'));
    expect(result).toContain("syntax-string");
  });

  it("highlights booleans with the shared constant color", () => {
    const result = render(highlightJSON('  "active": true'));
    expect(result).toContain("syntax-constant");
  });

  it("highlights null with the shared constant color", () => {
    const result = render(highlightJSON('  "value": null'));
    expect(result).toContain("syntax-constant");
  });

  it("highlights numbers with the shared constant color", () => {
    const result = render(highlightJSON('  "count": 42'));
    expect(result).toContain("syntax-constant");
  });
});

// ---------------------------------------------------------------------------
// YAML highlighting
// ---------------------------------------------------------------------------

describe("highlightYAML", () => {
  it("returns a keyed list for a `key: value` line (no React 'unique key' warning)", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const line of ["type: object", "  address: payments.orders", "  $ref: '#/components/messages/a'", "enabled: true # note"]) {
        render(highlightYAML(line));
      }
      const keyWarnings = errors.mock.calls.filter((call) => String(call[0]).includes("unique \"key\" prop"));
      expect(keyWarnings).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  it("highlights YAML keys with the shared key color", () => {
    const result = render(highlightYAML("type: object"));
    expect(result).toContain("syntax-key");
    expect(result).toContain("type");
  });

  it("highlights YAML comments with the shared comment color", () => {
    const result = render(highlightYAML("# This is a comment"));
    expect(result).toContain("syntax-comment");
    expect(result).toContain("italic");
  });

  it("highlights boolean values with the shared constant color", () => {
    const result = render(highlightYAML("nullable: true"));
    expect(result).toContain("syntax-constant");
  });

  it("highlights number values with the shared constant color", () => {
    const result = render(highlightYAML("minimum: 0"));
    expect(result).toContain("syntax-constant");
  });
});

// ---------------------------------------------------------------------------
// Language dispatcher
// ---------------------------------------------------------------------------

describe("highlightLine", () => {
  it("dispatches to SQL for sql language", () => {
    const result = render(highlightLine("CREATE TABLE x (", "sql"));
    expect(result).toContain("syntax-keyword");
  });

  it("dispatches to JSON for json language", () => {
    const result = render(highlightLine('{"key": "value"}', "json"));
    expect(result).toContain("syntax-key");
  });

  it("dispatches to YAML for yaml language", () => {
    const result = render(highlightLine("key: value", "yaml"));
    expect(result).toContain("syntax-key");
  });

  it("returns plain text for unknown language", () => {
    const result = render(highlightLine("hello world", "unknown"));
    expect(result).toBe("<span>hello world</span>");
  });
});
