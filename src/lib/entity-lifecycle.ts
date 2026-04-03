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

export {
  DATA_TYPE_HIERARCHY as FIELD_TYPES,
  ALL_DATA_TYPES as ALL_FIELD_TYPES,
} from "./data-types";
