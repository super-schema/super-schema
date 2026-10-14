import { ok, err, type Result } from "@/types/result";

export type AssetLevel = "TENANT" | "DOMAIN" | "PRODUCT";
export type LevelKind = "dataType" | "entity" | "api" | "trait" | "message" | "channel" | "eventSpec";

export interface LevelScope {
  tenantId: string;
  domainId: string | null;
  productId: string | null;
}

/** Spec §4.1 placement matrix. */
export const ALLOWED_LEVELS: Record<LevelKind, readonly AssetLevel[]> = {
  dataType: ["TENANT", "DOMAIN", "PRODUCT"],
  entity: ["TENANT", "PRODUCT"],
  api: ["DOMAIN", "PRODUCT"],
  trait: ["TENANT", "DOMAIN", "PRODUCT"],
  message: ["PRODUCT"],
  channel: ["PRODUCT"],
  eventSpec: ["PRODUCT"],
};

const KIND_LABELS: Record<LevelKind, string> = {
  dataType: "Data Type",
  entity: "Entity",
  api: "API",
  trait: "Trait",
  message: "Message",
  channel: "Channel",
  eventSpec: "Event Spec",
};

const LEVEL_LABELS: Record<AssetLevel, string> = { TENANT: "Enterprise", DOMAIN: "Domain", PRODUCT: "Product" };

export function kindLabel(kind: LevelKind): string {
  return KIND_LABELS[kind];
}

export function levelLabel(level: AssetLevel): string {
  return LEVEL_LABELS[level];
}

export function levelOf(scope: { domainId: string | null; productId: string | null }): AssetLevel {
  if (scope.productId) return "PRODUCT";
  if (scope.domainId) return "DOMAIN";
  return "TENANT";
}

export function validateScope(kind: LevelKind, scope: LevelScope): Result<LevelScope> {
  if (scope.productId && !scope.domainId) {
    return err({
      code: "INVALID_SCOPE",
      message: "A product-level item must also carry its product's domain.",
    });
  }
  const level = levelOf(scope);
  if (!ALLOWED_LEVELS[kind].includes(level)) {
    return err({
      code: "INVALID_SCOPE",
      message: `${KIND_LABELS[kind]} cannot be defined at ${LEVEL_LABELS[level]} level.`,
      suggestedFix: `Allowed levels: ${ALLOWED_LEVELS[kind].map((l) => LEVEL_LABELS[l]).join(", ")}.`,
    });
  }
  return ok(scope);
}
