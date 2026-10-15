# Unified Schema Workbench — Design

Date: 2026-10-14
Status: Implemented
Branch context: feat/events-asyncapi (work lands on its own feature branch)

## 1. Problem

On the new-entity wizard (`/schemas/{domain}/{product}/new`, `/schemas/enterprise/new`) the user sees two separate cards, "Import Schema" and "Build Visually", that lead to two different steps (`ImportUploader`, `VisualSchemaBuilder`).

- The builder's "Detail Panel" (`VisualSchemaBuilder.tsx:85`) is a read-only `<pre>`. Sync is one-way: form state → `serialize*` → `onContentChange`. Nothing parses text back into the form.
- Import has no live view of the schema being imported.
- The global dashboard shell renders an empty-state "Detail Panel" (`RightPanel.tsx:66`) on the `/new` page, with the placeholder "Select a field to view decorators…". It is meaningless there.

## 2. Goals

1. Replace both cards with one entry step offering three inputs: **drop file**, **paste schema**, **build via form**.
2. Every input shows a **Detail Panel** with the current schema in its native format. It is editable.
3. **Form-built** schemas: two-way sync. Editing the panel updates the form; editing the form updates the panel.
4. **Imported/pasted** schemas: the panel is editable, changes are shown in red against the original, and nothing syncs back to a form.
5. The global shell's empty "Detail Panel" is hidden on the new-entity routes, via an opt-in route flag.

## 3. Non-goals

- Bulk import, TypeSpec / SQL DDL / union two-way sync, a Monaco-style editor.
- Loading pasted text into the form (decided: paste behaves like an import).
- Changing `handleImportSubmit(content, filename, format)`. It stays the single commit path.
- `ImportDialog` (946 lines, no in-app consumers) is untouched.

## 4. Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Structure | New `SchemaWorkbench` component replaces both cards (approach A) |
| Paste semantics | Same as import: editable, red change tracking, no form sync |
| Global panel hiding | Per-route opt-in flag, not a global default change |
| Editor surface | Plain `<textarea>` plus line-diff overlay |

## 5. Architecture

### 5.1 Entry step

`TemplateSelector` merges `import` and `visual` into one `schema` method ("Import or Build Schema"). `CreationMethod` gains `"schema"`; `"import"` and `"visual"` are removed. `EntityCreationWizard` renders `SchemaWorkbench` for `method === "schema"` and passes it:

- `onCommit(content, format, filename?)`, wired to `handleImportSubmit`.
- `referenceTargets`, `error`, `isLoading`, `detectedFormat`, `onBack`.

### 5.2 `SchemaWorkbench` layout

Two columns (stacked below `lg`). Left: source switcher (**Drop file | Paste | Build form**) and the active input. Right: the Detail Panel. Bottom: **Review & Import**, disabled when there is no content.

### 5.3 Workbench state (pure reducer, no React)

```
type Origin = "none" | "form" | "imported";
interface WorkbenchState {
  origin: Origin;
  format: ImportFormat;      // json-schema | avro | protobuf | ...
  baselineText: string;      // frozen at import time (imported origin only)
  currentText: string;       // what the panel shows and what gets committed
  filename?: string;
  formMappable: boolean;     // false when panel text can't map to the form
}
```

Transitions: `loadImport(text, format, filename)`, `startForm(format)`, `formChanged(text)`, `panelEdited(text)`, `resetToBaseline`.

### 5.4 Two-way sync (form origin)

- **Form → panel:** the active editor's `onContentChange(text)` dispatches `formChanged`, which sets `currentText`.
- **Panel → form:** `panelEdited(text)` is debounced (300 ms). `parseToFormState(format, text)` runs; if `ok`, the editor's state is replaced. If not, the text is kept, `formMappable = false`, and an inline notice reads "Can't map to the form. Fix the schema or keep editing as text." The form does not change and no user text is lost.
- **Loop guard:** track `lastWrittenText`. A `formChanged` whose text equals the text the panel just pushed down is ignored, and a `panelEdited` whose text equals the last form-serialized text is skipped.
- **Editors take a `hydrate` prop.** `VisualEditorProps.hydrate?: { nonce: number; state: FormState }` replaces the editor's internal state whenever `nonce` changes and the state's format matches. Optional, so uncontrolled use is unchanged. The workbench keeps the form editor mounted (hidden) while another input is shown, so form state survives tab switches.

### 5.5 `parseToFormState`

`src/lib/schema-workbench/parse-to-form-state.ts`. A strict, direct inverse of `serializeJsonSchema` / `serializeAvroSchema` / `serializeProtobufSchema` (not a mapping from importer IR, which is richer than the form models and lossy to go through). Returns `{ ok: true, state } | { ok: false, reason }`. Only text shaped like the serializers' output is accepted; invalid text and unrepresentable constructs (nested properties, multi-type unions, nested messages, extra keywords) return `ok: false` with a reason. Round-trip tests (`form → serialize → parse → serialize`) define "mappable". `serializeFormState` in `form-state.ts` is the single serialize entry point.

### 5.6 Imported / pasted origin

- Drop and Paste both call `loadImport`. Format comes from `format-detector.ts`.
- The panel is editable. Lines that differ from `baselineText` are highlighted red (line-level diff, LCS-based, added/changed lines shown red, removed lines shown as red gutter markers). **Reset to original** restores `baselineText`.
- No parse into the form. If the user switches to **Build form** from an imported origin, show a confirm ("This discards the imported schema") before `startForm`.
- Existing diagnostics from the paste flow (errors/warnings, `hasErrors`) carry over as a strip under the panel.

### 5.7 Global panel route flag

- `RightPanelContentProvider` gains `hideWhenEmpty: boolean` and `setHideWhenEmpty(v)`.
- A tiny client component `HideEmptyRightPanel` (rendered by the new-entity pages) sets the flag on mount and clears it on unmount.
- `DashboardShell` passes it to `RightPanel`. With `hideWhenEmpty && !children`, `RightPanel` renders the collapsed form (handle only, no placeholder). Content still wins: a page that pushes content shows it as today.
- Applied to `/schemas/[domainSlug]/[productSlug]/new/page.tsx` and `/schemas/enterprise/new/page.tsx`. No other route changes behaviour.

## 6. Error handling

- Invalid panel text in form origin: inline notice, form untouched (5.4).
- Parse failure on import: existing error banner path (`error` prop) unchanged.
- `parseToFormState` never throws; failures are values.
- Debounce timers cleared on unmount.

## 7. Testing (Vitest)

- Reducer: every transition, including `formMappable` toggling and `resetToBaseline`.
- `parseToFormState`: round-trip `form → serialize → parse → form` equality for json-schema, avro, protobuf; invalid text; unrepresentable constructs.
- Loop guard: a form edit produces exactly one panel write and no echo back.
- Diff highlighter: unchanged, changed, added, removed lines.
- Component: mode switching, confirm-before-discard, red highlighting after edit, Review & Import disabled when empty, commit calls `handleImportSubmit` with the expected args.
- Route flag: new-entity pages hide the empty panel; an entity workspace page still shows pushed content; the flag clears on unmount.
- Update existing wizard/`TemplateSelector` tests for the merged card.

## 8. Risks

- **Editor refactor:** lifting state in three editors is the largest change. Keep uncontrolled default behaviour to limit blast radius.
- **Parse fidelity:** the importers produce a richer IR than the form models. Round-trip tests define what "mappable" means. Anything outside it falls to `formMappable = false`.
- **Shared wizard:** the enterprise route uses the same wizard, so it changes too. That is intended.

## 9. Open items for the plan

- Decide the diff algorithm implementation (small in-repo LCS vs. an existing dependency). Prefer in-repo to avoid a new dependency.
