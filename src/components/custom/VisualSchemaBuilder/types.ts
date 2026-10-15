/**
 * Visual Schema Builder — format-pluggable contract.
 *
 * Each supported source format registers a visual editor. The editor manages
 * its own structured UI state and emits its format's NATIVE text (JSON Schema,
 * Avro .avsc, Protobuf, ...). That text is then fed to the matching importer
 * (see src/lib/importers + import.service), so a new format only needs:
 *
 *   1. a visual editor component implementing VisualEditorProps
 *   2. an importer that already parses that format's text
 *
 * JSON Schema is implemented today; Avro and Protobuf are registered as
 * disabled slots so adding them later is additive, not a refactor.
 */

import type { ImportFormat } from "@/lib/importers/types";
import type { FormState } from "@/lib/schema-workbench/form-state";

export interface VisualEditorProps {
  /** Suggested initial entity/schema name. */
  defaultName?: string;
  /**
   * Existing entities/schemas that a field can reference (→ `$ref`). When empty,
   * the editor falls back to a free-text reference target.
   */
  referenceTargets?: { id?: string; name: string }[];
  /**
   * Called whenever the edited schema changes. Receives the serialized
   * native-format text, or null when the current state is empty/invalid
   * (so the dispatcher can disable "Review & Import").
   */
  onContentChange: (content: string | null) => void;
  /**
   * Replace the editor's state from outside (Schema Workbench: Detail Panel
   * edits flowing back into the form). Applied whenever `nonce` changes and the
   * state's format matches the editor's. Omit for a fully uncontrolled editor.
   */
  hydrate?: { nonce: number; state: FormState };
}

export interface VisualFormat {
  id: ImportFormat;
  label: string;
  /** False → shown in the picker but not selectable yet (placeholder). */
  enabled: boolean;
  Editor?: React.ComponentType<VisualEditorProps>;
  /** Shown when the format is a not-yet-implemented placeholder. */
  comingSoonNote?: string;
}
