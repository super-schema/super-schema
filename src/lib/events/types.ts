// src/lib/events/types.ts
/** Events core value types shared by services, actions and client components (spec §6.1). Client-safe. */
import type { ChangeKind } from "@/lib/entity-versioning/types";
import type {
  EventSpecDocument,
  JsonObject,
  JsonSchemaDialect,
  PayloadFormat,
  ResolvedChannel,
  ResolvedTrait,
  TraitKind,
} from "@/lib/event-specs/types";

export type { EventSpecDocument, JsonObject, JsonSchemaDialect, PayloadFormat, TraitKind };

export type PinRole = "payload" | "headers" | "key";
export const PIN_ROLES: readonly PinRole[] = ["payload", "headers", "key"];

/** A Message / Trait reference to an entity. `entityVersionId: null` = not pinned yet (draft preview only). */
export interface EntityPin {
  entityId: string;
  entityVersionId: string | null;
}

/** Channel.spec — AsyncAPI Channel Object minus `address` and `messages`. */
export interface ChannelSpec {
  title?: string;
  summary?: string;
  description?: string;
  parameters?: Record<string, JsonObject>;
  bindings?: JsonObject;
  tags?: JsonObject[];
  externalDocs?: JsonObject;
}

/** Message.spec — AsyncAPI Message Object fields + catalog trait ids (MESSAGE traits). */
export interface MessageSpec {
  title?: string;
  summary?: string;
  description?: string;
  contentType?: string;
  correlationId?: JsonObject;
  tags?: JsonObject[];
  externalDocs?: JsonObject;
  bindings?: JsonObject;
  examples?: JsonObject[];
  traitIds: string[];
}

/** A pin frozen into a MessageVersion. */
export interface ResolvedPin {
  entityId: string;
  entityName: string;
  entityVersionId: string;
  label: string;
  major: number;
}

/** MessageVersion.resolvedSpec. */
export interface MessageResolvedSpec {
  name: string;
  spec: MessageSpec;
  payload: ResolvedPin;
  headers: ResolvedPin | null;
  key: ResolvedPin | null;
}

/** Trait row data frozen into an EventSpecVersion (rendered headers live in the stored document — D7). */
export type FrozenTrait = Omit<ResolvedTrait, "headers"> & {
  headersEntityId: string | null;
  headersEntityVersionId: string | null;
};

export type FrozenChannel = ResolvedChannel;

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

export interface ChannelDetail extends LevelColumns {
  id: string;
  name: string;
  address: string | null;
  protocol: string;
  format: PayloadFormat;
  formatDialect: JsonSchemaDialect | null;
  spec: ChannelSpec;
  allowedMessageIds: string[];
}

export interface TraitDetail extends LevelColumns {
  id: string;
  name: string;
  kind: TraitKind;
  spec: JsonObject;
  headers: EntityPin | null;
}

export interface MessageDetail extends LevelColumns {
  id: string;
  name: string;
  spec: MessageSpec;
  payload: EntityPin;
  headers: EntityPin | null;
  key: EntityPin | null;
  latestVersionLabel: string | null;
  hasUnpublishedChanges: boolean;
}

export interface EventSpecDetail extends LevelColumns {
  id: string;
  name: string;
  specType: string;
  document: EventSpecDocument;
  latestVersionLabel: string | null;
  hasUnpublishedChanges: boolean;
}

export interface CatalogListItem {
  id: string;
  name: string;
  summary: string;
  /** ISO-8601 */
  updatedAt: string;
}
export interface ChannelListItem extends CatalogListItem {
  address: string | null;
  protocol: string;
  format: PayloadFormat;
}
export interface MessageListItem extends CatalogListItem {
  latestVersionLabel: string | null;
  hasUnpublishedChanges: boolean;
  payloadEntityName: string;
}
export interface EventSpecListItem extends CatalogListItem {
  latestVersionLabel: string | null;
  hasUnpublishedChanges: boolean;
  operationCount: number;
}
export interface TraitListItem extends CatalogListItem {
  kind: TraitKind;
}
/** A list item with its canonical URL (computed server-side with assetHref). */
export type Linked<T> = T & { href: string };
