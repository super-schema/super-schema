/**
 * EmissionPreviewPanel types.
 */

import type { EmissionResult } from "@/lib/emission/emission.types";

export interface OverrideMappingInfo {
  sourceType: string;
  targetFormat: string;
  currentMappedType: string;
  lossDescription?: string;
  fieldName?: string;
  isOverride?: boolean;
  overrideSource?: "global" | "per-entity";
  approvedBy?: string;
}

export interface EmissionPreviewPanelProps {
  /** The emission result to display */
  result: EmissionResult;
  /** Whether the panel is open */
  open: boolean;
  /** Callback to close the panel */
  onClose: () => void;
  /** Entity ID for per-entity overrides */
  entityId?: string;
  /** Current user role for RBAC */
  userRole?: string;
  /** Callback when a lossy warning is clicked to open override dialog */
  onWarningClick?: (info: OverrideMappingInfo) => void;
  /** Override mappings applied to this emission (for badge display) */
  overrides?: OverrideMappingInfo[];
}
