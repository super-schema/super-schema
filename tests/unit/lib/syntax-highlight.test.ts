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
  it("highlights SQL keywords in blue", () => {
    const result = render(highlightSQL("CREATE TABLE users ("));
    expect(result).toContain("text-blue-400");
    expect(result).toContain("CREATE");
    expect(result).toContain("TABLE");
  });

  it("highlights SQL types in cyan", () => {
    const result = render(highlightSQL("  id STRING NOT NULL,"));
    expect(result).toContain("text-cyan-400");
    expect(result).toContain("STRING");
    expect(result).toContain("text-blue-400"); // NOT NULL as keywords
  });

  it("highlights comments in muted italic", () => {
    const result = render(highlightSQL("  -- WARNING: lossy mapping"));
    expect(result).toContain("text-muted-foreground/60");
    expect(result).toContain("italic");
  });

  it("highlights string literals in green", () => {
    const result = render(highlightSQL("  description='Hello World'"));
    expect(result).toContain("text-green-400");
  });

  it("highlights numbers in amber", () => {
    const result = render(highlightSQL("  precision 38"));
    expect(result).toContain("text-amber-400");
    expect(result).toContain("38");
  });
});

// ---------------------------------------------------------------------------
// JSON highlighting
// ---------------------------------------------------------------------------

describe("highlightJSON", () => {
  it("highlights JSON keys in blue", () => {
    const result = render(highlightJSON('  "name": "John"'));
    expect(result).toContain("text-blue-400");
  });

  it("highlights JSON string values in green", () => {
    const result = render(highlightJSON('  "name": "John"'));
    expect(result).toContain("text-green-400");
  });

  it("highlights booleans in purple", () => {
    const result = render(highlightJSON('  "active": true'));
    expect(result).toContain("text-purple-400");
  });

  it("highlights null in purple", () => {
    const result = render(highlightJSON('  "value": null'));
    expect(result).toContain("text-purple-400");
  });

  it("highlights numbers in amber", () => {
    const result = render(highlightJSON('  "count": 42'));
    expect(result).toContain("text-amber-400");
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

  it("highlights YAML keys in blue", () => {
    const result = render(highlightYAML("type: object"));
    expect(result).toContain("text-blue-400");
    expect(result).toContain("type");
  });

  it("highlights YAML comments in muted italic", () => {
    const result = render(highlightYAML("# This is a comment"));
    expect(result).toContain("text-muted-foreground/60");
    expect(result).toContain("italic");
  });

  it("highlights boolean values in purple", () => {
    const result = render(highlightYAML("nullable: true"));
    expect(result).toContain("text-purple-400");
  });

  it("highlights number values in amber", () => {
    const result = render(highlightYAML("minimum: 0"));
    expect(result).toContain("text-amber-400");
  });
});

// ---------------------------------------------------------------------------
// Language dispatcher
// ---------------------------------------------------------------------------

describe("highlightLine", () => {
  it("dispatches to SQL for sql language", () => {
    const result = render(highlightLine("CREATE TABLE x (", "sql"));
    expect(result).toContain("text-blue-400");
  });

  it("dispatches to JSON for json language", () => {
    const result = render(highlightLine('{"key": "value"}', "json"));
    expect(result).toContain("text-blue-400");
  });

  it("dispatches to YAML for yaml language", () => {
    const result = render(highlightLine("key: value", "yaml"));
    expect(result).toContain("text-blue-400");
  });

  it("returns plain text for unknown language", () => {
    const result = render(highlightLine("hello world", "unknown"));
    expect(result).toBe("<span>hello world</span>");
  });
});
