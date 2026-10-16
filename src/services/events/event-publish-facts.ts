// src/services/events/event-publish-facts.ts
// The facts one publish plan is computed from (spec 2026-10-15-events-self-contained-design §5 / §10): is there anything to publish,
// what blocks it without needing an emission, what the bump classifier compares, which entities the write must lock. Reads only.
// `publishEvent` gathers them twice — once to plan, once more under the locks — and refuses to write when the two differ.
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import { stableStringify, type BumpTraitHeadersPin } from "@/lib/events/bump-rules";
import { toFrozenTrait } from "@/lib/events/catalog-mapping";
import type { EventBumpPinFact, EventBumpSide } from "@/lib/events/document/bump";
import { collectDocumentRefs, collectPinSites, type PinSite } from "@/lib/events/document/edges";
import { parseEventDocument } from "@/lib/events/document/parse";
import { effectiveRepresentationFormats } from "@/lib/events/document/representation";
import type { EventDocument } from "@/lib/events/document/types";
import { isJsonObject } from "@/lib/events/inputs";
import type { EventPublishBlocker, LatestVersion } from "@/lib/events/publish-plan";
import type { FrozenTrait } from "@/lib/events/types";
import { ok, err, type Result } from "@/types/result";
import { TRAIT_SELECT, type EventSnapshot } from "./event-snapshot";

type Db = PrismaClient | Prisma.TransactionClient;

export interface PublishFacts {
  latest: LatestVersion | null;
  /** The document differs from the latest version's source, or a library trait that version froze has drifted (edited or gone). */
  hasChanges: boolean;
  previous: EventBumpSide | null;
  current: EventBumpSide;
  /** Every blocker that does not need an emission: unpinned pins, missing entity versions. */
  blockers: EventPublishBlocker[];
  /** False when a pin has no facts or is unpinned: the bump cannot be classified yet (planner input `bump: null`). */
  classifiable: boolean;
  /** Entity ids to lock FOR SHARE, sorted and unique: every pinned entity of the document and of its library traits' header pins. */
  lockEntityIds: string[];
}

const isNullableString = (value: unknown): value is string | null => value === null || typeof value === "string";
const unique = (ids: Array<string | null | undefined>): string[] => [...new Set(ids.filter((id): id is string => typeof id === "string"))];

/** The stored `frozenTraits` column as traits, or null when it is anything but an array of well-formed ones (never cast blindly). */
function parseFrozenTraits(value: unknown): FrozenTrait[] | null {
  if (!Array.isArray(value)) return null;
  const traits: FrozenTrait[] = [];
  for (const item of value) {
    if (!isJsonObject(item)) return null;
    const { id, name, kind, ownerSlug, spec, headersEntityId, headersEntityVersionId } = item;
    if (typeof id !== "string" || typeof name !== "string" || (kind !== "MESSAGE" && kind !== "OPERATION") || typeof ownerSlug !== "string") return null;
    if (!isJsonObject(spec) || !isNullableString(headersEntityId) || !isNullableString(headersEntityVersionId)) return null;
    traits.push({ id, name, kind, ownerSlug, spec, headersEntityId, headersEntityVersionId });
  }
  return traits;
}

/** What a library trait's frozen copy is compared by: everything that is stored about it except its owner label. */
const fingerprint = (t: FrozenTrait): string =>
  stableStringify({ name: t.name, kind: t.kind, spec: t.spec, headersEntityId: t.headersEntityId, headersEntityVersionId: t.headersEntityVersionId });

export async function gatherPublishFacts(db: Db, snapshot: EventSnapshot): Promise<Result<PublishFacts>> {
  const { document, latest, event } = snapshot;

  // ── the previous side: parsed from what was stored, or DATA_CORRUPT — never guessed ──
  let previousDocument: EventDocument | null = null;
  let frozen: FrozenTrait[] = [];
  if (latest) {
    const named = `version ${formatVersionLabel(latest)} of event "${event.id}"`;
    const parsed = parseEventDocument(latest.sourceDocument);
    if (!parsed.success) {
      return err({ code: "DATA_CORRUPT", message: `The stored source document of ${named} is not a valid event document (v2)`, details: parsed.error.details });
    }
    const traits = parseFrozenTraits(latest.frozenTraits);
    if (!traits) return err({ code: "DATA_CORRUPT", message: `The frozen library traits of ${named} are not valid` });
    previousDocument = parsed.data;
    frozen = traits;
  }

  const currentSites = collectPinSites(document);
  const previousSites = previousDocument ? collectPinSites(previousDocument) : [];
  const currentLibrary = snapshot.libraryTraits;
  const lockEntityIds = unique([...currentSites.map((s) => s.pin.entityId), ...[...currentLibrary.values()].map((t) => t.headersEntityId)]).sort();
  const versionIds = unique([
    ...currentSites.map((s) => s.pin.entityVersionId), ...previousSites.map((s) => s.pin.entityVersionId),
    ...[...currentLibrary.values()].map((t) => t.headersEntityVersionId), ...frozen.map((t) => t.headersEntityVersionId),
  ]);
  const previousExternalIds = previousDocument ? collectDocumentRefs(previousDocument).externalVersionIds : [];
  const { tenantId } = event;

  // Every read is tenant-filtered like the snapshot's: another tenant's entity or version reads exactly like a missing one.
  const [versionRows, entityRows, liveTraitRows, externalRows] = await Promise.all([
    versionIds.length > 0
      ? db.entityVersion.findMany({
          where: { id: { in: versionIds }, entity: { tenantId } },
          select: { id: true, entityId: true, major: true, minor: true, entity: { select: { name: true } } },
        })
      : [],
    lockEntityIds.length > 0 ? db.entity.findMany({ where: { id: { in: lockEntityIds }, tenantId }, select: { id: true, name: true } }) : [],
    frozen.length > 0 ? db.trait.findMany({ where: { id: { in: frozen.map((t) => t.id) }, tenantId }, select: TRAIT_SELECT }) : [],
    previousExternalIds.length > 0
      ? db.eventSpecVersion.findMany({ where: { id: { in: previousExternalIds }, eventSpec: { tenantId } }, select: { id: true, major: true } })
      : [],
  ]);
  const versionById = new Map(versionRows.map((r) => [r.id, r]));
  const entityName = new Map(entityRows.map((e) => [e.id, e.name]));
  const liveTraits = new Map(liveTraitRows.map((row) => [row.id, toFrozenTrait(row)]));

  /** The version row a pin names, only when it really is a version of that entity. */
  const versionOf = (entityId: string, versionId: string | null) => {
    const row = versionId === null ? undefined : versionById.get(versionId);
    return row && row.entityId === entityId ? row : undefined;
  };
  // `Object.fromEntries` defines own properties: an id like "__proto__" can never reach a prototype.
  const pinsOf = (sites: PinSite[]): Record<string, EventBumpPinFact> =>
    Object.fromEntries(
      sites.flatMap(({ pin }): Array<[string, EventBumpPinFact]> => {
        const row = versionOf(pin.entityId, pin.entityVersionId);
        return row && pin.entityVersionId ? [[pin.entityVersionId, { entityId: row.entityId, entityName: row.entity.name, label: formatVersionLabel(row), major: row.major }]] : [];
      })
    );
  /** What a library trait's headers pin identifies. A version that no longer resolves leaves major / label unknown, never MAJOR. */
  const headersPin = (trait: FrozenTrait): BumpTraitHeadersPin | null => {
    if (!trait.headersEntityId) return null;
    const row = versionOf(trait.headersEntityId, trait.headersEntityVersionId);
    const name = row?.entity.name ?? entityName.get(trait.headersEntityId);
    return {
      entityId: trait.headersEntityId, ...(name !== undefined && { entityName: name }), entityVersionId: trait.headersEntityVersionId,
      major: row?.major ?? null, label: row ? formatVersionLabel(row) : null,
    };
  };

  // ── blockers: every pin that cannot be published, all at once ──
  const blockers: EventPublishBlocker[] = [];
  for (const { pointer, pin } of currentSites) {
    const name = entityName.get(pin.entityId) ?? `Entity "${pin.entityId}"`;
    if (pin.entityVersionId === null) {
      blockers.push({ kind: "UNPUBLISHED_PIN", pointer, message: `${name} has no published version pinned` });
    } else if (!versionOf(pin.entityId, pin.entityVersionId)) {
      blockers.push({ kind: "MISSING_ENTITY", pointer, message: `"${pin.entityVersionId}" is not a published version of ${name}` });
    }
  }

  const sideOf = (doc: EventDocument, sites: PinSite[], library: Array<[string, FrozenTrait]>, externalMajors: Record<string, number>): EventBumpSide => ({
    doc,
    pins: pinsOf(sites),
    libraryHeaders: Object.fromEntries(library.map(([id, trait]) => [id, headersPin(trait)])),
    externalMajors,
    representations: effectiveRepresentationFormats(doc, snapshot.entityFormats),
  });
  const current = sideOf(document, currentSites, [...currentLibrary], snapshot.externalMajors);
  const previous = previousDocument
    ? sideOf(previousDocument, previousSites, frozen.map((t): [string, FrozenTrait] => [t.id, t]), Object.fromEntries(externalRows.map((r) => [r.id, r.major])))
    : null;

  // ── has anything changed? the document, or a library trait that the latest version froze (spec §5: a library edit is a change) ──
  const drifted = frozen.some((t) => {
    const live = liveTraits.get(t.id);
    return !live || fingerprint(live) !== fingerprint(t);
  });
  const hasChanges = previousDocument === null || stableStringify(document) !== stableStringify(previousDocument) || drifted;

  return ok({
    latest: latest ? { major: latest.major, minor: latest.minor, sequence: latest.sequence } : null,
    hasChanges,
    previous,
    current,
    blockers,
    classifiable: blockers.length === 0,
    lockEntityIds,
  });
}
