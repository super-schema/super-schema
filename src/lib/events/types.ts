// src/lib/events/types.ts
/** Events value types shared by services, actions and client components (spec §6.1). Client-safe. */
import type { ChangeKind } from "@/lib/entity-versioning/types";
import type { JsonObject, JsonSchemaDialect, PayloadFormat, ResolvedTrait, TraitKind } from "@/lib/event-specs/types";

export type { JsonObject, JsonSchemaDialect, PayloadFormat, TraitKind };

export type PinRole = "payload" | "headers" | "key";
export const PIN_ROLES: readonly PinRole[] = ["payload", "headers", "key"];

/** A message / trait reference to an entity. `entityVersionId: null` = not pinned yet (draft preview only). */
export interface EntityPin {
  entityId: string;
  entityVersionId: string | null;
}

/** A pin frozen into a published version (the bump rules compare these). */
export interface ResolvedPin {
  entityId: string;
  entityName: string;
  entityVersionId: string;
  label: string;
  major: number;
}

/** Trait row data frozen into an EventSpecVersion (rendered headers live in the stored document — D7). */
export type FrozenTrait = Omit<ResolvedTrait, "headers"> & {
  headersEntityId: string | null;
  headersEntityVersionId: string | null;
};

export interface EventVersionSummary {
  id: string;
  major: number;
  minor: number;
  /** "2.1" */
  label: string;
  sequence: number;
  changeKind: ChangeKind;
  changeSummary: string | null;
  publishedByName: string | null;
  /** ISO-8601 */
  publishedAt: string;
}

interface LevelColumns {
  tenantId: string;
  domainId: string | null;
  productId: string | null;
}

export interface TraitDetail extends LevelColumns {
  id: string;
  name: string;
  kind: TraitKind;
  spec: JsonObject;
  headers: EntityPin | null;
}

export interface CatalogListItem {
  id: string;
  name: string;
  summary: string;
  /** ISO-8601 */
  updatedAt: string;
}
export interface TraitListItem extends CatalogListItem {
  kind: TraitKind;
}
/** A list item with its canonical URL (computed server-side with assetHref). */
export type Linked<T> = T & { href: string };
