import type { ValidationStatus } from "@/lib/validation/field-completeness";
import type { ReactNode } from "react";

export interface ValidationIndicatorProps {
  status: ValidationStatus;
  tooltipContent: ReactNode;
}
