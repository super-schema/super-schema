export type ValidationStatus = "complete" | "suggestion" | "error";

export interface FieldCompleteness {
  status: ValidationStatus;
  missing: string[];
  suggestions: string[];
}

interface FieldInput {
  name: string;
  type: string;
  classification: string | null;
  precision: number | null;
  scale: number | null;
}

export function getFieldCompleteness(field: FieldInput): FieldCompleteness {
  const missing: string[] = [];
  const suggestions: string[] = [];

  // Required for all fields
  if (!field.name || field.name.trim() === "") {
    missing.push("name");
  }
  if (!field.type || field.type.trim() === "") {
    missing.push("type");
  }
  if (!field.classification) {
    missing.push("classification");
  }

  // Type-specific requirements
  if (field.type === "decimal") {
    if (field.precision == null) missing.push("precision");
    if (field.scale == null) missing.push("scale");
  }

  if (missing.length > 0) {
    return { status: "error", missing, suggestions };
  }

  if (suggestions.length > 0) {
    return { status: "suggestion", missing, suggestions };
  }

  return { status: "complete", missing: [], suggestions: [] };
}

export function getEntityCompleteness(fields: FieldInput[]) {
  if (fields.length === 0) return { complete: 0, total: 0, percentage: 0 };

  let complete = 0;
  for (const field of fields) {
    if (getFieldCompleteness(field).status === "complete") {
      complete++;
    }
  }

  return {
    complete,
    total: fields.length,
    percentage: Math.round((complete / fields.length) * 100),
  };
}

export function canEmit(fields: FieldInput[]): {
  allowed: boolean;
  incompleteCount: number;
} {
  let incompleteCount = 0;
  for (const field of fields) {
    if (getFieldCompleteness(field).status === "error") {
      incompleteCount++;
    }
  }
  return { allowed: incompleteCount === 0 && fields.length > 0, incompleteCount };
}
