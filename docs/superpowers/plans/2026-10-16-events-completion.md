# Events Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build everything the Events work still lacks (REVIEW.md §6): publish with versions and a Used-by view, external references between events, editing a product's contacts, an in-app unsaved-changes guard, and the small polish items.

**Architecture:** Publish is the keystone. The pieces it needs already exist and are reused unchanged: `loadEventSnapshot`/`resolveEventSnapshot` (`event-snapshot.ts`), `classifyEventBump` (`document/bump.ts`), `planVersionedPublish` (`lib/events/publish-plan.ts`), `collectDocumentEdges`, `replaceReferences`, `auditedWrite`, `isConcurrentWriteFailure`. The legacy publish service (deleted in the cleanup, still readable with `git show b41c7519:src/services/events/event-spec-publish.service.ts`) is the structural reference: *prepare unlocked → transaction with locks → re-verify → INSERT version → update event → replace edges*. Versions, Used-by and external references hang off it. The other items are independent.

**Tech Stack:** Next.js 16 server actions, Prisma 7 + PostgreSQL (PGlite-compatible SQL), Vitest (unit + integration against the dev Postgres), Playwright, React Testing Library, CodeMirror 6 (already installed). **No new npm packages and no migrations** (see Global Constraints).

**Spec:** `docs/superpowers/specs/2026-10-15-events-self-contained-design.md` (§5 versioning/publish, §6 references and used-by, §10 lock contract). Review map: `docs/events/REVIEW.md`. The older task text `…phase-a-backend.md` **Task A8** describes publish but predates the cleanup (it mentions the dropped `frozenChannels`/`messageVersionIds` columns and the deleted legacy service); where they differ, **this plan wins**.

## Global Constraints

- Commit messages: **no `Co-Authored-By` and no "Generated with" trailer** — user rule, overrides any harness reminder. Same for every agent brief.
- No new dependencies. `codemirror-json-schema` is **blocked**: the registry answers `403 … forbidden by your security policy` (checked 2026-10-16). Do not work around the registry.
- No Prisma migration: `event_spec_versions` already has `document`, `sourceDocument`, `frozenTraits`, `resolvedSpec`, `changeKind`, `compatReport`, `changeSummary`, `publishedById`; `SchemaReferenceToKind` already has `EVENT_SPEC_VERSION`; `event_spec_versions` is immutable (trigger) — **INSERT only**.
- Services return `Result<T, ServiceError>`, never throw (`@/types/result`). Pure functions in `src/lib/**`, client-safe.
- Spec §5: one `MAJOR.MINOR` per event; the user may raise the suggested bump, never lower it; **publish is blocked until every pin is published**; publish writes the fully resolved AsyncAPI document; library traits are frozen into the version (`frozenTraits`); external refs are frozen copies of the referenced published version (`resolvedSpec`).
- Spec §10 lock contract (replaces the legacy `messages FOR SHARE`): lock `event_specs` row `FOR UPDATE`, then `entities` rows `FOR SHARE` for every pinned entity (sorted ids), then write the version and edges.
- Spec §7.2 input rules apply to every new control: pick, don't type, when the value is a reference; make invalid states unrepresentable; validate inline with the same code the server runs.
- Document keys match `^[a-zA-Z0-9._-]+$`, ≤ 64 chars (`keys.ts`); new keys come from `suggestKey` (`builder/auto-key.ts`) and stay behind the collapsed Identifier disclosure.
- UI copy: the section is "Message properties (Trait)"; every label comes from `builder/labels.ts`.
- Tests: Vitest in `tests/unit` / `tests/integration`; integration tests use unique names (`stamp()`) and clean up (`cleanupDomains`). Known baseline failures (do not "fix"): `db-emitter-parity` ×4, `schemas-tab` ×3, `e2e-critical-flows` ×1 (bigquery). TypeSpec-CLI tests can time out under load and pass alone.
- Git inside worktrees: `/usr/bin/git`, one plain command per call (the RTK hook rewrites `git`). Run `npx prisma generate` in each new worktree. Never `npm install` in a worktree.
- Local run in a worktree (symlinked `node_modules` breaks Turbopack): `npx next build --webpack`, then `AUTH_TRUST_HOST=true npx next start -p 3000`. In the main checkout `npm run dev` works.
- zsh: never name a shell variable `path`.

## Review Focus

Inputs and conditions the spec implies but no obvious test covers, most likely to bite first. Each has a named test in the owning work package.

1. **Save racing publish.** A save landing between publish's read and its write must not publish a document that no longer matches the draft. Expect a retryable `CONFLICT`, never a version whose edges differ from its document (WP-P1).
2. **Publish with a pin that went away.** An entity version missing, or a pin still unpinned: publish lists *every* blocker with its JSON pointer instead of failing on the first (WP-P1).
3. **Library trait edited after publish.** That is a change (publish is allowed, not `NO_CHANGES`), the published version keeps its frozen copy, and deleting a library trait that a published version froze stays blocked (WP-P1).
4. **External reference whose source moves on.** A published event publishes a major or drops the referenced item: the referencing event must not change silently; it shows "newer version available", and an update that would drop an item an operation uses is refused (WP-X1/X2).
5. **Leaving with unsaved edits** by link click, sidebar click, Back button and tab close; and a *failed* Save in the dialog keeps the user on the page with the error visible (WP-G).
6. **Contacts edit:** clearing a field really clears it, `Name <email>` is stored canonically, an invalid email keeps the dialog open, no other product field is touched (WP-C).
7. **Self-reference.** An event can never reference itself: the server already rejects it; the picker must not even offer the event (WP-X2).

## State today (verified 2026-10-16)

| Area | Exists | Missing |
|---|---|---|
| Publish | snapshot (`latest`, `external`, `externalMajors`), `classifyEventBump`, `planVersionedPublish`, edges, guards, `emitEventStoredVersion`, shared `PublishVersionButton` + `PublishEntityDialog`, `EventVersionList`, `VERSION_SUMMARY_SELECT` | `event-publish.service.ts`, actions, Publish button, Versions tab |
| Used by | `findEventVersionReferrers` (guard), `UsedByPanel` (entity-only), `findUsages` | event subject, tab |
| External refs | parse, resolve, snapshot (reads stored `resolvedSpec`), edges, server validation (published, same tenant, not self, item exists), delete guard, builder pickers already list refs as "(external)" | loaders, picker + manage UI, "newer version" status |
| Contacts | `ProductContactFields`, `ProductContacts` (display), `updateProductAction` + service | any edit entry point |
| Leave guard | `beforeunload` in `use-event-draft.ts` | in-app navigation guard |

## Decisions to confirm (defaults are what this plan builds)

1. **Event page tabs:** `Design | Docs | Versions | Used by`. The spec's "Source" tab is dropped: the Code panel is the live source, and *Versions → View* shows a published version's code.
2. **Publish cuts from the saved draft only.** The Publish button is disabled while the builder has unsaved edits (tooltip "Save your changes first"). No auto-save-then-publish.
3. **External refs:** any *published* event of the tenant except itself (same or another product), pinned to one version; updating to a newer version is always manual.
4. **Leave dialog** offers *Save & leave / Discard & leave / Stay*. It uses the Navigation API where the browser has it (Chromium), with a link-click + Back-button fallback elsewhere; a programmatic `router.push` is only caught on the Navigation API path.
5. **Governance** for MAJOR publishes is not wired for events (it never was in the legacy service); `governanceRequestId` stays unused.
6. **Data change that needs your yes:** re-point `checkout-event` from the old `CloudEvents-legacy` library trait to the built-in CloudEvents, then delete the legacy trait and the `CloudEventsHeaders` entity (WP-D).

## Work packages and order

| WP | What | Depends on | Wave |
|---|---|---|---|
| P1 | Publish service (backend) | — | 1 |
| U1 | Used-by service for events (backend) | — | 1 |
| X1 | External-reference loaders and status (backend) | — | 1 |
| C | Edit product contacts | — | 1 |
| L | Polish: sticky Save bar, wording, legacy pinned-headers note | — | 1 |
| P2 | Publish button, Versions tab, Used-by tab, delete-confirm text | P1, U1 | 2 |
| X2 | External-reference UI (picker + manage cards + status badge) | X1 | 2 |
| G | In-app unsaved-changes guard | P2 (same page file) | 3 |
| J | Optional: dependency-free schema lint for JSON fields | — | 3 (optional) |
| D | Data re-point (needs your yes), docs, memory, full verification, merge | all | 3 |

Wave 1 packages touch disjoint files and run in parallel (one Sonnet agent per package, each in its own worktree; the controller merges). `EventPage.tsx` is edited by P2 and G only, which is why G waits for P2. `EventBuilder.tsx` is edited by L (padding) and X2 (cards live in the section files, not the shell), so conflicts are limited to import lines.

---

## WP-P1: Publish service

**Files:**
- Create: `src/services/events/event-publish-facts.ts`, `src/services/events/event-publish.service.ts`
- Modify (additive): `src/services/events/event-snapshot.ts` (the `latest` select/type gains `sequence` and `frozenTraits`), `src/lib/events/document/edges.ts` (export `collectPinSites(doc)`), `src/services/events/event.service.ts` (import `collectPinSites` instead of its private `pinSites`)
- Test: `tests/integration/services/events/event-publish.service.test.ts`, `tests/unit/lib/events/document/pin-sites.test.ts`

**Interfaces:**
- Consumes: `loadEventSnapshot`, `resolveEventSnapshot`, `EventSnapshot` (`event-snapshot.ts`); `emitResolved`, `EmitDeps` (`event-emit.service.ts`); `classifyEventBump`, `EventBumpSide` (`document/bump.ts`); `analyzeVersionedPublish`, `planVersionedPublish`, `provisionalLabel`, `EventPublishBlocker`, `EventPublishAnalysis`, `VersionedPublishInput`, `LatestVersion` (`lib/events/publish-plan.ts`); `collectDocumentEdges`, `collectDocumentRefs` (`document/edges.ts`); `effectiveRepresentationFormats` (`document/representation.ts`); `replaceReferences`; `auditedWrite`; `isConcurrentWriteFailure`; `toEventVersionSummary`, `VERSION_SUMMARY_SELECT`; `PublishInput`, `isBumpKind` (`@/lib/entity-versioning/types`); `stableStringify` (`lib/events/bump-rules.ts`); `formatVersionLabel`.
- Produces:

```ts
// event-publish-facts.ts
export interface PublishFacts {
  latest: LatestVersion | null;               // { major, minor, sequence }
  hasChanges: boolean;                        // document != latest.sourceDocument, or a frozen library trait drifted
  previous: EventBumpSide | null;
  current: EventBumpSide;
  /** Every blocker that does not need an emission: unpinned pins, missing entity versions. */
  blockers: EventPublishBlocker[];
  /** False when a pin has no facts or is unpinned: the bump cannot be classified yet (planner input `bump: null`). */
  classifiable: boolean;
  /** Entity ids to lock FOR SHARE, sorted and unique: every pinned entity of the document and of its library traits' header pins. */
  lockEntityIds: string[];
}
export function gatherPublishFacts(db: Db, snapshot: EventSnapshot): Promise<Result<PublishFacts>>;

// event-publish.service.ts
export function previewEventPublish(eventId: string, productId: string, ctx: ServiceContext, deps?: EmitDeps): Promise<Result<EventPublishAnalysis>>;
export function publishEvent(eventId: string, productId: string, input: PublishInput, ctx: ServiceContext, deps?: EmitDeps): Promise<Result<EventVersionSummary>>;
export function listEventVersions(eventId: string, productId: string, ctx: ServiceContext): Promise<Result<EventVersionSummary[]>>;
```

**Behavior — facts (`gatherPublishFacts`):**
- *Pins:* `collectPinSites(doc)` returns `{ pointer, pin: EntityPin }[]` (same sites as `collectDocumentEdges`: message payload / headers / keyPin and local-trait headers). For the current document and for `latest.sourceDocument` (parse it with `parseEventDocument`; if it does not parse return `DATA_CORRUPT` — never guess) load `entityVersion.findMany({ where: { id: { in } }, select: { id, entityId, major, minor, entity: { select: { name } } } })` once for both sides → `pins[versionId] = { entityId, entityName, label: formatVersionLabel(row), major }`.
- *Blockers:* a site with `pin.entityVersionId === null` → `{ kind: "UNPUBLISHED_PIN", pointer, message: "<entity name> has no published version pinned" }`; a non-null version id with no row, or whose row belongs to another entity → `{ kind: "MISSING_ENTITY", pointer, message }`. All reported together. `classifiable = blockers.length === 0`.
- *Library headers:* for the current document use `snapshot.libraryTraits` (by id); for the previous side use `latest.frozenTraits`. A trait with `headersEntityId` becomes `BumpTraitHeadersPin { entityId, entityName, entityVersionId, major, label }` (look the version up in the same query as the pins); a trait with inline headers (all built-ins) is `null`.
- *External majors:* `snapshot.externalMajors` for the current side; for the previous side query `eventSpecVersion.findMany({ where: { id: { in: previousExternalIds } }, select: { id, major } })`.
- *Representations:* `effectiveRepresentationFormats(doc, snapshot.entityFormats)` for both sides (known limitation: a format change that comes only from an entity's recorded source format moves with its pin and is classified through the pin).
- *hasChanges:* `latest === null` → true; otherwise `stableStringify(document) !== stableStringify(latest.sourceDocument)` **or** library drift: for every `FrozenTrait` in `latest.frozenTraits`, the live `trait` row (same id, same tenant) is missing or `stableStringify({ name, kind, spec, headersEntityId, headersEntityVersionId })` differs. Read the live rows with `TRAIT_SELECT` + `toFrozenTrait` (the same mapping the snapshot uses).
- No `NAME_CONFLICT` check: event names are enforced at create/rename; that blocker kind stays unused in v2.

**Behavior — service:**
- `prepare(db, eventId, requested, ctx, deps)` (unlocked, writes nothing): snapshot → facts → `base: VersionedPublishInput = { latest, hasChanges, blockers: facts.blockers, bump: facts.classifiable && facts.previous ? classifyEventBump(facts.previous, facts.current) : null }` → label = `planVersionedPublish(base, requested)` label, else `provisionalLabel(analyzeVersionedPublish(base))` → `resolveEventSnapshot(snapshot, renderer, label)` → if resolved, `emitResolved` (an adapter failure is logged and returned as the generic `GENERIC_VALIDATION_FAILURE` message under the same code, see the legacy `emitFailure`) → emission **error** diagnostics become blockers: code `UNRESOLVED_REFERENCE` → kind `UNRESOLVED_REFERENCE`, any other error → `VALIDATION_ERROR`, each with `pointer`. Final `input = { ...base, blockers: [...facts.blockers, ...diagnosticBlockers] }`.
- `previewEventPublish` = ownership check + `prepare` + `analyzeVersionedPublish(input)`. Never writes.
- `publishEvent`: validate untrusted `input` exactly as the legacy `publishEventSpec` does (`bump` must pass `isBumpKind`, `changeSummary` a string, trimmed, empty → null) → ownership (`loadOwnedRow` with `{ level: "PRODUCT", productId }`, label = caller's id, never the row's name) → `prepare` → `planVersionedPublish(input, bump)` (returns `PUBLISH_BLOCKED` with every blocker, `BUMP_TOO_LOW`, `INVALID_PLAN_INPUT`) → transaction below. Audit: `auditedWrite({ action: "PUBLISH_VERSION", entityType: "EventSpec", entityId: eventId, userId: ctx.userId, run })`.
- Transaction (single, `{ timeout: 15_000 }`):

```ts
const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "event_specs" WHERE "id" = ${eventId} FOR UPDATE`;
if (locked.length === 0) return notFound(eventId);
if (facts.lockEntityIds.length > 0) {
  // table name = the @@map of Entity in prisma/schema.prisma
  await tx.$queryRaw`SELECT "id" FROM "entities" WHERE "id" IN (${Prisma.join(facts.lockEntityIds)}) ORDER BY "id" FOR SHARE`;
}
// Re-verify under the locks: the draft, library traits, pins and facts must be exactly what the plan was computed from.
const fresh = await loadEventSnapshot(tx, eventId);
if (!fresh.success) return fresh;
const freshFacts = await gatherPublishFacts(tx, fresh.data);
if (!freshFacts.success) return freshFacts;
if (!isDeepStrictEqual(fresh.data, snapshot) || !isDeepStrictEqual(freshFacts.data, facts)) return changedDuringPublish();
const version = await tx.eventSpecVersion.create({
  data: {
    eventSpecId: eventId, major: plan.data.version.major, minor: plan.data.version.minor, sequence: plan.data.sequence,
    document: output.document as unknown as Prisma.InputJsonValue,            // the assembled AsyncAPI, info.version = label
    sourceDocument: snapshot.document as unknown as Prisma.InputJsonValue,    // the v2 draft: input of the next classification
    resolvedSpec: resolved as unknown as Prisma.InputJsonValue,               // external refs reuse this without re-rendering
    frozenTraits: [...snapshot.libraryTraits.values()] as unknown as Prisma.InputJsonValue,
    changeKind: plan.data.changeKind,
    compatReport: { reasons: plan.data.reasons, diagnostics: diagnostics.filter((d) => d.severity !== "error") } as unknown as Prisma.InputJsonValue,
    changeSummary, publishedById: ctx.userId,
  },
  select: VERSION_SUMMARY_SELECT,
});
await replaceReferences(tx, { kind: "EVENT_SPEC_VERSION", id: version.id }, collectDocumentEdges(snapshot.document), false);
await tx.eventSpec.update({ where: { id: eventId }, data: { latestVersionId: version.id, hasUnpublishedChanges: false }, select: { id: true } });
return ok(toEventVersionSummary(version));
```

  A thrown `isConcurrentWriteFailure(e)` becomes `changedDuringPublish()` (`CONFLICT`, "The event changed while publishing.", suggestedFix "Reload the event and publish again."). The draft edges (`EVENT_SPEC`, `isDraft: true`) are left as they are.
- `listEventVersions`: ownership, then `eventSpecVersion.findMany({ where: { eventSpecId }, orderBy: { sequence: "desc" }, select: VERSION_SUMMARY_SELECT })`.

- [ ] **Step 1: Write the failing tests.** Template: `tests/integration/services/events/event-emit-library-properties.test.ts` (stub `ArtifactRenderer`, `createProductScope`, `frozenEntity`, `seedEvent`, `unwrap`, `cleanupDomains`). Every test body is written in full. Cases:

```ts
it("publishes 1.0 on first publish and stores document, sourceDocument, resolvedSpec and frozenTraits", async () => {});
// asserts: version row major 1 minor 0 sequence 1 changeKind INITIAL; document.info.version === "1.0"; sourceDocument deep-equals the saved draft;
// resolvedSpec is a non-null object with channels[]/messages[]; frozenTraits holds the library traits the draft uses; event.latestVersionId set, hasUnpublishedChanges false.
it("writes EVENT_SPEC_VERSION edges for the pins and keeps the draft edges", async () => {});
it("blocks publish for an unpinned pin and for a missing entity version, naming every pointer at once", async () => {});
// two bad pins in one document -> PUBLISH_BLOCKED details.blockers has 2 entries with pointers /messages/0/payload/... and kinds UNPUBLISHED_PIN, MISSING_ENTITY.
it("blocks with VALIDATION_ERROR when the emitted AsyncAPI has validator errors", async () => {});
it("returns NO_CHANGES when nothing changed, and not after a library trait edit (drift counts as a change)", async () => {});
it("keeps the frozen library trait copy until the next publish", async () => {});
it("classifies bumps: payload pin to a new entity major -> 2.0; same-major pin move -> 1.1; docs-only edit -> 1.1", async () => {});
it("lets the user raise the bump to MAJOR but returns BUMP_TOO_LOW when lowering", async () => {});
it("publishes an event that receives a message through an external ref and freezes it in resolvedSpec", async () => {});
it("returns CONFLICT when the draft changes between prepare and the write", async () => {
  // the stub renderer's FIRST render() call performs prisma.eventSpec.update({ data: { document: changedDoc } }) — that call happens after the
  // snapshot is read and before the lock, so the re-verification must fail. Assert code CONFLICT and that no version row exists.
});
it("serializes a concurrent save and publish: published edges match the published document, draft edges match the saved one", async () => {
  // Promise.all([updateEventDocument(...), publishEvent(...)]); whichever wins, then compare schema_references with each document's collectDocumentEdges.
});
it("lists versions newest first", async () => {});
it("previewEventPublish writes nothing (no version, no audit row, event row unchanged)", async () => {});
it("rejects another product's event (FORBIDDEN) and an unknown event (NOT_FOUND) without leaking its name", async () => {});
it("maps an unexpected database failure to DB_ERROR", async () => {});
```
  Unit test `pin-sites.test.ts`: `collectPinSites` returns payload, headers, keyPin and local-trait headers pointers, and skips library traits.

- [ ] **Step 2: Run to verify they fail.** `npx vitest run tests/integration/services/events/event-publish.service.test.ts tests/unit/lib/events/document/pin-sites.test.ts` — Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** `collectPinSites` (+ switch `event.service.ts` to it), the additive snapshot change, `event-publish-facts.ts`, `event-publish.service.ts` per the behavior above.
- [ ] **Step 4: Run** the new tests plus the neighbours: `npx vitest run tests/integration/services/events tests/unit/lib/events && npx tsc --noEmit && npx eslint src/services/events src/lib/events`. Expected: PASS, 0 type errors, 0 lint errors.
- [ ] **Step 5: Commit.** `/usr/bin/git add src/services/events src/lib/events tests && /usr/bin/git commit -m "feat(events): publish self-contained events with versions, frozen traits and edges"` (no trailer).

---

## WP-U1: Used-by service for events

**Files:**
- Modify: `src/lib/events/usage.ts` (`UsageSubject` gains `{ kind: "event"; eventId: string }`, `parseUsageSubject` accepts it), `src/services/events/usage.service.ts` (`findUsages` handles it)
- Test: `tests/unit/lib/events/usage.test.ts` (extend), `tests/integration/services/events/event-usage.test.ts`

**Interfaces:** Consumes `schema_references` rows with `toKind = EVENT_SPEC_VERSION`, `findEventVersionReferrers`-style bounded queries (`event-guards.ts`, `MAX_EVENT_REFERRERS`), the existing `UsageRow` (`id, label, href, role, isDraft, target`). Produces: `findUsages({ kind: "event", eventId }, ctx, tenantId)` → rows for every event (draft edge → `isDraft: true`, published edge → the referencing version) that references **any version of this event**, tenant-scoped, bounded with the same truncation handling, own event excluded. Row label `Event <name> v<label>` / `Event <name> (draft)`, href through `assetHref({ kind: "event", … })` (existing mapping at `usage.ts:64-82`), `target` = `"<this event> v<referenced version label>"`.

- [ ] **Step 1: Write failing tests.** Unit: `parseUsageSubject` accepts `{kind:"event",eventId:"x"}`, rejects an empty id and an unknown kind. Integration (seed with `prisma.eventSpecVersion.create` + `schemaReference.createMany`, no dependency on P1): (a) referenced by a published version of another event → one published row; (b) referenced only by another event's draft → one row with `isDraft: true`; (c) the event referencing its own version is not listed; (d) another tenant's event is never listed; (e) 60 referrers → bounded list flagged truncated; (f) an event nobody references → empty list.
- [ ] **Step 2: Run, verify FAIL.** `npx vitest run tests/unit/lib/events/usage.test.ts tests/integration/services/events/event-usage.test.ts`
- [ ] **Step 3: Implement.** **Step 4: Run + `npx tsc --noEmit`.** **Step 5: Commit** `feat(events): used-by lookup for events`.

---

## WP-X1: External-reference loaders and status (backend)

**Files:**
- Create: `src/services/events/external-refs.service.ts`, `src/lib/events/external-refs.ts` (pure types + staleness helper)
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions.ts` (read actions)
- Test: `tests/integration/services/events/external-refs.service.test.ts`, `tests/unit/lib/events/external-refs.test.ts`

**Interfaces:**

```ts
// src/lib/events/external-refs.ts (client-safe)
export interface ExternalEventCandidate { eventId: string; eventName: string; domainName: string; productName: string; latestVersionId: string; latestLabel: string }
export interface ExternalVersionOption { versionId: string; label: string; publishedAt: string }   // only versions that have a resolvedSpec
export interface ExternalItemSummary { key: string; title?: string; summary?: string; description?: string }
export interface ExternalVersionItems { eventName: string; label: string; channels: ExternalItemSummary[]; messages: ExternalItemSummary[] }
export interface ExternalRefStatus {
  eventVersionId: string; eventId: string; eventName: string; label: string;
  latestVersionId: string; latestLabel: string;
  newerAvailable: boolean; newerIsMajor: boolean;
  /** Items the reference points at that the latest version no longer has (keys). */
  itemsMissingInLatest: string[];
}
export function isNewerVersion(current: { major: number; minor: number }, latest: { major: number; minor: number }): boolean;

// external-refs.service.ts — every function is tenant-scoped by `tenantId` and read-only
listExternalEventCandidates(ctx, { tenantId, excludeEventId, query?, limit? /* default 25, max 50 */ }): Promise<Result<ExternalEventCandidate[]>>;
listExternalEventVersions(ctx, { tenantId, eventId }): Promise<Result<ExternalVersionOption[]>>;                  // newest first
getExternalVersionItems(ctx, { tenantId, eventVersionId }): Promise<Result<ExternalVersionItems>>;
getExternalRefStatuses(ctx, { tenantId, refs: Array<{ eventVersionId: string; kind: "channel" | "message"; itemKey: string }> }): Promise<Result<ExternalRefStatus[]>>;
```

**Behavior:** candidates are events with a `latestVersionId` and a non-null `resolvedSpec` on that version, in the tenant, `id !== excludeEventId`, ordered by event name, searched case-insensitively on event / domain / product name. Item summaries come from the stored `resolvedSpec` (`channels[]`, `messages[]`: read `ResolvedChannel` / `ResolvedMessage` in `src/lib/event-specs/types.ts` for the fields that carry `id`, title, summary); a malformed stored value is skipped, never thrown. `getExternalRefStatuses` compares each referenced version with its event's `latestVersion`; `itemsMissingInLatest` lists ref item keys absent from the latest `resolvedSpec`. Another tenant's version reads exactly like a missing one (`NOT_FOUND`, no name leak). Read actions in `event-actions.ts` (`listExternalEventCandidatesAction`, `listExternalEventVersionsAction`, `getExternalVersionItemsAction`, `getExternalRefStatusesAction`) use the file's `readAction(productId, label, run)` and pass `excludeEventId`/`tenantId` from the authenticated context, never from the client.

- [ ] **Step 1: Write failing tests.** Seed two products with published versions directly (`prisma.eventSpecVersion.create` with a minimal `resolvedSpec` fixture; no dependency on P1). Cases: candidates exclude the event itself, unpublished events and other tenants; search narrows by name; versions list newest first and skips versions without `resolvedSpec`; items list titles/summaries and tolerates a malformed `resolvedSpec`; status says `newerAvailable` + `newerIsMajor` after a 2.0 is added, `itemsMissingInLatest` names a dropped item; a foreign tenant's version → `NOT_FOUND`; unit tests for `isNewerVersion` (1.1 vs 1.2 true, 1.2 vs 1.2 false, 1.9 vs 2.0 true).
- [ ] **Step 2: Run, verify FAIL.** `npx vitest run tests/integration/services/events/external-refs.service.test.ts tests/unit/lib/events/external-refs.test.ts`
- [ ] **Step 3: Implement.** **Step 4: Run + tsc + eslint.** **Step 5: Commit** `feat(events): loaders and status for external event references`.

---

## WP-C: Edit a product's contacts

**Files:**
- Create: `src/app/(dashboard)/schemas/[domainSlug]/components/EditProductContactsDialog.tsx`
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/domain-workspace.tsx` (an Edit button beside `<ProductContacts … />`, near line 585)
- Test: `tests/unit/components/products/edit-product-contacts-dialog.test.tsx`, `tests/integration/services/product-contacts-update.test.ts`, `tests/e2e/product-contacts.spec.ts`

**Behavior:** the dialog reuses `ProductContactFields` and `resolveProductContactsDraft` (`src/lib/product-contacts.ts`) so the checks are the create form's. First read `updateProductAction`/`updateProduct` (`product-actions.ts:91`, `product.service.ts:173`) and call them so **only the contact fields are sent** (the service must not blank the name/tier/other fields — assert that). Emptied fields are saved as cleared (`null` / `[]`), `Name <email>` is stored in its canonical form, an invalid draft keeps the dialog open with the field errors, a server error is shown, success closes the dialog, toasts, `router.refresh()`.

- [ ] **Step 1: Write failing tests.** Component: opens prefilled from the current contacts; an invalid email shows the field error and does not call the action; clearing the manager field calls the action with an empty manager; a rejected action shows the generic error and stays open. Integration: updating only contacts leaves `name`/`tier` untouched; clearing sets `null`/`[]`; `Jane Doe <jane@example.com>` is stored canonically. E2E: open a product, Edit contacts, change the lead and team emails, save, reload, see them.
- [ ] **Step 2: Run, verify FAIL.** **Step 3: Implement.** **Step 4: Run** `npx vitest run tests/unit/components/products tests/integration/services/product-contacts-update.test.ts && npx tsc --noEmit`. **Step 5: Commit** `feat(products): edit a product's contacts`.

---

## WP-L: Polish

**Files:**
- Modify: `src/features/events/builder/EventBuilder.tsx` (sticky bar), `src/lib/events/document/parse.ts` (wording), `src/features/events/builder/sections/PropertiesTable.tsx` + `PropertiesCard.tsx` (pinned-headers note)
- Test: `tests/unit/lib/events/document/parse-wording.test.ts`, `tests/unit/features/events/builder/properties-pinned-note.test.tsx`; update any existing test that pins the old strings (grep first)

**Behavior:**
1. **Sticky Save bar clipping:** `builder-bar` (`EventBuilder.tsx:141`, `sticky bottom-0`) covers the last form fields on short windows. Give the form column bottom padding equal to the bar height (use a CSS variable or `pb-24` on the section container) so the last control can always scroll clear of the bar. Verify at 1280×600 in Playwright: the last field of Messages is fully visible after scrolling.
2. **Wording:** problem messages say "trait" where the UI says "message properties": `Unknown trait "k"` → `Unknown message properties "k"` (operation: `Unknown operation properties "k"`), `Trait "k" is not a message trait` → `"k" is not a set of message properties`, `A trait needs exactly one of spec or libraryTraitId` → `Message properties need exactly one of spec or libraryTraitId`, and the duplicate-key text from `checkUnique("trait", …)`. Pointers and codes do not change. Import the nouns from `builder/labels.ts`' non-React constants if they are client/server shared; otherwise keep literals in `parse.ts` and add a test that fails if they drift from `labels.ts`.
3. **Legacy entity-pinned traits:** `PropertiesTable` shows "No properties." for a trait whose headers come from an entity pin. When `trait.headers` (a pin) is set and there are no inline properties, replace that line with `Properties come from the entity <name> v<label>.` and a link to the entity (same note `PropertiesCard` already prints at `:130`, but as the table's empty state), so a pinned trait never reads as empty.

- [ ] **Step 1: Write failing tests** (wording strings for all four messages; the pinned note renders and no "No properties." appears for a pinned trait; the padding class/variable is present on the section container). **Step 2: FAIL.** **Step 3: Implement.** **Step 4: Run** `npx vitest run tests/unit/lib/events tests/unit/features/events tests/unit/components/events && npx tsc --noEmit`. **Step 5: Commit** `fix(events): save bar no longer hides the last field; message-properties wording; pinned headers note`.

---

## WP-P2: Publish button, Versions tab, Used-by tab

**Depends on:** P1, U1.

**Files:**
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions.ts`, `src/lib/navigation/asset-href.ts` (`EVENT_TABS = ["design", "docs", "versions", "used-by"]`), `src/features/events/event-page/EventPage.tsx`, `src/features/events/shared/UsedByPanel.tsx` (accept `UsageSubject`, not only entity), `docs/events/REVIEW.md`
- Create: `src/features/events/event-page/VersionsTab.tsx`, `src/features/events/event-page/use-event-versions.ts`
- Test: `tests/unit/components/events/event-page-publish.test.tsx`, `tests/unit/components/events/versions-tab.test.tsx`, `tests/unit/lib/navigation/asset-href-event-tabs.test.ts`, `tests/e2e/events-publish.spec.ts`

**Interfaces (actions, all in `event-actions.ts`):**

```ts
export async function previewEventPublishAction(eventId: string, productId: string): Promise<ActionResult<EventPublishAnalysis>>;   // readAction
export async function publishEventAction(eventId: string, productId: string, input: PublishInput): Promise<ActionResult<EventVersionSummary>>; // runMutation + withOwnedTarget
export async function listEventVersionsAction(eventId: string, productId: string): Promise<ActionResult<EventVersionSummary[]>>;     // readAction
export async function readEventVersionAction(eventId: string, productId: string, label: string): Promise<ActionResult<{ yaml: string; json: string }>>; // readAction over emitEventStoredVersion
```

**Behavior:**
- **Publish button** in the page header, next to Code/Delete, is `PublishVersionButton` (`shared/PublishVersionButton.tsx`): `subjectName = name`, `loadPreview = () => previewEventPublishAction(event.id, productId)`, `publish = (input) => publishEventAction(event.id, productId, input)` mapped to `{ label }`, `testId="event-publish"`. `disabled` while `draft.dirty || draft.saving` (title "Save your changes first") and while `draft.problems.length > 0` (title "Fix the highlighted problems first"). After a publish the header badge shows `v<label>` (the page already does `router.refresh()`), and `event.hasUnpublishedChanges` clears the Draft badge.
- **Delete confirm text** (`EventPage.tsx:178`) says `Its draft and its published versions are removed with it.` when `event.latestVersionLabel` is set; the service still refuses with `IN_USE` while other events reference a version, and that error is shown (existing `deleteError` path).
- **Versions tab:** `use-event-versions` calls `listEventVersionsAction` when the tab opens (loading, error and empty states). `EventVersionList` (existing) lists versions; each row has a **View** button that sets `?version=<label>` and shows the stored code read-only in a `JsonEditor` (YAML/JSON toggle + Copy, same look as the code panel) loaded through `readEventVersionAction`. Selecting another version replaces it; a failed load shows the error and keeps the list.
- **Used-by tab:** `<UsedByPanel subject={{ kind: "event", eventId: event.id }} title="Used by" />`. The panel's effect key and `listUsagesAction` call become subject-generic (`key = subject.kind + ":" + id`). Empty text "No other event references this one."
- `EVENT_TABS` gets `versions` and `used-by`; keyboard navigation (`onTabKeyDown`), `TAB_LABELS` and both tab panels follow the array; old aliases stay.

- [ ] **Step 1: Write failing tests.** Page: Publish is disabled while dirty and while problems exist, enabled when clean; opening it calls the preview action and shows blockers; confirming calls the publish action with `{ bump, changeSummary }`; a failed publish shows the error and leaves the dialog open. Versions tab: lists newest first, View loads code, a failed load keeps the list. Tab helper: `?tab=versions` and `?tab=used-by` normalize; unknown still falls back to design; the four tabs cycle with arrow keys. E2E `events-publish.spec.ts` (template `tests/e2e/events-builder.spec.ts`): build a minimal event (server, channel, message with a pinned published entity, operation), Save, Publish → `v1.0` badge and Draft badge gone; edit a description, Save, Publish → suggests MINOR `1.1`; change the payload entity to another entity's major → suggestion MAJOR and the lower option is disabled; Versions tab lists `1.1` and `1.0` and View shows `info.version`; blockers list an unpinned pin.
- [ ] **Step 2: Run, verify FAIL.** **Step 3: Implement.** **Step 4: Run** unit + `npx tsc --noEmit` + `npx next build --webpack` + `AUTH_TRUST_HOST=true npx next start -p 3000` + `npx playwright test tests/e2e/events-publish.spec.ts tests/e2e/events-builder.spec.ts tests/e2e/navigation.spec.ts`. **Step 5: Commit** `feat(events): publish, versions and used-by on the event page`.

---

## WP-X2: External-reference UI

**Depends on:** X1 (and P2 only for its e2e).

**Files:**
- Create: `src/features/events/builder/sections/ExternalRefsCard.tsx`, `src/features/events/builder/sections/ExternalRefPicker.tsx`, `src/features/events/builder/use-external-ref-status.ts`
- Modify: `src/features/events/builder/sections/ChannelsSection.tsx` and `MessagesSection.tsx` (render `<ExternalRefsCard kind="channel" | "message" …/>` under the list), `src/features/events/builder/labels.ts` (strings), `src/features/events/builder/outline.ts` (counts/problem dots include refs, if the outline counts items)
- Test: `tests/unit/components/events/external-refs-card.test.tsx`, `tests/unit/components/events/external-ref-picker.test.tsx`, `tests/e2e/events-external-refs.spec.ts`

**Behavior:**
- `ExternalRefPicker` is a dialog in three steps, using the cmdk combobox pattern of `EntityPinPicker`'s neighbour (do not change `EntityPinPicker`; its test pins native selects): (1) search published events (`listExternalEventCandidatesAction`, debounced, `excludeEventId` = this event), (2) pick a version (`listExternalEventVersionsAction`, newest preselected), (3) pick the channel or message (`getExternalVersionItemsAction`; list shows key, title, summary; items already referenced by this event are disabled). Confirm appends `{ key: suggestKey(...), eventVersionId, kind, itemKey }` to `doc.externalRefs` (key unique across the event's namespace, from the item's title else its key, hidden behind `IdentifierDisclosure`).
- `ExternalRefsCard` lists this kind's refs: source event, `v<label>`, item title, an "External" badge, **Remove**, and a status line from `use-external-ref-status` (`getExternalRefStatusesAction` for all refs, refetched when the refs change): `v1.2 → v2.0 available` (major called out). **Update to v2.0** re-points `eventVersionId` to the latest version and is **refused with an inline message** when `itemsMissingInLatest` contains the item and an operation uses it; if nobody uses it the ref is removed with a note. Remove shows the impact ("Used by 2 operations") before removing; removing a ref an operation uses also removes it from that operation's `messageKeys`/`channelKey` only after the user confirms.
- Empty state: one primary action "Add from another event". The Operations section needs no change (`references.ts` already offers refs as "(external)").
- The instant code omits external refs (`instant-asyncapi.ts` `withoutExternalRefs`, reports an info diagnostic); the server-enriched code includes them. Add a visible hint in the code panel's diagnostics when refs exist and the enriched render has not arrived yet — read `use-event-code.ts` first; if the existing diagnostics already say so, only assert it in a test.

- [ ] **Step 1: Write failing tests.** Picker: search calls the action with the query and `excludeEventId`, the event itself never appears, a version step defaults to newest, already-referenced items are disabled, confirm adds a ref with a unique generated key. Card: renders status badge, Update re-points and refuses when an operation uses a dropped item, Remove shows the impact. E2E `events-external-refs.spec.ts`: product A publishes event "orders" (message `OrderCreated`); product B builds event "billing", adds the external message from "orders", adds a receive operation using it, Save → no problems, Code panel (server render) contains the `$ref`/message; A edits and publishes 2.0 → B shows "v1.0 → v2.0 available"; B's delete of its own event is allowed, A's delete is refused with the "referenced by billing" message.
- [ ] **Step 2: Run, verify FAIL.** **Step 3: Implement.** **Step 4: Run** unit + tsc + build + the three e2e specs. **Step 5: Commit** `feat(events): add and manage external event references`.

---

## WP-G: In-app unsaved-changes guard

**Depends on:** P2 (it edits `EventPage.tsx`).

**Files:**
- Create: `src/features/events/builder/use-leave-guard.ts`, `src/features/events/builder/UnsavedChangesDialog.tsx`
- Modify: `src/features/events/event-page/EventPage.tsx` (call the hook, render the dialog), `src/features/events/builder/use-event-draft.ts` (keep `beforeunload`; no change to its API)
- Test: `tests/unit/features/events/builder/use-leave-guard.test.tsx`, `tests/unit/components/events/unsaved-changes-dialog.test.tsx`, `tests/e2e/events-leave-guard.spec.ts`

**Interfaces:**

```ts
export interface PendingLeave { destination: string; proceed(): void; stay(): void }
/** `dirty` false → no listeners and `pending` stays null. */
export function useLeaveGuard(dirty: boolean): { pending: PendingLeave | null };
```

**Behavior:** while `dirty`, intercept leaving the page:
- *Navigation API path* (`window.navigation` present): a `navigate` listener cancels (`e.preventDefault()`) cancelable navigations, **except** `navigationType === "replace"` and any destination with the same pathname as the current one (the page itself rewrites `?tab=/?section=` with `history.replaceState`, and tab/section switches must never prompt), hash-only changes and downloads. It records the destination as `pending`; `proceed()` removes the guard and runs `router.push(destination)` (or `history.back()` for a `traverse` to an earlier entry); `stay()` clears `pending`.
- *Fallback* (no Navigation API): a capture-phase `click` listener on `document` for same-origin `a[href]` (ignoring modified clicks, `target`, `download`, same-pathname, hash-only), and a `popstate` guard (push one sentinel history entry while dirty; on `popstate` re-push it and set `pending` to the previous entry). Programmatic `router.push` is not covered here (documented).
- `UnsavedChangesDialog({ pending, saving, error, onSaveAndLeave, onDiscardAndLeave, onStay })`: **Save & leave** awaits `draft.save()`, then `pending.proceed()` only if it returned `true`; on failure the dialog stays open with `error` visible and the user stays on the page; **Discard & leave** calls `draft.discard()` then `proceed()`; **Stay** and Escape call `stay()`. Focus returns to the element that was focused before.
- `EventPage` also stops guarding after a delete succeeds (it pushes `listHref` itself).

- [ ] **Step 1: Write failing tests.** Hook (jsdom; delete `window.navigation` to test the fallback, and stub a minimal `EventTarget` with a cancelable `navigate` event to test the Navigation path): dirty → a link click is prevented and `pending` is set; clean → untouched; same-pathname/`replace`/hash navigations never prompt; `proceed()` navigates once; `stay()` clears; listeners are removed on unmount and when `dirty` flips false. Dialog: the three buttons, a failed save keeps it open and shows the error, Escape stays. E2E (Chromium, so the Navigation API path): edit a title, click a sidebar link → dialog; Stay keeps the edit; Back button → dialog; Discard & leave navigates; Save & leave saves then navigates; a server-rejected save (document with a problem) keeps the user on the page; a tab/section switch inside the page never prompts.
- [ ] **Step 2: Run, verify FAIL.** **Step 3: Implement.** **Step 4: Run** unit + tsc + build + `events-leave-guard`, `events-builder`, `navigation` specs. **Step 5: Commit** `feat(events): guard in-app navigation while the draft has unsaved changes`.

---

## WP-J (optional): Dependency-free schema lint for JSON fields

Only if you want it; `codemirror-json-schema` cannot be installed (registry policy). `JsonEditor` already accepts a `schema` prop and shows `JSON.parse` + schema errors inline. This package adds editor-level squiggles using what is already installed: `@codemirror/lint` plus the `@lezer/json` tree behind `@codemirror/lang-json` to map an error's JSON pointer to a document range (the validator is the existing inline one; no `ajv` import).

**Files:** modify `src/features/events/builder/template/controls/codemirror-setup.ts` and `JsonEditor.tsx`; create `json-pointer-range.ts` (pointer → `{ from, to }` over the lezer tree); tests `tests/unit/features/events/builder/json-pointer-range.test.ts` (object member, array index, nested, missing → whole document, escaped `~0`/`~1`) and extend the existing JsonEditor tests; the `codemirror-boundary` test keeps passing (imports stay in those two files). Commit `feat(events): inline schema lint in the JSON editor`.

---

## WP-D: Data, docs, verification, merge

- [ ] **Re-point `checkout-event` (only after your yes).** One-off script `scripts/repoint-checkout-event.ts` (kept out of the app bundle): read the event's document, replace the `libraryTraitId` of the `CloudEvents-legacy` trait with the built-in CloudEvents trait id of the same tenant (`ensureBundledTraits` created it), save through `updateEventDocument`, check emitted AsyncAPI shows the 8 properties, then delete the legacy library trait through `deleteTrait` (the guard must now pass) and the `CloudEventsHeaders` entity through the entity service. Print what changed. Back up the event document to `~/super-schema-backups/` first.
- [ ] **Docs.** `docs/events/REVIEW.md`: §1 "Not built" and §6 shrink to what is actually left (external-reference *auto-update*, AsyncAPI importer, infra provider), tabs updated; spec header "as built" date and tab list; this plan marked done.
- [ ] **Memory.** Update `events-self-contained-redesign.md` (what is built, what is left, the 403 on `codemirror-json-schema`).
- [ ] **Full verification** on the merged branch: `npx tsc --noEmit`; `npx eslint src tests`; `npx vitest run tests/unit tests/integration` (baseline failures only); `npx next build --webpack`; Playwright `events-builder`, `events-publish`, `events-external-refs`, `events-leave-guard`, `product-contacts`, `navigation`, `dashboard-not-found` against that build; open the event page in a browser at 1280×600 and 1700×1150 and look at Publish dialog, Versions, Used by, the external picker, the leave dialog and the contacts dialog.
- [ ] **Merge:** `git merge --no-ff` into `main` (no trailer; check overlap with main's own uncommitted files first), `npx prisma generate` in the main checkout, restart the dev server, remove the work-package worktrees and branches (contained in the integration branch), final summary to you.

## Exit check

- [ ] Every WP's tests pass; baseline failures unchanged; `tsc` and `eslint` clean.
- [ ] No migration was added (`git diff main --stat -- prisma` is empty).
- [ ] No `Co-Authored-By` in any new commit: `git log main..HEAD --format=%B | grep -ciE 'co-authored-by|generated with'` prints `0`.
- [ ] Review Focus items 1–7 each map to a passing named test.
