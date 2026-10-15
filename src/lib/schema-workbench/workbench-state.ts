/**
 * Schema Workbench state: where the schema text came from and what it is now.
 *
 * - `form`     built in the visual form; the panel and form sync both ways.
 * - `imported` dropped or pasted; the panel is editable but never syncs back,
 *              and edits are shown against `baselineText`.
 */

import { isWorkbenchFormat, type WorkbenchFormat } from "./form-state";

export interface WorkbenchState {
  origin: "none" | "form" | "imported";
  /** Detected (imported) or chosen (form) format; null when unknown. */
  format: WorkbenchFormat | null;
  /** Format string as detected, even when the form can't edit it (typespec, openapi, …). */
  detectedFormat: string | null;
  baselineText: string;
  currentText: string;
  filename?: string;
  /** False when the panel text can't be mapped back into the form. */
  formMappable: boolean;
}

export const initialWorkbenchState: WorkbenchState = {
  origin: "none",
  format: null,
  detectedFormat: null,
  baselineText: "",
  currentText: "",
  formMappable: true,
};

export type WorkbenchAction =
  | { type: "loadImport"; text: string; format: string | null; filename?: string }
  | { type: "startForm"; format: WorkbenchFormat }
  | { type: "formChanged"; text: string | null }
  | { type: "panelEdited"; text: string; mappable: boolean }
  | { type: "resetToBaseline" }
  | { type: "clear" };

export function workbenchReducer(state: WorkbenchState, action: WorkbenchAction): WorkbenchState {
  switch (action.type) {
    case "loadImport":
      return {
        origin: "imported",
        format: isWorkbenchFormat(action.format) ? action.format : null,
        detectedFormat: action.format,
        baselineText: action.text,
        currentText: action.text,
        filename: action.filename,
        formMappable: true,
      };
    case "startForm":
      return {
        origin: "form",
        format: action.format,
        detectedFormat: action.format,
        baselineText: "",
        currentText: "",
        formMappable: true,
      };
    case "formChanged":
      if (state.origin !== "form") return state;
      return { ...state, currentText: action.text ?? "", formMappable: true };
    case "panelEdited":
      return { ...state, currentText: action.text, formMappable: action.mappable };
    case "resetToBaseline":
      if (state.origin !== "imported") return state;
      return { ...state, currentText: state.baselineText };
    case "clear":
      return initialWorkbenchState;
  }
}
