/**
 * TypeMappingOverrideDialog types.
 */

export interface OverrideDialogMappingContext {
  /** The logical source type (e.g., "decimal") */
  sourceType: string;
  /** The target format (e.g., "openapi") */
  targetFormat: string;
  /** The current mapped type (e.g., "number/double") */
  currentMappedType: string;
  /** Loss description if this is a lossy mapping */
  lossDescription?: string;
  /** Field name that triggered this override */
  fieldName?: string;
}

export interface CreateOverrideData {
  sourceType: string;
  targetFormat: string;
  mappedType: string;
  justification: string;
  scope: "global" | "per-entity";
  isLossy: boolean;
}

export interface TypeMappingOverrideDialogProps {
  /** Whether the dialog is open */
  open: boolean;
  /** Callback to close the dialog */
  onClose: () => void;
  /** The mapping context that triggered this dialog */
  mappingContext: OverrideDialogMappingContext | null;
  /** The entity ID for per-entity overrides */
  entityId: string;
  /** The current user's role */
  userRole: string;
  /** Callback when an override is created */
  onCreateOverride: (data: CreateOverrideData) => Promise<void>;
  /** Callback when a lossy mapping is acknowledged */
  onAcknowledge?: (sourceType: string, targetFormat: string) => Promise<void>;
}
