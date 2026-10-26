/**
 * TypeMappingOverrideDialog types.
 */

/** The two override powers the dialog offers, as the server decided them for this entity (a subset of `EntityCapabilities`). */
export interface OverrideCapabilities {
  /** Create a per-entity override or acknowledge a lossy mapping. */
  overrideEntity: boolean;
  /** Create a global override. */
  overrideGlobal: boolean;
}

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
  /** What the current user may do, decided by the server's policy (`entityCapabilities`), never from a role name. */
  capabilities: OverrideCapabilities;
  /** Callback when an override is created */
  onCreateOverride: (data: CreateOverrideData) => Promise<void>;
  /** Callback when a lossy mapping is acknowledged */
  onAcknowledge?: (sourceType: string, targetFormat: string) => Promise<void>;
}
