// @vitest-environment jsdom
// The paste box and the Detail Panel render through JsonEditor (JSON / YAML) or a coloured textarea (Protobuf, TypeSpec, SQL).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("@/features/events/builder/template/controls/JsonEditor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/events/builder/template/controls/JsonEditor")>();
  return {
    ...actual,
    JsonEditor: (props: Parameters<typeof actual.JsonEditor>[0]) => {
      h.calls.push(props as unknown as Record<string, unknown>);
      return actual.JsonEditor(props);
    },
  };
});

import { SchemaWorkbench } from "@/components/custom/SchemaWorkbench";
import { DetailPanel, boundedDiff, MAX_DIFF_CHARS } from "@/components/custom/SchemaWorkbench/DetailPanel";
import { diffLines } from "@/lib/schema-workbench/line-diff";
import { editorKindFor } from "@/lib/schema-workbench/editor-kind";

afterEach(() => {
  cleanup();
  h.calls.length = 0;
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
    expect(last("workbench-paste-textarea")).toMatchObject({ language: "json", height: 256 });
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

  it("loads the pasted text with the Load button as before", async () => {
    paste(JSON_TEXT);
    fireEvent.click(screen.getByTestId("workbench-load-button"));
    await waitFor(() => expect((screen.getByTestId("detail-panel-textarea") as HTMLTextAreaElement).value).toBe(JSON_TEXT));
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
