// src/lib/events/ownership.ts
import { ok, err, type Result } from "@/types/result";
import { levelLabel, levelOf, type LevelScope } from "@/lib/levels";

/** Spec §10: writes to another level's / product's records return FORBIDDEN (cross references are read-only). */
export function assertOwnedBy(record: LevelScope, owner: LevelScope, label: string): Result<void> {
  if (record.tenantId === owner.tenantId && record.domainId === owner.domainId && record.productId === owner.productId) {
    return ok(undefined);
  }
  return err({
    code: "FORBIDDEN",
    message: `${label} is owned by another ${levelLabel(levelOf(record))} scope and is read-only here.`,
    suggestedFix: "Open it from its owning level to edit it.",
  });
}
