type EntityStatus = "DRAFT" | "ACTIVE" | "DEPRECATED" | "RETIRED";

const ALLOWED_TRANSITIONS: Record<EntityStatus, EntityStatus[]> = {
  DRAFT: ["ACTIVE"],
  ACTIVE: ["DEPRECATED"],
  DEPRECATED: ["RETIRED"],
  RETIRED: [],
};

export function canTransition(
  from: EntityStatus,
  to: EntityStatus
): { allowed: boolean; reason?: string } {
  if (from === to) {
    return { allowed: false, reason: "Entity is already in this status" };
  }

  const allowed = ALLOWED_TRANSITIONS[from];
  if (allowed.includes(to)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Cannot transition from ${from} to ${to}. Allowed transitions: ${allowed.join(", ") || "none"}`,
  };
}

export function isReadOnly(status: EntityStatus): boolean {
  return status === "RETIRED";
}

export const FIELD_TYPES = {
  primitives: [
    "string", "integer", "decimal", "boolean", "text", "binary", "uuid",
  ],
  temporal: ["timestamp", "date", "time"],
  structured: ["json", "enum"],
  complex: ["array", "map", "object"],
  special: ["reference"],
} as const;

export const ALL_FIELD_TYPES = [
  ...FIELD_TYPES.primitives,
  ...FIELD_TYPES.temporal,
  ...FIELD_TYPES.structured,
  ...FIELD_TYPES.complex,
  ...FIELD_TYPES.special,
];
