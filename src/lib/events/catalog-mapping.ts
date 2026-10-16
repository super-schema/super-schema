import type { ResolvedTrait, SchemaArtifact, TraitKind } from "@/lib/event-specs/types";
import type { ArtifactSubject } from "@/services/events/artifact-renderer";
import { isJsonObject } from "./inputs";
import type { FrozenTrait } from "./types";

/** A library trait row as read with `TRAIT_SELECT` (src/services/events/event-snapshot.ts): its owner's slugs label it. */
export interface TraitRow {
  id: string;
  name: string;
  kind: TraitKind;
  spec: unknown;
  headersEntityId: string | null;
  headersEntityVersionId: string | null;
  tenant: { slug: string };
  domain: { slug: string } | null;
  product: { slug: string } | null;
}

export function toFrozenTrait(row: TraitRow): FrozenTrait {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    ownerSlug: row.product?.slug ?? row.domain?.slug ?? row.tenant.slug,
    spec: isJsonObject(row.spec) ? row.spec : {},
    headersEntityId: row.headersEntityId,
    headersEntityVersionId: row.headersEntityVersionId,
  };
}

/** What renders a trait's headers: the pinned entity version, or the entity's current draft when it is not pinned (null = no headers entity). */
export function traitHeadersSubject(t: FrozenTrait): ArtifactSubject | null {
  if (!t.headersEntityId) return null;
  return t.headersEntityVersionId
    ? { kind: "version", entityVersionId: t.headersEntityVersionId }
    : { kind: "draft", entityId: t.headersEntityId };
}

export function toResolvedTrait(t: FrozenTrait, headers?: SchemaArtifact): ResolvedTrait {
  const resolved: ResolvedTrait = { id: t.id, name: t.name, kind: t.kind, ownerSlug: t.ownerSlug, spec: t.spec };
  if (headers) resolved.headers = headers;
  return resolved;
}
