# Phase 1 — Snapshot → Promote Versioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace immutable MAJOR.MINOR publishing with SemVer `MAJOR.MINOR.PATCH` versions that start as a mutable `x.y.z_snapshot` and become an immutable release through an explicit Promote, for entities and event specs, in database mode.

**Architecture:** Version rows gain `patch` and `stage` (`SNAPSHOT` | `RELEASED`). "Publish" becomes "Save snapshot": it creates the object's single open snapshot (numbered from the latest *release*) or updates it in place, raising its number if the change got more severe. "Promote" flips the snapshot to `RELEASED`; the DB trigger then forbids any further update. `latestVersionId` keeps meaning "the version consumers resolve by default": latest release, else the open snapshot (bootstrap fallback).

**Tech Stack:** TypeScript, Next.js 16 server actions, Prisma 7 (PGlite + PostgreSQL), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-02-gitops-storage-design.md` (§7, §8 version stage). Roadmap: `docs/superpowers/plans/2026-11-02-gitops-roadmap.md`.

## Global Constraints

- SemVer `MAJOR.MINOR.PATCH`; labels `1.1.0` (released) and `1.1.0_snapshot` (snapshot). First version is `1.0.0`.
- PATCH = documentation-only change that preserves validity; MINOR = backward-compatible addition; MAJOR = breaking.
- Raise-only bump: a user may raise PATCH→MINOR→MAJOR, never lower below the suggestion (`resolveBump`).
- At most one open snapshot per object; its number must exceed the latest release; a released number is never reused.
- Released versions are immutable (DB trigger). Snapshot rows are mutable until promoted.
- Released versions may only reference released versions; snapshots may reference snapshots.
- Unversioned lookups prefer the highest release; with no release, the newest snapshot (bootstrap only).
- Existing `M.m` versions migrate to `M.m.0`, stage `RELEASED`. Legacy label input `"2.1"` / `"v2.1"` still parses (as `2.1.0`).
- Migrations authored against PostgreSQL (`npm run db:migrate`), must also apply on PGlite (`src/lib/pglite-migrate.ts`).
- Access: Save snapshot keeps `entity.publish` / `event.publish`; Promote uses new `entity.promote` / `event.promote`, `{ minRole: "STEWARD", level: "resource" }`.

## Review Focus

1. **Promote with a dirty draft** — draft edited after the last Save snapshot: Promote must refuse (`DRAFT_NOT_SAVED`) rather than release content that differs from what the user sees.
2. **Promote with a snapshot reference** — the snapshot pins another entity's snapshot (or its closure resolves to one): Promote must refuse with the referenced entity named.
3. **Breaking edit into a minor snapshot** — `1.1.0_snapshot` exists, user saves a breaking change: snapshot renumbers to `2.0.0_snapshot`; it must never drop back to `1.1.0` on a later non-breaking save.
4. **Concurrent save + promote** — Promote racing a Save snapshot on the same entity: exactly one wins; no released row is ever updated (trigger) and no second snapshot appears (partial unique index).
5. **Legacy pins and API clients** — stored `referencedVersions` entries and API callers using `"2.1"`: still resolve to `2.1.0`.

Each item's test is added in the owning task (marked **[RF n]**).

---

### Task 1: SemVer + stage value types and label math

**Files:**
- Modify: `src/lib/entity-versioning/types.ts`
- Modify: `src/lib/entity-versioning/version-math.ts`
- Test: `tests/unit/lib/entity-versioning/version-math.test.ts`

**Interfaces:**
- Produces:
  - `type BumpKind = "MAJOR" | "MINOR" | "PATCH"`; `type ChangeKind = BumpKind | "INITIAL"`; `type VersionStage = "SNAPSHOT" | "RELEASED"`
  - `interface VersionNumber { major: number; minor: number; patch: number }`
  - `INITIAL_VERSION = { major: 1, minor: 0, patch: 0 }`
  - `formatVersionLabel(v: VersionNumber, stage?: VersionStage): string` → `"1.1.0"` / `"1.1.0_snapshot"`
  - `parseVersionLabel(label: string): Result<VersionNumber & { stage: VersionStage }>` — accepts `1.1.0`, `v1.1.0`, `1.1.0_snapshot`, legacy `1.1` / `v1.1` (→ patch 0, RELEASED)
  - `nextVersionNumber(latestRelease: VersionNumber | null, bump: BumpKind): { version: VersionNumber; changeKind: ChangeKind }`
  - `resolveBump(suggested: BumpKind, requested: BumpKind | undefined): Result<BumpKind>` — order PATCH < MINOR < MAJOR
  - `compareVersions(a: VersionNumber, b: VersionNumber): number`
  - `isBumpKind(value: unknown): value is BumpKind` (now includes PATCH)
  - `EntityVersionSummary` gains `patch: number; stage: VersionStage; releasedAt: string | null`; `label` uses the new format.

- [ ] **Step 1: Write failing tests** (extend existing file)

```ts
expect(formatVersionLabel({ major: 1, minor: 1, patch: 0 })).toBe("1.1.0");
expect(formatVersionLabel({ major: 1, minor: 1, patch: 0 }, "SNAPSHOT")).toBe("1.1.0_snapshot");
expect(parseVersionLabel("2.1")).toEqual(ok({ major: 2, minor: 1, patch: 0, stage: "RELEASED" }));     // [RF 5]
expect(parseVersionLabel("v2.1.3_snapshot")).toEqual(ok({ major: 2, minor: 1, patch: 3, stage: "SNAPSHOT" }));
expect(parseVersionLabel("0.1.0").success).toBe(false);
expect(nextVersionNumber(null, "PATCH")).toEqual({ version: { major: 1, minor: 0, patch: 0 }, changeKind: "INITIAL" });
expect(nextVersionNumber({ major: 1, minor: 2, patch: 3 }, "PATCH").version).toEqual({ major: 1, minor: 2, patch: 4 });
expect(nextVersionNumber({ major: 1, minor: 2, patch: 3 }, "MINOR").version).toEqual({ major: 1, minor: 3, patch: 0 });
expect(nextVersionNumber({ major: 1, minor: 2, patch: 3 }, "MAJOR").version).toEqual({ major: 2, minor: 0, patch: 0 });
expect(resolveBump("MINOR", "PATCH").success).toBe(false);   // BUMP_TOO_LOW
expect(resolveBump("PATCH", "MAJOR")).toEqual(ok("MAJOR"));
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/lib/entity-versioning/version-math.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the signatures above. Regex `^v?(\d+)\.(\d+)(?:\.(\d+))?(_snapshot)?$`; keep `MAX_VERSION_PART`. `BUMP_TOO_LOW` message names the suggested kind.
- [ ] **Step 4: Run** `npx tsc --noEmit` — fix every compile error caused by the widened types by threading `patch` through (no behaviour change yet; places that build a `VersionNumber` from DB rows read `patch` once Task 3 lands — until then use `patch: 0`). Run the unit suite `npx vitest run tests/unit/lib` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(versioning): SemVer labels with snapshot stage`

---

### Task 2: PATCH tier in bump classifiers

**Files:**
- Modify: `src/lib/entity-versioning/bump-suggestion.ts`
- Modify: `src/lib/events/document/bump.ts` (`decide`, `BumpDecision`)
- Test: `tests/unit/lib/entity-versioning/bump-suggestion.test.ts`, the existing event bump test next to `bump.ts` (find with `ls tests/unit/lib/events`)

**Interfaces:**
- Consumes: `BumpKind` (Task 1)
- Produces: `suggestBump(previous: FieldSnapshot[], current: FieldSnapshot[]): BumpSuggestion` may return `bump: "PATCH"`; `classifyEventBump(prev, next): BumpDecision` with `bump: BumpKind`.

Rules: entity → PATCH when the diff has no added and no removed fields and every modified field differs from its previous snapshot only in `description`; an empty field diff is also PATCH. Event → `decide(major, minor)` returns PATCH when both lists are empty.

- [ ] **Step 1: Write failing tests**

```ts
it("description-only field change suggests PATCH", ...)   // expect(suggestBump(prev, withDescChanged).bump).toBe("PATCH")
it("no field change suggests PATCH", ...)                 // suggestBump(prev, prev).bump === "PATCH"
it("added optional field suggests MINOR", ...)
it("removed field suggests MAJOR", ...)
it("event with no major/minor findings suggests PATCH", ...)  // classifyEventBump(doc, docWithDescriptionChanged).bump === "PATCH"
```

- [ ] **Step 2: Run** both test files — Expected: FAIL on the PATCH cases.
- [ ] **Step 3: Implement.** For the entity rule compare each modified pair by `JSON.stringify` of the snapshot minus `description` (and minus `sortOrder`, which is not a contract change).
- [ ] **Step 4: Run** both files — Expected: PASS.
- [ ] **Step 5: Commit** `feat(versioning): PATCH tier for doc-only changes`

---

### Task 3: Schema migration — patch, stage, release columns, trigger

**Files:**
- Modify: `prisma/schema.prisma` (`EntityVersion`, `EventSpecVersion`, enum `EntityVersionChangeKind`, new enum `VersionStage`)
- Create: `prisma/migrations/20261102000000_snapshot_versioning/migration.sql`
- Test: `tests/integration/db/entity-versioning-pglite.test.ts`, `tests/integration/db/entity-versioning.test.ts`

**Interfaces:**
- Produces (both version models): `patch Int @default(0)`, `stage VersionStage @default(RELEASED)`, `releasedAt DateTime?`, `releasedById String?` (relation to `User`), `updatedAt DateTime @updatedAt`; uniques `@@unique([entityId, major, minor, patch])` / `@@unique([eventSpecId, major, minor, patch])` replacing the `major, minor` ones; enum value `PATCH` on `EntityVersionChangeKind`.

Migration SQL must:
1. Add columns; backfill existing rows `stage='RELEASED'`, `patch=0`, `releasedAt = publishedAt`, `releasedById = publishedById`.
2. Swap unique constraints to include `patch`; extend the numbers CHECK with `"patch" >= 0`.
3. Partial unique index — one open snapshot per object: `CREATE UNIQUE INDEX entity_versions_one_snapshot ON "entity_versions" ("entityId") WHERE "stage" = 'SNAPSHOT';` (same for `event_spec_versions` on `"eventSpecId"`).
4. CHECK: `stage = 'SNAPSHOT' OR "releasedAt" IS NOT NULL`.
5. Replace both trigger functions so an UPDATE is allowed only when `OLD.stage = 'SNAPSHOT'`; otherwise raise `'Released versions are immutable; save a new snapshot instead'`.

- [ ] **Step 1: Write failing integration tests** (PGlite file; mirror one in the Postgres file)

```ts
it("updates a SNAPSHOT row", ...)                       // update fieldSnapshot on stage SNAPSHOT → resolves
it("rejects updating a RELEASED row", ...)              // rejects.toThrow(/Released versions are immutable/)
it("allows exactly one SNAPSHOT per entity", ...)       // second create with stage SNAPSHOT → unique violation   [RF 4]
it("backfills legacy rows as RELEASED x.y.0", ...)      // seed via raw SQL before migration fixture, or assert on seeded fixture
it("rejects reusing a released number", ...)            // create 1.0.0 RELEASED, then 1.0.0 SNAPSHOT → unique violation
```

- [ ] **Step 2: Run** `npx vitest run tests/integration/db/entity-versioning-pglite.test.ts` — Expected: FAIL.
- [ ] **Step 3: Write** the schema change and migration (`npm run db:migrate -- --name snapshot_versioning --create-only` against Postgres, then hand-edit the SQL for steps 3–5). Regenerate the client (`npx prisma generate`).
- [ ] **Step 4: Run** both integration files — Expected: PASS. Run `npx tsc --noEmit` and replace the Task 1 `patch: 0` placeholders with the column.
- [ ] **Step 5: Commit** `feat(db): snapshot stage and patch on version tables`

---

### Task 4: Snapshot planning for entities

**Files:**
- Modify: `src/lib/entity-versioning/publish-plan.ts`
- Test: `tests/unit/lib/entity-versioning/publish-plan.test.ts`

**Interfaces:**
- Consumes: Task 1 math, Task 2 `suggestBump`.
- Produces:
  - `PublishState` gains `latestRelease: (VersionNumber & { sequence: number }) | null` and `openSnapshot: (VersionNumber & { id: string; sequence: number }) | null` (replacing `latest`).
  - `PublishAnalysis` gains `openSnapshotLabel: string | null`; `candidateLabels: Record<BumpKind, string> | null` labels are snapshot labels; bump is suggested from the diff **against the latest release** (against nothing on first save).
  - `PublishPlan` gains `mode: "CREATE" | "UPDATE"`, `snapshotId: string | null`; `label` is the snapshot label.
  - `planPublish(state, requested?)`: no snapshot → `CREATE` at `nextVersionNumber(latestRelease, bump)`; snapshot exists → `UPDATE` keeping its number unless the resolved bump yields a *higher* number, in which case the plan carries the raised number. Never lower an existing snapshot's number.
  - `planPromote(state: PublishState & { draftDirty: boolean; snapshotReferences: string[] }): Result<{ snapshotId: string; label: string }>` — errors `NO_SNAPSHOT`, `DRAFT_NOT_SAVED`, `SNAPSHOT_REFERENCES` (message lists entity names).

- [ ] **Step 1: Write failing tests**

```ts
it("first save creates 1.0.0_snapshot", ...)                         // mode CREATE, label "1.0.0_snapshot"
it("after 1.0.0 release a MINOR change creates 1.1.0_snapshot", ...)
it("second save updates the open snapshot in place", ...)            // mode UPDATE, snapshotId = open id, label unchanged
it("breaking save raises 1.1.0_snapshot to 2.0.0_snapshot", ...)     // [RF 3]
it("a later non-breaking save keeps 2.0.0_snapshot", ...)           // [RF 3]
it("promote refuses a dirty draft", ...)                             // code DRAFT_NOT_SAVED   [RF 1]
it("promote refuses snapshot references", ...)                       // code SNAPSHOT_REFERENCES, message contains "Customer"   [RF 2]
it("promote without snapshot fails", ...)                            // code NO_SNAPSHOT
```

- [ ] **Step 2: Run** the file — Expected: FAIL.
- [ ] **Step 3: Implement.** Keep blockers/pins logic unchanged; only numbering and the new `planPromote`.
- [ ] **Step 4: Run** the file — Expected: PASS.
- [ ] **Step 5: Commit** `feat(versioning): plan snapshot saves and promotion`

---

### Task 5: Entity service — save snapshot, promote, default version

**Files:**
- Modify: `src/services/entity-version.service.ts`
- Modify: `src/lib/references/closure.ts`, `src/lib/entity-versioning/referenced-versions.ts` (version strings become full labels; read legacy `"M.m"`)
- Test: `tests/unit/services/version-history.service.test.ts`, `tests/integration/db/entity-versioning-pglite.test.ts`

**Interfaces:**
- Consumes: Task 3 columns, Task 4 plans.
- Produces:
  - `publishEntity(entityId, opts: PublishInput, ctx): Promise<Result<EntityVersionSummary>>` — keeps its name and two-phase compile/lock flow; inside the transaction does `create` (stage SNAPSHOT) or `update` of the open snapshot per `plan.mode` (updating number, `resolvedSource`, `fieldSnapshot`, `changeKind`, `compatReport`, `changeSummary`, `publishedById`, `publishedAt = now()`), replaces the snapshot's outgoing `schemaReference` pin edges on update, then sets `hasUnpublishedChanges: false`. Sets `latestVersionId` to the snapshot only when the entity has no release.
  - `promoteEntityVersion(entityId: string, ctx: ServiceContext): Promise<Result<EntityVersionSummary>>` — row lock on the entity (same `FOR UPDATE` as publish), `planPromote`, then `update` stage `RELEASED`, `releasedAt`, `releasedById`; sets `latestVersionId` to it. Audit action `PROMOTE_VERSION`. Snapshot references = any pin edge from the snapshot whose target version row is `SNAPSHOT`, or any `referencedVersions` entry resolving to a snapshot.
  - `getLatestPublishedVersion` → returns latest RELEASED, else open snapshot. `listEntityVersions` includes the snapshot first.

- [ ] **Step 1: Write failing integration tests** (PGlite)

```ts
it("save → save → promote yields one RELEASED 1.0.0 and no snapshot", ...)
it("save after release creates 1.1.0_snapshot and latestVersionId stays on 1.0.0", ...)
it("promote racing save: one wins, the other gets CONFLICT", ...)   // Promise.allSettled; assert ≤1 SNAPSHOT row, released row unchanged   [RF 4]
it("legacy referencedVersions '2.1' resolves to 2.1.0", ...)        // [RF 5]
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run tests/integration/db tests/unit/services` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(versioning): entity snapshots and promotion`

---

### Task 6: Event spec service — save snapshot, promote

**Files:**
- Modify: `src/lib/events/publish-plan.ts`, `src/services/events/event-publish.service.ts`
- Modify (label/default-version consumers): `src/services/events/{pins,event-guards,external-refs.service,artifact-renderer,version-summary,event-emit.service}.ts`, `src/features/events/load-options.ts`, `src/lib/events/external-refs.ts`
- Test: existing event publish tests (`ls tests/unit/services/events tests/unit/lib/events`) + one PGlite integration test

**Interfaces:**
- Consumes: Tasks 1–3; mirrors Task 4/5 semantics.
- Produces: `planVersionedPublish(input, requested?)` with the same `mode`/`snapshotId` contract as Task 4 (`VersionedPublishInput` gets `latestRelease` + `openSnapshot`); `publishEvent(...)` creates/updates the snapshot; `promoteEvent(eventId: string, productId: string, ctx: ServiceContext): Promise<Result<EventVersionSummary>>`; AsyncAPI `info.version` = full label (`"1.1.0_snapshot"` while a snapshot); `EventVersionSummary` gains `patch`, `stage`, `releasedAt`.
- Pins and external refs from a released event must target released event/entity versions (Promote refuses otherwise, code `SNAPSHOT_REFERENCES`).

- [ ] **Step 1: Write failing tests** — event equivalents of Task 4's numbering tests and Task 5's lifecycle test, plus `it("info.version carries the snapshot label")`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run tests/unit/lib/events tests/unit/services/events tests/integration/db` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(events): event snapshots and promotion`

---

### Task 7: Actions, access, and API surface

**Files:**
- Modify: `src/lib/access/actions.ts` (add `entity.promote`, `event.promote`), `src/lib/access/capabilities.ts`
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/version-actions.ts`, `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions.ts`, `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions.ts`
- Modify: `src/app/api/v1/event-specs/[id]/route.ts` (labels; `?version=` accepts legacy + snapshot labels)
- Test: `tests/unit/app/entity-version-actions.test.ts`, access table test (`ls tests/unit/access`)

**Interfaces:**
- Produces: `promoteEntityAction(entityId: string): Promise<{ success: true; version: EntityVersionSummary } | { error: string; code?: string }>`; `promoteEventAction(eventId: string, productId: string)` same shape. `publishEntityAction` accepts `bump: "PATCH"`.

- [ ] **Step 1: Write failing tests** — `promoteEntityAction` refuses a VIEWER (`FORBIDDEN`), succeeds for STEWARD; `publishEntityAction` with `bump: "PATCH"` passes validation; API route returns `"1.0.0"` labels and resolves `?version=1.0`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run tests/unit/app tests/unit/access tests/unit/api` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(versioning): promote actions and access`

---

### Task 8: UI — Save snapshot, Promote, stage display

**Files:**
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/PublishEntityDialog.tsx`, `.../[entityId]/entity-workspace.tsx`
- Modify: `src/lib/entity-versioning/draft-label.ts`
- Modify: `src/features/events/event-page/EventPage.tsx` (and its publish dialog)
- Modify: `messages/*.json` (next-intl strings; find with `ls messages`)
- Test: `tests/unit/lib/entity-versioning/draft-state.test.ts` (`describeDraftState`), one e2e in `tests/e2e` (follow nearest existing publish spec)

**Interfaces:**
- Consumes: Task 7 actions.
- Produces: `DraftVersionState` = `{ latestReleaseLabel: string | null; snapshotLabel: string | null; hasUnpublishedChanges: boolean }`; `describeDraftState` copy:
  - nothing saved: `"Never saved"`
  - dirty: `"Draft · unsaved changes · snapshot v1.1.0_snapshot"` (or `· latest v1.0.0` when no snapshot)
  - clean snapshot: `"Snapshot · v1.1.0_snapshot · latest release v1.0.0"` (omit release part when none)
  - clean release only: `"Released · v1.0.0"`

UI changes: dialog title/button "Save snapshot"; bump choices PATCH/MINOR/MAJOR with labels from `candidateLabels`; a **Promote to v1.1.0** button beside it, enabled when a snapshot exists and the draft is clean, showing the `planPromote` refusal text when disabled; version list shows a "Snapshot" badge on the snapshot row. Same for the event page.

- [ ] **Step 1: Write failing unit tests** for the four `describeDraftState` strings above.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** label + components.
- [ ] **Step 4: Run** the unit test and the e2e (`npm run test:e2e:raw -- <spec>`): save → snapshot badge visible → promote → "Released · v1.0.0". Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): save snapshot and promote`

---

### Task 9: Full verification

- [ ] **Step 1:** `npx tsc --noEmit && npm run lint && npx vitest run` — Expected: all pass.
- [ ] **Step 2:** `npm run test:e2e:smoke` — Expected: pass (update snapshots only for intentional label changes).
- [ ] **Step 3:** Fresh PGlite boot (`rm -rf ./data/pglite-test` equivalent per `docs/database.md`) applies the migration in-process; seed runs (`prisma/seed.ts`).
- [ ] **Step 4:** Update `docs/` user-facing versioning text if any page documents "Publish" (grep `docs/` for `Publish`). Commit `docs: snapshot/promote versioning`.
