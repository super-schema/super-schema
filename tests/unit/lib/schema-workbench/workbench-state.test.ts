import { describe, expect, it } from "vitest";
import {
  initialWorkbenchState,
  workbenchReducer,
  type WorkbenchState,
} from "@/lib/schema-workbench/workbench-state";

const imported = (): WorkbenchState =>
  workbenchReducer(initialWorkbenchState, {
    type: "loadImport",
    text: '{"a":1}',
    format: "json-schema",
    filename: "a.json",
  });

describe("workbenchReducer", () => {
  it("loadImport freezes the baseline and records format/filename", () => {
    const s = imported();
    expect(s).toMatchObject({
      origin: "imported",
      format: "json-schema",
      baselineText: '{"a":1}',
      currentText: '{"a":1}',
      filename: "a.json",
    });
  });

  it("keeps a detected format the form can't edit, but with no form format", () => {
    const s = workbenchReducer(initialWorkbenchState, { type: "loadImport", text: "x", format: "typespec" });
    expect(s.format).toBeNull();
    expect(s.detectedFormat).toBe("typespec");
  });

  it("panelEdited changes current text only and records mappability", () => {
    const s = workbenchReducer(imported(), { type: "panelEdited", text: "edited", mappable: false });
    expect(s.currentText).toBe("edited");
    expect(s.baselineText).toBe('{"a":1}');
    expect(s.formMappable).toBe(false);
  });

  it("resetToBaseline restores imported text", () => {
    const edited = workbenchReducer(imported(), { type: "panelEdited", text: "x", mappable: true });
    expect(workbenchReducer(edited, { type: "resetToBaseline" }).currentText).toBe('{"a":1}');
  });

  it("startForm clears the baseline", () => {
    const s = workbenchReducer(imported(), { type: "startForm", format: "avro" });
    expect(s).toMatchObject({ origin: "form", format: "avro", baselineText: "", currentText: "" });
  });

  it("formChanged updates text in form origin; null becomes empty", () => {
    const form = workbenchReducer(initialWorkbenchState, { type: "startForm", format: "protobuf" });
    expect(workbenchReducer(form, { type: "formChanged", text: "t" }).currentText).toBe("t");
    expect(workbenchReducer({ ...form, currentText: "t" }, { type: "formChanged", text: null }).currentText).toBe("");
  });

  it("ignores formChanged and resetToBaseline outside their origin", () => {
    const i = imported();
    expect(workbenchReducer(i, { type: "formChanged", text: "z" })).toBe(i);
    const form = workbenchReducer(initialWorkbenchState, { type: "startForm", format: "avro" });
    expect(workbenchReducer(form, { type: "resetToBaseline" })).toBe(form);
  });

  it("clear returns to the initial state", () => {
    expect(workbenchReducer(imported(), { type: "clear" })).toEqual(initialWorkbenchState);
  });
});
