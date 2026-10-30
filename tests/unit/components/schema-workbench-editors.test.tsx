// @vitest-environment jsdom
// The paste box and the Detail Panel render through JsonEditor (JSON / YAML) or a coloured textarea (Protobuf, TypeSpec, SQL).
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { cleanup, fireEvent, render, screen, waitFor, configure } from "@testing-library/react";

const h = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>>, mounts: { json: 0, overlay: 0 } }));
vi.mock("@/features/events/builder/template/controls/JsonEditor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/events/builder/template/controls/JsonEditor")>();
  return {
    ...actual,
    JsonEditor: (props: Parameters<typeof actual.JsonEditor>[0]) => {
      h.calls.push(props as unknown as Record<string, unknown>);
      useEffect(() => {
        if (props.id === "workbench-paste-textarea") h.mounts.json += 1; // the paste box's editor (the Detail Panel has its own)
      }, []);
      return actual.JsonEditor(props);
    },
  };
});
vi.mock("@/components/custom/SchemaWorkbench/HighlightedTextarea", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/custom/SchemaWorkbench/HighlightedTextarea")>();
  return {
    ...actual,
    HighlightedTextarea: (props: Parameters<typeof actual.HighlightedTextarea>[0]) => {
      useEffect(() => {
        h.mounts.overlay += 1;
      }, []);
      return actual.HighlightedTextarea(props);
    },
  };
});

import { SchemaWorkbench } from "@/components/custom/SchemaWorkbench";
import { DetailPanel, boundedDiff, MAX_DIFF_CHARS } from "@/components/custom/SchemaWorkbench/DetailPanel";
import { HighlightedTextarea, MAX_HIGHLIGHT_CHARS, renderStats } from "@/components/custom/SchemaWorkbench/HighlightedTextarea";
import { diffLines } from "@/lib/schema-workbench/line-diff";
import { editorKindFor } from "@/lib/schema-workbench/editor-kind";

// The first live check loads the importers on demand; under a loaded machine that can outlast the 1s default.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  h.calls.length = 0;
  h.mounts.json = 0;
  h.mounts.overlay = 0;
});

const JSON_TEXT = JSON.stringify({ type: "object", properties: { a: { type: "string" } } }, null, 2);
const PROTO = 'syntax = "proto3";\nmessage Customer {\n  int64 id = 1;\n}\n';
const DDL = "CREATE TABLE t (\n  id INT64 NOT NULL\n);";
const last = (id: string) => [...h.calls].reverse().find((c) => c.id === id) as Record<string, unknown>;

function paste(text: string) {
  render(<SchemaWorkbench onCommit={vi.fn()} onBack={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Paste" }));
  fireEvent.change(screen.getByTestId("workbench-paste-textarea"), { target: { value: text } });
}

describe("editorKindFor", () => {
  it("maps formats to an editor", () => {
    expect(editorKindFor("json-schema", JSON_TEXT)).toEqual({ kind: "codemirror", language: "json" });
    expect(editorKindFor("json-schema", "type: object\n")).toEqual({ kind: "codemirror", language: "yaml" });
    expect(editorKindFor("openapi", "# c\nopenapi: 3.0.0")).toEqual({ kind: "codemirror", language: "yaml" });
    expect(editorKindFor("avro", "")).toEqual({ kind: "codemirror", language: "json" });
    expect(editorKindFor("protobuf", "x")).toEqual({ kind: "overlay", highlight: "code" });
    expect(editorKindFor("typespec", "x")).toEqual({ kind: "overlay", highlight: "code" });
    expect(editorKindFor("bigquery-ddl", "x")).toEqual({ kind: "overlay", highlight: "sql" });
  });
  it("sniffs the text when the format is not known yet", () => {
    expect(editorKindFor(null, "[1]")).toEqual({ kind: "codemirror", language: "json" });
    expect(editorKindFor(null, "type: record")).toEqual({ kind: "codemirror", language: "yaml" });
    expect(editorKindFor(null, PROTO)).toEqual({ kind: "overlay", highlight: "code" });
    expect(editorKindFor(null, 'model A {\n}')).toEqual({ kind: "overlay", highlight: "code" });
    expect(editorKindFor(null, "-- c\ncreate table t (id int);")).toEqual({ kind: "overlay", highlight: "sql" });
  });
});

describe("paste box", () => {
  it("is a JsonEditor with the same test id, an accessible name and the JSON language", () => {
    paste(JSON_TEXT);
    const area = screen.getByTestId("workbench-paste-textarea") as HTMLTextAreaElement;
    expect(area.tagName).toBe("TEXTAREA"); // jsdom fallback
    expect(area.value).toBe(JSON_TEXT);
    expect(area.getAttribute("aria-label")).toBe("Paste your schema content");
    expect(last("workbench-paste-textarea")).toMatchObject({ language: "json", height: 320 });
  });

  it("follows the pasted text: YAML switches the language", () => {
    paste("type: object\nproperties: {}\n");
    expect(last("workbench-paste-textarea")).toMatchObject({ language: "yaml" });
  });

  it("uses a coloured textarea (not CodeMirror) for Protobuf and SQL", () => {
    paste(PROTO);
    expect(screen.queryByTestId("workbench-paste-textarea-editor")).toBeNull();
    const area = screen.getByTestId("workbench-paste-textarea") as HTMLTextAreaElement;
    expect(area.value).toBe(PROTO);
    expect(area.getAttribute("aria-label")).toBe("Paste your schema content");
    cleanup();
    paste(DDL);
    expect(screen.queryByTestId("workbench-paste-textarea-editor")).toBeNull();
  });

  it("has no Load button or Detail Panel: a live check answers instead, and Review & Import commits the text", async () => {
    const onCommit = vi.fn();
    render(<SchemaWorkbench onCommit={onCommit} onBack={vi.fn()} />);
    fireEvent.change(screen.getByTestId("workbench-paste-textarea"), { target: { value: JSON_TEXT } });
    expect(screen.queryByTestId("workbench-load-button")).toBeNull();
    expect(screen.queryByTestId("detail-panel-textarea")).toBeNull();
    expect(screen.getByTestId("workbench-paste-status").getAttribute("data-state")).toBe("checking");
    expect((screen.getByTestId("workbench-review-button") as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(screen.getByTestId("workbench-paste-status").getAttribute("data-state")).toBe("valid"), { timeout: 5000 });
    expect(screen.getByTestId("workbench-paste-status").textContent).toMatch(/^Loads: /);
    expect(screen.queryByTestId("detail-panel-textarea")).toBeNull(); // pasting never loads the Detail Panel
    const review = screen.getByTestId("workbench-review-button") as HTMLButtonElement;
    expect(review.disabled).toBe(false);
    fireEvent.click(review);
    expect(onCommit).toHaveBeenCalledWith(JSON_TEXT, undefined);
  });

  it("flags text that cannot load and keeps Review & Import disabled", async () => {
    paste("{ not json");
    await waitFor(() => expect(screen.getByTestId("workbench-paste-status").getAttribute("data-state")).toBe("invalid"), { timeout: 5000 });
    expect(screen.getByTestId("workbench-paste-status").textContent).toMatch(/^Cannot load this schema: /);
    expect((screen.getByTestId("workbench-review-button") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Detail Panel", () => {
  it("passes changedLines equal to the diff result and reports edits", () => {
    const onChange = vi.fn();
    const baseline = JSON_TEXT;
    const value = JSON_TEXT.replace('"string"', '"integer"');
    render(<DetailPanel value={value} baseline={baseline} onChange={onChange} format="json-schema" />);
    const expected = diffLines(baseline, value).lines.flatMap((l, i) => (l.changed ? [i + 1] : []));
    expect(expected.length).toBeGreaterThan(0);
    expect(last("detail-panel-textarea")).toMatchObject({ changedLines: expected, language: "json", height: "100%" });
    fireEvent.change(screen.getByTestId("detail-panel-textarea"), { target: { value: "x" } });
    expect(onChange).toHaveBeenCalledWith("x");
  });

  it("passes no changedLines without a baseline", () => {
    render(<DetailPanel value={JSON_TEXT} onChange={vi.fn()} format="json-schema" />);
    expect(last("detail-panel-textarea").changedLines).toBeUndefined();
  });

  it("uses the YAML language for YAML text", () => {
    render(<DetailPanel value={"type: object\n"} onChange={vi.fn()} format="json-schema" />);
    expect(last("detail-panel-textarea")).toMatchObject({ language: "yaml" });
  });

  it("keeps the red-backdrop textarea for Protobuf, now with token colours", () => {
    render(<DetailPanel value={PROTO.replace("Customer", "Client")} baseline={PROTO} onChange={vi.fn()} format="protobuf" />);
    expect(h.calls.filter((c) => c.id === "detail-panel-textarea")).toHaveLength(0);
    const backdrop = screen.getByTestId("detail-panel-backdrop");
    expect(backdrop.getAttribute("data-highlight")).toBe("code");
    expect(backdrop.querySelectorAll('[data-changed="true"]')).toHaveLength(1);
    expect(backdrop.querySelector(".text-blue-400")).not.toBeNull(); // a keyword is coloured
    expect(screen.getByTestId("detail-panel-changes").textContent).toMatch(/1 changed/);
  });

  it("colours SQL DDL", () => {
    render(<DetailPanel value={DDL} onChange={vi.fn()} format="bigquery-ddl" />);
    expect(screen.getByTestId("detail-panel-textarea").getAttribute("aria-label")).toBe("Detail Panel schema text");
    expect(document.querySelector(".text-blue-400")).not.toBeNull();
  });

  it("skips the diff gracefully for a huge text, and stays editable", () => {
    const big = "x".repeat(MAX_DIFF_CHARS + 1);
    expect(boundedDiff(big, big + "y")).toBe("skipped");
    const manyLines = "a\n".repeat(31_000);
    expect(boundedDiff("a", manyLines)).toBe("skipped");

    const onChange = vi.fn();
    render(<DetailPanel value={manyLines} baseline={"a\n"} onChange={onChange} format="json-schema" />);
    expect(screen.getByTestId("detail-panel-diff-skipped")).toBeDefined();
    expect(last("detail-panel-textarea").changedLines).toBeUndefined();
    fireEvent.change(screen.getByTestId("detail-panel-textarea"), { target: { value: "ok" } });
    expect(onChange).toHaveBeenCalledWith("ok");
  });
});

describe("paste box keeps its editor while the user types", () => {
  const area = () => screen.getByTestId("workbench-paste-textarea") as HTMLTextAreaElement;

  it("typing character by character never remounts (the kind is not re-sniffed per keystroke)", () => {
    render(<SchemaWorkbench onCommit={vi.fn()} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    expect(h.mounts.json).toBe(1);
    let text = "";
    for (const ch of 'syntax = "proto3"; message A {}') {
      text += ch;
      fireEvent.change(area(), { target: { value: text } });
    }
    expect(h.mounts.json).toBe(1);
    expect(h.mounts.overlay).toBe(0);
    expect(screen.getByTestId("workbench-paste-textarea-editor")).toBeDefined(); // still the JsonEditor
  });

  it("a paste into the empty box that changes the kind focuses the new editor, caret at the end", () => {
    render(<SchemaWorkbench onCommit={vi.fn()} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    fireEvent.change(area(), { target: { value: PROTO } });
    expect(h.mounts.overlay).toBe(1);
    expect(screen.queryByTestId("workbench-paste-textarea-editor")).toBeNull();
    expect(document.activeElement).toBe(area());
    expect(area().selectionStart).toBe(PROTO.length);
  });

  it("a paste that keeps the kind does not remount", () => {
    render(<SchemaWorkbench onCommit={vi.fn()} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    fireEvent.change(area(), { target: { value: JSON_TEXT } });
    expect(h.mounts.json).toBe(1);
  });

  it("re-evaluates the kind when focus leaves the box", () => {
    render(<SchemaWorkbench onCommit={vi.fn()} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    fireEvent.change(area(), { target: { value: "a" } });
    fireEvent.change(area(), { target: { value: PROTO } });
    expect(h.mounts.overlay).toBe(0);
    fireEvent.blur(area());
    expect(h.mounts.overlay).toBe(1);
    expect(screen.queryByTestId("workbench-paste-textarea-editor")).toBeNull();
  });
});

describe("HighlightedTextarea cost", () => {
  it("colours nothing above the cap and says so", () => {
    const big = "message A {}\n".repeat(Math.ceil(100_000 / 13));
    expect(big.length).toBeGreaterThan(MAX_HIGHLIGHT_CHARS);
    const { container } = render(<HighlightedTextarea id="t" ariaLabel="t" value={big} onChange={vi.fn()} highlight="code" />);
    expect(container.querySelectorAll("span").length).toBe(0);
    expect(screen.getByTestId("t-colors-off").textContent).toBe("Syntax colors are off for very large inputs");
  });

  it("colours up to the cap, with no note", () => {
    const small = "message A {}\n".repeat(10);
    const { container } = render(<HighlightedTextarea id="t" ariaLabel="t" value={small} onChange={vi.fn()} highlight="code" />);
    expect(container.querySelectorAll("span").length).toBeGreaterThan(10);
    expect(screen.queryByTestId("t-colors-off")).toBeNull();
  });

  it("re-renders O(1) layer lines when one line is edited", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `message M${i} {}`);
    const { rerender } = render(<HighlightedTextarea id="t" ariaLabel="t" value={lines.join("\n")} onChange={vi.fn()} highlight="code" />);
    const before = renderStats.lines;
    expect(before).toBeGreaterThanOrEqual(300);
    const edited = [...lines];
    edited[150] = "message Edited {}";
    rerender(<HighlightedTextarea id="t" ariaLabel="t" value={edited.join("\n")} onChange={vi.fn()} highlight="code" />);
    expect(renderStats.lines - before).toBe(1);
  });

  it("keeps the layer on the live text and clamps diff marks to it", () => {
    const diff = diffLines("a\nb\nc\nd", "a\nB");
    render(<HighlightedTextarea id="t" ariaLabel="t" value={"a\nB\nx\ny\nz"} onChange={vi.fn()} highlight="code" diff={diff} backdropTestId="bd" />);
    expect(screen.getByTestId("bd").children).toHaveLength(5); // the live text's lines, not the diff's
  });
});
