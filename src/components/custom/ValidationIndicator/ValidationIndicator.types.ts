import type { ValidationStatus } from "@/lib/validation/field-completeness";

export interface ValidationIndicatorProps {
  status: ValidationStatus;
  tooltipContent: string;
}
