# Unified Schema Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge "Import Schema" and "Build Visually" into one wizard step (drop file / paste / build form) with an editable Detail Panel: two-way synced for form-built schemas, red change-tracking for imported/pasted ones; hide the global empty Detail Panel on new-entity routes via an opt-in flag.

**Architecture:** A pure core (`src/lib/schema-workbench/`: form-state serialize/parse, line diff, reducer) plus a `SchemaWorkbench` component that owns the editor hydration handshake. The three visual editors gain an additive `hydrate` prop; everything else commits through the unchanged `handleImportSubmit(content, filename?, format?)`.

**Tech Stack:** Next.js (app router), React, TypeScript, Vitest + Testing Library, Tailwind design tokens.

**Spec:** `docs/superpowers/specs/2026-10-14-unified-schema-workbench-design.md`

**Deviation from spec §5.5:** `parseToFormState` is a strict, direct inverse of the three `serialize*` functions rather than a mapping from importer IR. The importers emit a richer IR than the form models, so going through them is lossy and indirect. Text outside the serializers' output shape returns `{ ok: false }`. Spec updated in Task 8.

## Global Constraints

- Commit path stays `handleImportSubmit(content, filename?, format?)` in `EntityCreationWizard.tsx`; do not change its signature.
- Editors stay backward compatible: `hydrate` is optional, default behaviour unchanged.
- No new dependencies (in-repo line diff).
- Parse functions never throw; failures are `{ ok: false, reason }`.
- Pasted content behaves like an import: no form sync.
- Route flag is opt-in; no other route's right-panel behaviour changes.
- Tests: Vitest; unit tests under `tests/unit/`.

## Review Focus

- Panel text that is valid JSON but not a schema the form can express (e.g. nested objects) → form untouched, notice shown, text kept.
- Typing in the panel must not be overwritten by the editor's re-serialization (loop guard).
- Empty/whitespace panel in form origin → Review & Import disabled, no crash.
- Switching Build form after an import must confirm before discarding.
- Right panel flag must clear on unmount so entity workspace pages still show pushed content.

## File Structure

- Create `src/lib/schema-workbench/form-state.ts` — `FormState` union, `serializeFormState`.
- Create `src/lib/schema-workbench/parse-to-form-state.ts` — `parseToFormState`.
- Create `src/lib/schema-workbench/line-diff.ts` — `diffLines`.
- Create `src/lib/schema-workbench/workbench-state.ts` — reducer.
- Modify `src/components/custom/VisualSchemaBuilder/{types.ts,JsonSchemaVisualEditor.tsx,AvroVisualEditor.tsx,ProtobufVisualEditor.tsx}` — `hydrate` prop.
- Create `src/components/custom/SchemaWorkbench/{SchemaWorkbench.tsx,DetailPanel.tsx,index.ts}`.
- Modify `src/components/custom/EntityCreationWizard/{TemplateSelector.tsx,EntityCreationWizard.tsx}`.
- Modify `src/hooks/useRightPanelContent.tsx`, `src/components/layout/{RightPanel.tsx,DashboardClientShell.tsx}`; create `src/components/layout/HideEmptyRightPanel.tsx`; modify the two `new/page.tsx`.
- Tests under `tests/unit/lib/schema-workbench/` and `tests/unit/components/`.

---

### Task 1: Form state serialize + parse

**Files:** Create `form-state.ts`, `parse-to-form-state.ts`; Test `tests/unit/lib/schema-workbench/parse-to-form-state.test.ts`.

**Interfaces — Produces:**
```ts
type WorkbenchFormat = "json-schema" | "avro" | "protobuf";
type FormState =
  | { format: "json-schema"; title: string; description: string; fields: JsonSchemaField[] }
  | { format: "avro"; name: string; namespace: string; doc: string; fields: AvroField[] }
  | { format: "protobuf"; name: string; packageName: string; fields: ProtoField[] };
serializeFormState(state: FormState): string | null
parseToFormState(format: WorkbenchFormat, text: string):
  { ok: true; state: FormState } | { ok: false; reason: string }
```

- [ ] Write failing round-trip tests: for each format build a state using every field kind the serializer supports (json: string w/ format/pattern/min/max, number bounds, array of string and of reference, reference, enum, const, default, deprecated/readOnly/writeOnly, required toggle; avro: primitives, logical types, nullable, decimal precision/scale, enum, array, map, fixed, duration, reference, aliases, order, default; proto: scalars, well-known, repeated, map<k,v>, reference, oneof groups, doc comments) → `serializeFormState` → `parseToFormState` → `serializeFormState` must equal the first text.
- [ ] Failing tests for `ok:false`: invalid JSON, JSON that is not an object schema, nested `properties` on a property, avro union with more than `["null", X]`, proto with `import` or nested `message`.
- [ ] Implement; run `npx vitest run tests/unit/lib/schema-workbench/parse-to-form-state.test.ts`; commit.

### Task 2: Line diff

**Files:** Create `line-diff.ts`; Test `tests/unit/lib/schema-workbench/line-diff.test.ts`.

**Produces:** `diffLines(baseline: string, current: string): { lines: { text: string; changed: boolean }[]; removedAt: number[] }` — LCS over lines; current lines outside the LCS are `changed`; `removedAt[i]` = index in `current` before which a baseline line was removed (for gutter markers).

- [ ] Failing tests: identical → none changed; edited line → that line changed; inserted line; removed line → `removedAt`; empty baseline → all changed; trailing newline differences.
- [ ] Implement; run; commit.

### Task 3: Workbench reducer

**Files:** Create `workbench-state.ts`; Test `tests/unit/lib/schema-workbench/workbench-state.test.ts`.

**Produces:**
```ts
interface WorkbenchState {
  origin: "none" | "form" | "imported";
  format: WorkbenchFormat | null; baselineText: string; currentText: string;
  filename?: string; formMappable: boolean;
}
type WorkbenchAction =
  | { type: "loadImport"; text: string; format: string | null; filename?: string }
  | { type: "startForm"; format: WorkbenchFormat }
  | { type: "formChanged"; text: string | null }
  | { type: "panelEdited"; text: string; mappable: boolean }
  | { type: "resetToBaseline" } | { type: "clear" };
workbenchReducer(state, action): WorkbenchState; initialWorkbenchState
```

- [ ] Failing tests for every transition (loadImport sets baseline=current; formChanged null → ""; panelEdited sets `formMappable`; resetToBaseline only in imported; startForm clears baseline).
- [ ] Implement; run; commit.

### Task 4: Editors accept `hydrate`

**Files:** Modify `types.ts` and the three editors; Test `tests/unit/components/visual-editor-hydrate.test.tsx`.

**Interfaces:** `VisualEditorProps.hydrate?: { nonce: number; state: FormState }`. In each editor a `useEffect` keyed on `hydrate?.nonce` replaces title/name/description/fields (and expanded set cleared) when `hydrate.state.format` matches. Default behaviour untouched.

- [ ] Failing tests: rendering each editor then re-rendering with `hydrate` shows the new name/fields and emits the matching serialized text via `onContentChange`.
- [ ] Implement; run existing `visual-schema-builder-*` tests + new; commit.

### Task 5: DetailPanel + SchemaWorkbench

**Files:** Create `DetailPanel.tsx`, `SchemaWorkbench.tsx`, `index.ts`; Test `tests/unit/components/schema-workbench.test.tsx`.

**Interfaces:**
```ts
DetailPanel({ value, onChange, baseline?, placeholder })   // textarea over a diff backdrop; red lines when baseline set
SchemaWorkbench({ onCommit(content, format|undefined, filename?), referenceTargets, error, isLoading, detectedFormat, onBack })
```
Behaviour: modes `drop | paste | form`; imported origin shows format/filename badge, diagnostics via `detectFormat`, "Reset to original", "Start over"; form origin runs the hydrate handshake with a `lastSerialized` loop guard (ignore `onContentChange(text)` when `text === serializeFormState(lastHydratedState)`), 300 ms debounce on panel edits, inline "Can't map to the form" notice; confirm before discarding an import when switching to Build form; `Review & Import` disabled when `currentText.trim()` empty; commit passes `format` for form origin, `undefined` (re-detect) for imported.

- [ ] Failing tests: drop/paste loads text into the panel; editing it turns changed lines red (`data-changed`); form field edit updates panel text; panel edit of a valid schema updates the form field values; invalid panel text keeps the form and shows the notice; confirm-before-discard; Review & Import disabled when empty; commit args.
- [ ] Implement; run; commit.

### Task 6: Wizard + TemplateSelector merge

**Files:** Modify `TemplateSelector.tsx` (merge into `"schema"`, title "Import or Build Schema"), `EntityCreationWizard.tsx` (render `SchemaWorkbench`; drop `import`/`visual` branches); update `tests/unit/components/entity-creation-wizard-import.test.tsx`, `entity-creation-wizard-target.test.tsx`, `import-uploader.test.tsx` (keep `ImportUploader` file if still exported), `import-dialog-build-tab.test.tsx` unchanged (ImportDialog untouched).

- [ ] Update tests first to the new card name and the Paste → "Load schema" → "Review & Import" flow; run to see them fail; implement; run; commit.

### Task 7: Route flag

**Files:** Modify `useRightPanelContent.tsx` (`hideWhenEmpty`, `setHideWhenEmpty`), `RightPanel.tsx` (prop `hideWhenEmpty`), `DashboardClientShell.tsx` (pass through); create `HideEmptyRightPanel.tsx`; add to both `new/page.tsx`; Test `tests/unit/components/right-panel-hide-empty.test.tsx`.

- [ ] Failing tests: empty panel with `hideWhenEmpty` renders no "Detail Panel" heading; without flag unchanged; content still renders with flag; `HideEmptyRightPanel` clears the flag on unmount.
- [ ] Implement; run; commit.

### Task 8: Spec update + full verification

- [ ] Update spec §5.5 to the direct-inverse parser and the editor `hydrate` mechanism.
- [ ] `npx tsc --noEmit`, `npx vitest run`, `npx eslint` on touched files. Known pre-existing failure: `tests/integration/e2e-critical-flows.test.ts` slug test.
- [ ] Commit.
