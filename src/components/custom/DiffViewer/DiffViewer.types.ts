import type { DiffResult } from "@/services/version-history/version.types";

export interface DiffViewerProps {
  /** The structured diff result to display */
  diff: DiffResult;
  /** Callback to close the diff viewer and return to field editor */
  onClose: () => void;
}
