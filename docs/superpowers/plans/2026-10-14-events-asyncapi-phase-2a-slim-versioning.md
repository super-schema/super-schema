# Events & Platform Completeness — Phase 2a: Slim Entity Versioning (Draft + Publish)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver only what the Events phase needs to pin `Entity@MAJOR.MINOR`. That means an immutable `EntityVersion` table, a `SchemaReference` edge table, a Publish flow (first publish 1.0; after that MINOR/MAJOR from a simple classifier, which the user may raise but never lower; reference fields pinned), `hasUnpublishedChanges` draft tracking, read APIs for the Message pickers, a minimal header, publish dialog and version list, and the backfill. It also retires Story 2-22's "every save creates a version".

**Architecture:** The `Entity` row and its `fields` are the **draft**. Pure modules under `src/lib/entity-versioning/` do the version arithmetic, the bump suggestion (reusing `computeDiffResult` + `classifyFromDiff`), reference-target extraction and publish planning (blockers, pins, next version). `src/services/entity-version.service.ts` loads state, takes a row lock and writes `EntityVersion`, the `SchemaReference` pins and the draft pointers in one transaction. Every draft-mutating path flips `Entity.hasUnpublishedChanges` through one helper (`markEntityDraftChanged`) or inline in an update it already makes. The UI reads `latestVersionLabel` + `hasUnpublishedChanges` from the page loader and talks to new server actions in `version-actions.ts`.

**Tech Stack:** Next.js App Router (server actions), Prisma 7 + PostgreSQL / PGlite, Vitest (+ Testing Library/jsdom), Tailwind design tokens, base-ui dialog primitives (`@/components/ui/dialog`).

**Spec:** `docs/superpowers/specs/2026-10-13-events-asyncapi-design.md` (§2 D1/Q4/Q6, §5, §6.1 `SchemaReference`, §10, §11). Master plan: `docs/superpowers/plans/2026-10-13-events-asyncapi-phase-1.md` (Program phases). Phase 2 is split: **2a (this file)** is fast-tracked so Events can pin versions. **2b** gets the rest of §5 (see "Deferred").

## Global Constraints

- All services return `Result<T, ServiceError>` from `@/types/result`. Never throw across a service boundary: `publishEntity` catches `ServiceErrorRejection`, unique violations (`P2002`) and `AuditUserMissingError` and maps each to an error code.
- Publish is audited with `withAudit` (`@/lib/audit`, action `PUBLISH_VERSION`, entityType `Entity`).
- **Migrations:** hand-written, idempotent SQL, written in the style of `prisma/migrations/20261013_add_asset_levels/migration.sql`. There are two folders: `prisma/migrations/20261014_entity_versioning/` (DDL) and `prisma/migrations/20261014_entity_versioning_backfill/` (a single backfill statement). **After every `prisma/schema.prisma` edit, run `npm run db:deploy` and then `npm run db:generate`.** PGlite applies the same SQL through `src/lib/pglite-migrate.ts`. Both folder names must sort after every existing migration. If the base branch gets a later `2026101x_*` folder before merge, rename these two folders so they stay last, then re-deploy.
- **This plan owns database migrations during its run.** No other worktree applies migrations at the same time. The worktree symlinks `.env`, so it uses the same `DATABASE_URL` as the main checkout. The migration only adds things: new tables, plus new `entities` columns with defaults. The main checkout's older Prisma client keeps working against the migrated DB.
- **Worktree setup:** see Task 0. In short: symlink `node_modules` and `.env` from `/Users/jsenjaliya/src/my/super-schema`, then run `npx prisma generate`. `src/generated/prisma` is gitignored, so every worktree must generate its own copy.
- Version format is `MAJOR.MINOR`, with no patch. The first publish is always `1.0` (`INITIAL`). Later publishes default to the classifier's suggestion; the user may raise MINOR to MAJOR but never lower MAJOR to MINOR. **This is enforced server-side** (`BUMP_TOO_LOW`), not only in the UI.
- `sequence` is the monotonic publish counter. First publish: `max(Entity.version, 1)`. After that: `latest.sequence + 1`. `Entity.version` is set to the new sequence on every publish. After Task 6, nothing else increments `Entity.version` (the `EmissionTargetStatus` / `DeploymentRecord` Int consumers keep working).
- **Spec D1:** Story 2-22's explicit Save/Discard stays. Saving updates the draft only; no save path ever creates a version.
- `hasUnpublishedChanges` is set to `true` by **every** draft-mutating path (full list in Task 3). Metadata keys that never dirty the draft: `schemaVersions`, `schemaTargetTypeOverrides`, `semanticVersion`, `versionHistory`, `typespecMigration`, `deprecation`. These are system bookkeeping or lifecycle keys. Every other key (tags, owner, relationships, retentionPolicy, custom) is a draft change. Unknown keys default to dirty, because a spurious "unpublished changes" badge is harmless and a missed one is a bug.
- Legacy `entity.metadata.versionHistory` and `metadata.semanticVersion` are never written again and never converted. The legacy list stays visible read-only.
- **Phase 1 / Phase 4 work keeps landing on the base branch.** The Enterprise route and the shared loader `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/load-entity-workspace.ts` landed in `a559c671`. Both the product page and `/schemas/enterprise/entities/[entityId]` render `EntityWorkspace` through `loadEntityWorkspace`, so the version props are added once, in the loader (Task 8). Do not depend on any Phase 1/4 file that is not on the branch when Task 0 runs. Keep edits to shared files (`actions.ts`, `entity-workspace.tsx`, `EntityHeader.tsx`) minimal, and re-read each one immediately before editing; the snippets below match on content, not line numbers. The new `EntityWorkspace` props are **optional**, so existing test fixtures (`tests/unit/components/entity-workspace-level.test.tsx`) keep compiling.
- No new npm packages are needed.
- **`SchemaReference` is created by this phase** (spec §6.1). The Phase 4a plan lists it under Story 18.1. Story 18.1 must reuse this table and its enums and must not re-create them.
- Tests: unit tests in `tests/unit/**`. DB integration tests in `tests/integration/**` use a real `DATABASE_URL` with `DB_PROVIDER=postgresql`, following the existing convention of `tests/integration/services/entity-lifecycle.test.ts` and `tests/integration/db/asset-levels.test.ts` (try/finally cleanup or a rolled-back transaction). The PGlite migration test runs in memory and needs no env.
- **Baseline (2026-10-14, branch `feat/events-asyncapi`):** `npx tsc --noEmit` is clean. `npx vitest run` shows **8 pre-existing failures**: db-emitter-parity ×4, e2e-critical-flows bigquery ×1, schemas-tab ×3. All come from the broken `@typespec/db` (Story 16.4). The schemas-tab tests cover the per-target `metadata.schemaVersions` numbering of `generateSchemaAction` / `publishSchemaAction` / `deploySchemaAction`, which this plan does not touch, so they must keep failing for the same `@typespec/db` reason only. Name note: the existing `publishSchemaAction` publishes an emitted per-target schema and is unrelated. The new entity action is `publishEntityAction`. The total test count drops because of the deleted `createSnapshot` and `change-level` suites (Task 6); the failure count must stay at 8.

## Review Focus

1. **Lowering a breaking bump.** `publishEntity(id, { bump: "MINOR" })` after a field removal must fail with `BUMP_TOO_LOW` at the service layer. Tests in Tasks 1, 4 and 5.
2. **Concurrent publishes of one entity** (double-click, two tabs) must create exactly one version; the other call fails `PUBLISH_BLOCKED` (no changes). This relies on the row lock plus the unique `(entityId, sequence)`. Test in Task 5.
3. **Referenced entity never published.** Publish must be blocked with the exact message `Publish <B> first`, with all blockers reported together. Once B is published, A pins B's latest version in `schema_references` (role `FIELD`). Tests in Tasks 4 and 5.
4. **Save never cuts a version.** After a publish, editing a field must flip the header to `Draft · unpublished changes · latest vX.Y`, and no `metadata.versionHistory` entry or `semanticVersion` write may appear. Tests in Tasks 3 and 6, plus the manual smoke in Task 9.
5. **Backfill.** `ACTIVE` entities with `typespecSource` get `1.0 INITIAL` with `sequence = Entity.version`. `DRAFT` entities and source-less `ACTIVE` entities stay unpublished. Re-running is a no-op. Test in Task 2.
6. **Deleting a published entity.** The circular FK `entities.latestVersionId` ↔ `entity_versions.entityId` must cascade cleanly on both PostgreSQL and PGlite. Tests in Task 2.
7. **Immutability.** `UPDATE entity_versions` must raise at the DB level. Tests in Task 2.

---

## Scope

### In scope (Phase 2a)

| Story | Delivered in 2a | Left for 2b |
|---|---|---|
| 14.1 `EntityVersion` + draft pointers | Table, `latestVersionId`, `hasUnpublishedChanges`, `version` mirrors sequence, draft tracking on every path | — |
| 14.2 Resolved source + pins | Entity→entity `FIELD` pins in `SchemaReference`; "Publish B first" blocker | Data Type closure frozen into `resolvedSource` (2a stores the entity's `typespecSource`, or source generated from fields when it is null) |
| 14.3 Compatibility + bump suggestion | Simple classifier: `classifyFromDiff` breaking → MAJOR | Avro / JSON Schema / Proto rule tables; `compatReport` stays `{}` |
| 14.4 Publish dialog + flow | Dialog (suggested bump, raise-only, summary, blockers); immediate publish | `GovernanceRequest` `subjectKind/subjectId`; MAJOR approval |
| 14.6 Version history | Simple published-version list + legacy list (read-only) | Diff viewer for versions; `?version=2.1` read-only view |
| 14.7 Migration | ACTIVE+source → `1.0`, `sequence = Entity.version` | — |
| 14.8 Story 2-22 reconciliation | Save/Discard kept; save-creates-version, `semanticVersion` bump and `classifyChangeLevel` retired | — |
| §6.1 `SchemaReference` | Table with all enum values; only `ENTITY_VERSION → ENTITY_VERSION` `FIELD` rows written | Message/Spec/Trait rows (Events phase) |

### Deferred (explicitly out of 2a)

| Item | Spec | Target |
|---|---|---|
| Avro / JSON Schema / Proto compatibility rule tables; bump from per-format checkers; populated `compatReport` | §5.2 step 4, 14.3 | 2b |
| Governance approval for MAJOR (version row created on approval; `governanceRequestId` stays null in 2a) | §5.2 step 7, 14.4 | 2b |
| `EntityVersionArtifact` frozen emitter outputs | §5.1, 14.5 | 2b |
| Data Type closure frozen into `resolvedSource`; level-derived namespaces (13.4); real-compiler gate at publish (cannot compile reference entities standalone until the closure exists) | §5.1, §5.2 steps 1–2, 14.2, 13.4 | 2b |
| Editing a Data Type sets `hasUnpublishedChanges` on dependent entity drafts (needs the closure / usage index) | §5.1 | 2b |
| Full history + diff UI, diff inside the publish dialog, `?version=` read-only entity view | §5.3, 14.6 | 2b |
| Delete restriction for versions referenced by published versions (deprecate instead) | §6.1 | Before Events pins go live (Events phase or 2b) |
| Per-level permission gate on publish (2a requires authentication only, the same as every existing edit action) | §10 | later |
| `ICompilerService`; drop `EmissionTargetStatus.formatOptions` | 21.6 | 2b |

### Known gaps carried forward (documented, not fixed in 2a)

- Field-editor edits do not regenerate `typespecSource`. This was already true before 2a; spec §1 says `fields` derive from source. In 2a, `resolvedSource` is the stored `typespecSource` when present, so it can lag `fieldSnapshot` when the draft was edited through the field editor. `fieldSnapshot` is always current. The 14.2 resolved-source builder regenerates.
- A reference that exists only in TypeSpec source (a model-name type with no `decorators.referencedEntityId` and no `metadata.relationships` entry) is not pinned. Self-references are never pinned.
- Deleting an entity cascades its versions. `schema_references` rows to and from those versions are left dangling until the delete restriction lands.
- Publishing does not change the lifecycle `status` (DRAFT/ACTIVE/…). Publication and lifecycle are separate.

---

## File structure (Phase 2a)

| File | Responsibility |
|---|---|
| `src/lib/entity-versioning/types.ts` (create) | `BumpKind`, `ChangeKind`, `VersionNumber`, `PublishInput`, `EntityVersionSummary`, `isBumpKind` (client-safe) |
| `src/lib/entity-versioning/version-math.ts` (create) | Label format/parse, next version, raise-only `resolveBump` |
| `src/lib/diff/field-snapshot.ts` (create) | `toFieldSnapshot` (moved out of the legacy version service) |
| `src/lib/entity-versioning/bump-suggestion.ts` (create) | `suggestBump(prev, curr)` over `computeDiffResult` + `classifyFromDiff` |
| `src/lib/entity-versioning/reference-targets.ts` (create) | `collectReferencedEntityIds(entityId, fields, metadata)` |
| `src/lib/entity-versioning/publish-plan.ts` (create) | Pure `analyzePublish` / `planPublish`: blockers, pins, suggested bump, next version |
| `src/lib/entity-versioning/draft-state.ts` (create) | `metadataChangesDraft`, `entityUpdateTouchesDraft`, `markEntityDraftChanged` (server) |
| `src/lib/entity-versioning/draft-label.ts` (create) | `describeDraftState`, `toDraftVersionState` (client-safe) |
| `prisma/schema.prisma` (modify) | `EntityVersion`, `SchemaReference`, enums, `Entity.latestVersionId/hasUnpublishedChanges`, relations |
| `prisma/migrations/20261014_entity_versioning/migration.sql` (create) | Enums, tables, columns, FKs, indexes, CHECK, immutability trigger |
| `prisma/migrations/20261014_entity_versioning_backfill/migration.sql` (create) | Single-statement idempotent backfill (ACTIVE+source → 1.0) |
| `src/services/entity-version.service.ts` (create) | `previewPublish`, `publishEntity`, `listEntityVersions`, `getEntityVersion`, `getLatestPublishedVersion` |
| `src/services/field.service.ts` (modify) | Mark draft on create/update/delete/reorder |
| `src/services/entity.service.ts` (modify) | Mark draft on draft-affecting `updateEntity` |
| `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions.ts` (modify) | Mark draft on every field/entity/source save; delete `createVersionAction` |
| `src/app/(dashboard)/governance/retention/actions.ts` (modify) | Mark draft on retention-policy save |
| `src/services/version-history/version.service.ts` (modify) | Delete `createSnapshot` (legacy reads stay) |
| `src/lib/validation/change-level.ts` + `tests/unit/validation/change-level.test.ts` (delete) | Superseded by D1 |
| `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/version-actions.ts` (create) | `getPublishPreviewAction`, `publishEntityAction`, `listEntityVersionsAction` |
| `.../[entityId]/components/PublishEntityDialog.tsx` (create) | `PublishEntityForm` (testable body) + `PublishEntityDialog` shell |
| `.../[entityId]/components/EntityVersionList.tsx` (create) | Published-version rows |
| `.../[entityId]/components/EntityHeader.tsx` (modify) | Draft-state label + Publish button (replaces `semanticVersion` badge) |
| `.../[entityId]/components/TypeSpecSourceTab.tsx` (modify) | `onSaved` callback |
| `.../[entityId]/entity-workspace.tsx` (modify) | Remove save-creates-version; draft state; publish dialog; versions tab |
| `.../[entityId]/load-entity-workspace.ts` (modify) | Load `latestVersion` + `hasUnpublishedChanges` for both product and Enterprise entity pages |
| `tests/unit/app/load-entity-workspace.test.ts`, `tests/unit/components/entity-workspace-level.test.tsx` (modify) | Loader maps the draft state; workspace header renders it; `version-actions` mocked |
| `_bmad-output/implementation-artifacts/2-22-explicit-save-semantic-versioning.md` (modify) | "Superseded in part" note |

---

### Task 0: Worktree setup + baseline

**Files:** none (environment only).

- [ ] **Step 1: Create the worktree off the events branch**

```bash
cd /Users/jsenjaliya/src/my/super-schema
git worktree add ../super-schema-phase-2a -b feat/events-phase-2a-versioning feat/events-asyncapi
cd /Users/jsenjaliya/src/my/super-schema-phase-2a
ln -s /Users/jsenjaliya/src/my/super-schema/node_modules node_modules
ln -s /Users/jsenjaliya/src/my/super-schema/.env .env
npx prisma generate
```

Both symlinks are ignored by `.gitignore` (`/node_modules`, `.env`). Confirm with `git status --short`; it should print nothing.

- [ ] **Step 2: Make sure ACTIVE entities have TypeSpec source before the backfill** (Story 12.7; idempotent, safe to re-run). Do this **before** editing `schema.prisma` so the script's client matches the current DB.

```bash
npm run db:migrate-typespec-source
```

Expected: `TypeSpec source migration: N migrated, M skipped, K flagged`. Record the line. Flagged entities stay unpublished after the backfill (spec §5.4 precondition).

- [ ] **Step 3: Record the baseline**

```bash
npx tsc --noEmit
npx vitest run 2>&1 | tail -25
```

Expected: tsc clean. Exactly 8 failing tests: db-emitter-parity ×4, e2e-critical-flows (bigquery) ×1, schemas-tab ×3. If the count differs, stop and report before changing code.

---

### Task 1: Pure version helpers (Stories 14.1 / 14.3 groundwork)

**Files:**
- Create: `src/lib/entity-versioning/types.ts`
- Create: `src/lib/entity-versioning/version-math.ts`
- Create: `src/lib/diff/field-snapshot.ts`
- Create: `src/lib/entity-versioning/bump-suggestion.ts`
- Create: `src/lib/entity-versioning/reference-targets.ts`
- Test: `tests/unit/lib/entity-versioning/version-math.test.ts`, `tests/unit/lib/entity-versioning/bump-suggestion.test.ts`, `tests/unit/lib/entity-versioning/reference-targets.test.ts`, `tests/unit/lib/diff/field-snapshot.test.ts`

**Interfaces:**
- Produces: `formatVersionLabel(v: VersionNumber): string`; `parseVersionLabel(label: string): Result<VersionNumber>`; `nextVersionNumber(latest: VersionNumber | null, bump: BumpKind): { version: VersionNumber; changeKind: ChangeKind }`; `resolveBump(suggested: BumpKind, requested: BumpKind | undefined): Result<BumpKind>`; `toFieldSnapshot(field: FieldSnapshotSource): FieldSnapshot`; `suggestBump(previous: FieldSnapshot[], current: FieldSnapshot[]): BumpSuggestion`; `collectReferencedEntityIds(entityId: string, fields: ReferenceSourceField[], metadata: unknown): string[]`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/lib/entity-versioning/version-math.test.ts`

```ts
import { describe, it, expect } from "vitest";
import {
  formatVersionLabel,
  parseVersionLabel,
  nextVersionNumber,
  resolveBump,
} from "@/lib/entity-versioning/version-math";

describe("formatVersionLabel / parseVersionLabel", () => {
  it("round-trips MAJOR.MINOR and accepts a leading v and whitespace", () => {
    expect(formatVersionLabel({ major: 2, minor: 1 })).toBe("2.1");
    expect(parseVersionLabel("2.1")).toEqual({ success: true, data: { major: 2, minor: 1 } });
    expect(parseVersionLabel(" v10.0 ")).toEqual({ success: true, data: { major: 10, minor: 0 } });
  });

  it.each(["2", "2.1.3", "abc", "0.1", "-1.0", ""])("rejects %j", (label) => {
    const res = parseVersionLabel(label);
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("nextVersionNumber", () => {
  it("starts at 1.0 INITIAL whatever bump is asked for", () => {
    expect(nextVersionNumber(null, "MAJOR")).toEqual({ version: { major: 1, minor: 0 }, changeKind: "INITIAL" });
    expect(nextVersionNumber(null, "MINOR")).toEqual({ version: { major: 1, minor: 0 }, changeKind: "INITIAL" });
  });

  it("MINOR keeps the major and increments the minor", () => {
    expect(nextVersionNumber({ major: 2, minor: 1 }, "MINOR")).toEqual({ version: { major: 2, minor: 2 }, changeKind: "MINOR" });
  });

  it("MAJOR increments the major and resets the minor", () => {
    expect(nextVersionNumber({ major: 2, minor: 1 }, "MAJOR")).toEqual({ version: { major: 3, minor: 0 }, changeKind: "MAJOR" });
  });
});

describe("resolveBump (raise-only)", () => {
  it("defaults to the suggestion", () => {
    expect(resolveBump("MINOR", undefined)).toEqual({ success: true, data: "MINOR" });
    expect(resolveBump("MAJOR", undefined)).toEqual({ success: true, data: "MAJOR" });
  });

  it("allows raising MINOR to MAJOR", () => {
    expect(resolveBump("MINOR", "MAJOR")).toEqual({ success: true, data: "MAJOR" });
  });

  it("refuses lowering MAJOR to MINOR", () => {
    const res = resolveBump("MAJOR", "MINOR");
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.code).toBe("BUMP_TOO_LOW");
  });
});
```

`tests/unit/lib/diff/field-snapshot.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { toFieldSnapshot } from "@/lib/diff/field-snapshot";

describe("toFieldSnapshot", () => {
  it("copies the compared columns and drops row-only columns", () => {
    const row = {
      id: "f1", entityId: "e1", name: "email", slug: "email", type: "string", precision: null, scale: null,
      nullable: true, isKey: false, fieldNumber: 2, description: "Primary email", classification: "PII",
      aliases: ["mail"], decorators: { typespec: { identity: { format: "email" } } }, sortOrder: 1,
      createdAt: new Date(), updatedAt: new Date(),
    };
    expect(toFieldSnapshot(row)).toEqual({
      id: "f1", name: "email", type: "string", precision: null, scale: null, nullable: true, isKey: false,
      fieldNumber: 2, description: "Primary email", classification: "PII", aliases: ["mail"],
      decorators: { typespec: { identity: { format: "email" } } }, sortOrder: 1,
    });
  });

  it("normalises null decorators to an empty object", () => {
    const snap = toFieldSnapshot({
      id: "f1", name: "id", type: "string", precision: null, scale: null, nullable: false, isKey: true,
      fieldNumber: null, description: "", classification: null, aliases: [], decorators: null, sortOrder: 0,
    });
    expect(snap.decorators).toEqual({});
  });
});
```

`tests/unit/lib/entity-versioning/bump-suggestion.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { suggestBump } from "@/lib/entity-versioning/bump-suggestion";
import type { FieldSnapshot } from "@/services/version-history/version.types";

function f(name: string, extra: Partial<FieldSnapshot> = {}): FieldSnapshot {
  return {
    id: `id-${name}`, name, type: "string", precision: null, scale: null, nullable: true, isKey: false,
    fieldNumber: null, description: "", classification: null, aliases: [], decorators: {}, sortOrder: 0,
    ...extra,
  };
}

const ID = f("id", { nullable: false, isKey: true });
const EMAIL = f("email");

describe("suggestBump", () => {
  it("suggests MINOR when nothing changed", () => {
    expect(suggestBump([ID, EMAIL], [ID, EMAIL])).toMatchObject({ bump: "MINOR", summary: { added: 0, removed: 0, modified: 0 } });
  });

  it("suggests MINOR for an added optional field", () => {
    const s = suggestBump([ID, EMAIL], [ID, EMAIL, f("phone")]);
    expect(s.bump).toBe("MINOR");
    expect(s.summary.added).toBe(1);
  });

  it("suggests MINOR for a description-only edit", () => {
    expect(suggestBump([ID, EMAIL], [ID, f("email", { description: "Primary email" })]).bump).toBe("MINOR");
  });

  it("suggests MAJOR for a removed field and says why", () => {
    const s = suggestBump([ID, EMAIL], [ID]);
    expect(s.bump).toBe("MAJOR");
    expect(s.reasons.some((r) => r.includes('Removed field "email"'))).toBe(true);
  });

  it("suggests MAJOR for a type change", () => {
    expect(suggestBump([ID, EMAIL], [ID, f("email", { type: "int32" })]).bump).toBe("MAJOR");
  });

  it("suggests MAJOR for an added required field", () => {
    expect(suggestBump([ID], [ID, f("tenant", { nullable: false })]).bump).toBe("MAJOR");
  });
});
```

`tests/unit/lib/entity-versioning/reference-targets.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { collectReferencedEntityIds } from "@/lib/entity-versioning/reference-targets";

describe("collectReferencedEntityIds", () => {
  it("collects decorators.referencedEntityId from reference fields", () => {
    const fields = [
      { id: "f1", decorators: { referencedEntityId: "customer", referencedEntityName: "Customer" } },
      { id: "f2", decorators: {} },
    ];
    expect(collectReferencedEntityIds("order", fields, null)).toEqual(["customer"]);
  });

  it("collects metadata relationships whose field still exists", () => {
    const meta = {
      relationships: [
        { targetEntityId: "address", fieldId: "f1", cardinality: "many-to-one" },
        { targetEntityId: "stale", fieldId: "gone", cardinality: "many-to-one" },
      ],
    };
    expect(collectReferencedEntityIds("order", [{ id: "f1", decorators: {} }], meta)).toEqual(["address"]);
  });

  it("dedupes, drops self references and blanks, and sorts", () => {
    const fields = [
      { id: "f1", decorators: { referencedEntityId: "zeta" } },
      { id: "f2", decorators: { referencedEntityId: "alpha" } },
      { id: "f3", decorators: { referencedEntityId: "order" } },
      { id: "f4", decorators: { referencedEntityId: "  " } },
      { id: "f5", decorators: { referencedEntityId: 42 } },
    ];
    const meta = { relationships: [{ targetEntityId: "alpha", fieldId: "f2", cardinality: "many-to-one" }] };
    expect(collectReferencedEntityIds("order", fields, meta)).toEqual(["alpha", "zeta"]);
  });

  it("tolerates malformed metadata and decorators", () => {
    expect(collectReferencedEntityIds("order", [{ id: "f1", decorators: null }], { relationships: "nope" })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/lib/entity-versioning tests/unit/lib/diff/field-snapshot.test.ts`
Expected: FAIL with `Cannot find module '@/lib/entity-versioning/version-math'` (and the other three modules).

- [ ] **Step 3: Implement** `src/lib/entity-versioning/types.ts`

```ts
/** Entity versioning value types (spec §5). Client-safe: no server imports. */

export type BumpKind = "MAJOR" | "MINOR";
export type ChangeKind = BumpKind | "INITIAL";

export interface VersionNumber {
  major: number;
  minor: number;
}

/** What the user chooses in the publish dialog. `bump` is ignored on a first publish (always 1.0). */
export interface PublishInput {
  bump?: BumpKind;
  changeSummary?: string;
}

/** A published version without its (large) frozen source and field snapshot. */
export interface EntityVersionSummary {
  id: string;
  entityId: string;
  major: number;
  minor: number;
  /** "2.1" */
  label: string;
  sequence: number;
  changeKind: ChangeKind;
  changeSummary: string | null;
  publishedById: string;
  publishedByName: string | null;
  /** ISO-8601 */
  publishedAt: string;
}

export function isBumpKind(value: unknown): value is BumpKind {
  return value === "MAJOR" || value === "MINOR";
}
```

`src/lib/entity-versioning/version-math.ts`

```ts
import { ok, err, type Result } from "@/types/result";
import type { BumpKind, ChangeKind, VersionNumber } from "./types";

export const INITIAL_VERSION: VersionNumber = { major: 1, minor: 0 };

/** `{ major: 2, minor: 1 }` → `"2.1"` (spec Q6: MAJOR.MINOR, no patch). */
export function formatVersionLabel(v: VersionNumber): string {
  return `${v.major}.${v.minor}`;
}

const LABEL = /^v?(\d+)\.(\d+)$/;

/** Parse `"2.1"` / `"v2.1"`. Versions start at 1.0. */
export function parseVersionLabel(label: string): Result<VersionNumber> {
  const match = LABEL.exec(label.trim());
  const major = match ? Number(match[1]) : NaN;
  const minor = match ? Number(match[2]) : NaN;
  if (!match || major < 1) {
    return err({
      code: "VALIDATION_ERROR",
      message: `"${label}" is not a version label`,
      suggestedFix: 'Use MAJOR.MINOR starting at 1.0, e.g. "2.1".',
    });
  }
  return ok({ major, minor });
}

/** First publish is always 1.0 INITIAL; afterwards MAJOR → (M+1).0, MINOR → M.(m+1). */
export function nextVersionNumber(
  latest: VersionNumber | null,
  bump: BumpKind
): { version: VersionNumber; changeKind: ChangeKind } {
  if (!latest) return { version: INITIAL_VERSION, changeKind: "INITIAL" };
  return bump === "MAJOR"
    ? { version: { major: latest.major + 1, minor: 0 }, changeKind: "MAJOR" }
    : { version: { major: latest.major, minor: latest.minor + 1 }, changeKind: "MINOR" };
}

/** Raise-only (spec Q6): the user may raise MINOR → MAJOR, never lower MAJOR → MINOR. */
export function resolveBump(suggested: BumpKind, requested: BumpKind | undefined): Result<BumpKind> {
  if (requested === undefined) return ok(suggested);
  if (suggested === "MAJOR" && requested === "MINOR") {
    return err({
      code: "BUMP_TOO_LOW",
      message: "These changes are breaking and must be published as a MAJOR version.",
      suggestedFix: "Publish as MAJOR.",
    });
  }
  return ok(requested);
}
```

`src/lib/diff/field-snapshot.ts`

```ts
import type { FieldSnapshot } from "@/services/version-history/version.types";

/** The Field columns a snapshot captures. A Prisma `Field` row satisfies this structurally. */
export interface FieldSnapshotSource {
  id: string;
  name: string;
  type: string;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  isKey: boolean;
  fieldNumber: number | null;
  description: string;
  classification: string | null;
  aliases: string[];
  decorators: unknown;
  sortOrder: number;
}

/** Field projection frozen into EntityVersion.fieldSnapshot and compared by field-diff. */
export function toFieldSnapshot(field: FieldSnapshotSource): FieldSnapshot {
  return {
    id: field.id,
    name: field.name,
    type: field.type,
    precision: field.precision,
    scale: field.scale,
    nullable: field.nullable,
    isKey: field.isKey,
    fieldNumber: field.fieldNumber,
    description: field.description,
    classification: field.classification,
    aliases: field.aliases,
    decorators: (field.decorators as Record<string, unknown> | null) ?? {},
    sortOrder: field.sortOrder,
  };
}
```

`src/lib/entity-versioning/bump-suggestion.ts`

```ts
import { computeDiffResult } from "@/lib/diff/field-diff";
import { classifyFromDiff } from "@/services/classification.service";
import type { FieldSnapshot } from "@/services/version-history/version.types";
import type { BumpKind } from "./types";

export interface BumpSuggestion {
  bump: BumpKind;
  /** Human-readable reasons: core field rules + any breaking per-target findings. */
  reasons: string[];
  summary: { added: number; removed: number; modified: number };
}

/**
 * Phase 2a classifier: MAJOR when the existing field-level rules (classifyFromDiff,
 * incl. its BigQuery/Avro/OpenAPI target checks) call the change breaking, else MINOR.
 * Story 14.3's per-format rule tables (Avro / JSON Schema / Proto) replace this in 2b.
 */
export function suggestBump(previous: FieldSnapshot[], current: FieldSnapshot[]): BumpSuggestion {
  const diff = computeDiffResult(previous, current, 0, 0);
  const classification = classifyFromDiff(diff);
  const breakingTargets = classification.perTarget
    .filter((t) => t.changeType === "breaking")
    .map((t) => `${t.target}: ${t.details}`);
  return {
    bump: classification.changeType === "breaking" ? "MAJOR" : "MINOR",
    reasons: [...classification.reasons, ...breakingTargets],
    summary: { added: diff.summary.added, removed: diff.summary.removed, modified: diff.summary.modified },
  };
}
```

`src/lib/entity-versioning/reference-targets.ts`

```ts
export interface ReferenceSourceField {
  id: string;
  decorators: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Entity IDs this entity's draft references (spec §5.1 entity→entity pins):
 * `decorators.referencedEntityId` on any field (reference / array<reference> / map value),
 * plus `metadata.relationships[].targetEntityId` whose `fieldId` is still a field of the entity.
 * Self-references are excluded (an entity cannot pin a version of itself). Sorted for determinism.
 */
export function collectReferencedEntityIds(
  entityId: string,
  fields: ReferenceSourceField[],
  metadata: unknown
): string[] {
  const ids = new Set<string>();
  const fieldIds = new Set(fields.map((f) => f.id));

  for (const field of fields) {
    const target = asRecord(field.decorators).referencedEntityId;
    if (typeof target === "string" && target.trim()) ids.add(target.trim());
  }

  const relationships = asRecord(metadata).relationships;
  if (Array.isArray(relationships)) {
    for (const raw of relationships) {
      const rel = asRecord(raw);
      if (
        typeof rel.targetEntityId === "string" &&
        rel.targetEntityId.trim() &&
        typeof rel.fieldId === "string" &&
        fieldIds.has(rel.fieldId)
      ) {
        ids.add(rel.targetEntityId.trim());
      }
    }
  }

  ids.delete(entityId);
  return [...ids].sort();
}
```

- [ ] **Step 4: Run the tests and expect PASS**

Run: `npx vitest run tests/unit/lib/entity-versioning tests/unit/lib/diff/field-snapshot.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/lib/entity-versioning src/lib/diff/field-snapshot.ts tests/unit/lib/entity-versioning tests/unit/lib/diff/field-snapshot.test.ts
git commit -m "feat(14.1,14.3): pure entity-version helpers — label math, raise-only bump, classifier suggestion, reference targets"
```

---

### Task 2: Schema + migrations (Stories 14.1, 14.7; spec §6.1)

**Files:**
- Modify: `prisma/schema.prisma` (`User`, `Entity`, new enums, `EntityVersion`, `SchemaReference`)
- Create: `prisma/migrations/20261014_entity_versioning/migration.sql`
- Create: `prisma/migrations/20261014_entity_versioning_backfill/migration.sql`
- Test: `tests/integration/db/entity-versioning.test.ts` (PostgreSQL), `tests/integration/db/entity-versioning-pglite.test.ts` (PGlite, in-memory)

**Interfaces:**
- Produces (Prisma): `EntityVersion` model (`entity_versions`), `SchemaReference` model (`schema_references`), enums `EntityVersionChangeKind`, `SchemaReferenceFromKind`, `SchemaReferenceRole`, `SchemaReferenceToKind`; `Entity.latestVersionId String? @unique`, `Entity.hasUnpublishedChanges Boolean @default(true)`, relations `Entity.versions`, `Entity.latestVersion`, `EntityVersion.publishedBy`; compound unique keys `entityId_major_minor`, `entityId_sequence`.

- [ ] **Step 1: Schema edits** (`prisma/schema.prisma`)

In `model User`, add after `webhooks`:

```prisma
  publishedEntityVersions EntityVersion[] @relation("EntityVersionPublisher")
```

In `model Entity`, add after `parentEntityId String?`:

```prisma
  latestVersionId       String?          @unique
  hasUnpublishedChanges Boolean          @default(true)
```

and add after `childEntities Entity[] @relation("EntityInheritance")`:

```prisma
  versions      EntityVersion[] @relation("EntityVersions")
  latestVersion EntityVersion?  @relation("EntityLatestVersion", fields: [latestVersionId], references: [id], onDelete: SetNull)
```

Append a new section after `model Field` (before the Business Concept section):

```prisma
// ============================================================
// Entity Versioning (Epic 14 — Draft + Publish, spec §5)
// ============================================================

enum EntityVersionChangeKind {
  INITIAL
  MINOR
  MAJOR
}

/// Immutable published snapshot of an entity draft (DB trigger forbids UPDATE).
model EntityVersion {
  id                  String                  @id @default(cuid())
  entityId            String
  major               Int
  minor               Int
  /// Monotonic publish counter; Entity.version mirrors the latest one.
  sequence            Int
  /// Phase 2a: the entity's TypeSpec source. Phase 2b adds frozen Data Type copies (14.2).
  resolvedSource      String
  /// FieldSnapshot[] (src/services/version-history/version.types.ts)
  fieldSnapshot       Json
  changeKind          EntityVersionChangeKind
  /// Per-format compatibility findings — {} until Story 14.3.
  compatReport        Json                    @default("{}")
  changeSummary       String?
  publishedById       String
  publishedAt         DateTime                @default(now())
  /// Unused until MAJOR governance (14.4).
  governanceRequestId String?

  entity      Entity  @relation("EntityVersions", fields: [entityId], references: [id], onDelete: Cascade)
  publishedBy User    @relation("EntityVersionPublisher", fields: [publishedById], references: [id])
  latestOf    Entity? @relation("EntityLatestVersion")

  @@unique([entityId, major, minor])
  @@unique([entityId, sequence])
  @@map("entity_versions")
}

enum SchemaReferenceFromKind {
  ENTITY_VERSION
  MESSAGE
  MESSAGE_VERSION
  EVENT_SPEC
  EVENT_SPEC_VERSION
  TRAIT
}

enum SchemaReferenceRole {
  FIELD
  PAYLOAD
  HEADERS
  KEY
  MESSAGE
}

enum SchemaReferenceToKind {
  ENTITY_VERSION
  MESSAGE_VERSION
}

/// One edge table for every pinned link (spec §6.1). Polymorphic — no FKs.
model SchemaReference {
  id        String                  @id @default(cuid())
  fromKind  SchemaReferenceFromKind
  fromId    String
  role      SchemaReferenceRole
  toKind    SchemaReferenceToKind
  toId      String
  isDraft   Boolean                 @default(false)
  createdAt DateTime                @default(now())

  @@unique([fromKind, fromId, role, toKind, toId])
  @@index([toKind, toId])
  @@index([fromKind, fromId])
  @@map("schema_references")
}
```

- [ ] **Step 2: DDL migration** (`prisma/migrations/20261014_entity_versioning/migration.sql`)

```sql
-- Entity versioning, Phase 2a (spec §5.1, §6.1): immutable entity_versions,
-- draft pointers on entities, and the schema_references edge table.
-- Idempotent so a partial apply can be re-run.

-- ── enums ────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "EntityVersionChangeKind" AS ENUM ('INITIAL', 'MINOR', 'MAJOR');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "SchemaReferenceFromKind" AS ENUM ('ENTITY_VERSION', 'MESSAGE', 'MESSAGE_VERSION', 'EVENT_SPEC', 'EVENT_SPEC_VERSION', 'TRAIT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "SchemaReferenceRole" AS ENUM ('FIELD', 'PAYLOAD', 'HEADERS', 'KEY', 'MESSAGE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "SchemaReferenceToKind" AS ENUM ('ENTITY_VERSION', 'MESSAGE_VERSION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── entity_versions ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "entity_versions" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "major" INTEGER NOT NULL,
    "minor" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "resolvedSource" TEXT NOT NULL,
    "fieldSnapshot" JSONB NOT NULL,
    "changeKind" "EntityVersionChangeKind" NOT NULL,
    "compatReport" JSONB NOT NULL DEFAULT '{}',
    "changeSummary" TEXT,
    "publishedById" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "governanceRequestId" TEXT,
    CONSTRAINT "entity_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "entity_versions_entityId_major_minor_key" ON "entity_versions"("entityId", "major", "minor");
CREATE UNIQUE INDEX IF NOT EXISTS "entity_versions_entityId_sequence_key"    ON "entity_versions"("entityId", "sequence");

DO $$ BEGIN
  ALTER TABLE "entity_versions" ADD CONSTRAINT "entity_versions_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "entity_versions" ADD CONSTRAINT "entity_versions_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "entity_versions" ADD CONSTRAINT "entity_versions_numbers_check"
    CHECK ("major" >= 1 AND "minor" >= 0 AND "sequence" >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Immutable: a published version is never edited (publish a new one instead).
-- DELETE stays allowed so deleting an entity cascades its versions.
CREATE OR REPLACE FUNCTION prevent_entity_version_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Entity versions are immutable; publish a new version instead';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS entity_versions_immutable ON "entity_versions";
CREATE TRIGGER entity_versions_immutable
  BEFORE UPDATE ON "entity_versions"
  FOR EACH ROW
  EXECUTE FUNCTION prevent_entity_version_update();

-- ── draft pointers on entities ───────────────────────────────────────────────
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "latestVersionId" TEXT;
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "hasUnpublishedChanges" BOOLEAN NOT NULL DEFAULT true;

CREATE UNIQUE INDEX IF NOT EXISTS "entities_latestVersionId_key" ON "entities"("latestVersionId");

DO $$ BEGIN
  ALTER TABLE "entities" ADD CONSTRAINT "entities_latestVersionId_fkey" FOREIGN KEY ("latestVersionId") REFERENCES "entity_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── schema_references (spec §6.1) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "schema_references" (
    "id" TEXT NOT NULL,
    "fromKind" "SchemaReferenceFromKind" NOT NULL,
    "fromId" TEXT NOT NULL,
    "role" "SchemaReferenceRole" NOT NULL,
    "toKind" "SchemaReferenceToKind" NOT NULL,
    "toId" TEXT NOT NULL,
    "isDraft" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "schema_references_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "schema_references_fromKind_fromId_role_toKind_toId_key"
  ON "schema_references"("fromKind", "fromId", "role", "toKind", "toId");
CREATE INDEX IF NOT EXISTS "schema_references_toKind_toId_idx"     ON "schema_references"("toKind", "toId");
CREATE INDEX IF NOT EXISTS "schema_references_fromKind_fromId_idx" ON "schema_references"("fromKind", "fromId");
```

- [ ] **Step 3: Backfill migration** (`prisma/migrations/20261014_entity_versioning_backfill/migration.sql`). It must stay a **single statement**, because the DB test re-runs it through `$executeRawUnsafe`.

```sql
-- Phase 2a backfill (spec §5.4, Story 14.7): every ACTIVE entity that already
-- has canonical TypeSpec source gets an INITIAL 1.0 version frozen from its
-- current state; DRAFT entities (and ACTIVE ones without source) stay
-- unpublished. sequence mirrors the existing Entity.version so Int consumers
-- (EmissionTargetStatus, DeploymentRecord) keep their numbers. Legacy
-- metadata.versionHistory is left untouched. One statement guarded by
-- NOT EXISTS, so a re-run is a no-op.
WITH inserted AS (
  INSERT INTO "entity_versions"
    ("id", "entityId", "major", "minor", "sequence", "resolvedSource", "fieldSnapshot",
     "changeKind", "compatReport", "changeSummary", "publishedById", "publishedAt")
  SELECT
    'ev_' || md5(e."id" || ':initial'),
    e."id",
    1,
    0,
    GREATEST(e."version", 1),
    e."typespecSource",
    COALESCE(
      (SELECT jsonb_agg(
                jsonb_build_object(
                  'id', f."id", 'name', f."name", 'type', f."type",
                  'precision', f."precision", 'scale', f."scale",
                  'nullable', f."nullable", 'isKey', f."isKey", 'fieldNumber', f."fieldNumber",
                  'description', f."description", 'classification', f."classification",
                  'aliases', to_jsonb(f."aliases"), 'decorators', f."decorators",
                  'sortOrder', f."sortOrder")
                ORDER BY f."sortOrder")
         FROM "fields" f
        WHERE f."entityId" = e."id"),
      '[]'::jsonb),
    'INITIAL'::"EntityVersionChangeKind",
    '{}'::jsonb,
    'Initial version (backfilled from ACTIVE entity)',
    e."ownerId",
    e."updatedAt"
  FROM "entities" e
  WHERE e."status" = 'ACTIVE'
    AND e."typespecSource" IS NOT NULL
    AND e."latestVersionId" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "entity_versions" v WHERE v."entityId" = e."id")
  ON CONFLICT DO NOTHING
  RETURNING "id", "entityId", "sequence"
)
UPDATE "entities" e
   SET "latestVersionId" = i."id",
       "hasUnpublishedChanges" = false,
       "version" = i."sequence"
  FROM inserted i
 WHERE e."id" = i."entityId";
```

- [ ] **Step 4: Apply + generate**

Run: `npm run db:deploy && npm run db:generate`
Expected: both `20261014_entity_versioning` and `20261014_entity_versioning_backfill` applied, and the client regenerated. Then `npx tsc --noEmit` should be clean: the new columns have defaults and no existing create needs them.

- [ ] **Step 5: PostgreSQL integration test** (`tests/integration/db/entity-versioning.test.ts`)

```ts
import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let prisma: PrismaClient;
const TENANT = "tenant_default";

// The statement shipped in the backfill migration, re-run here to prove behaviour + idempotency.
const BACKFILL_SQL = readFileSync(
  join(process.cwd(), "prisma/migrations/20261014_entity_versioning_backfill/migration.sql"),
  "utf8"
)
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

class Rollback extends Error {}

/** Run fn in a transaction that is always rolled back — the backfill touches every eligible row. */
async function inRolledBackTx(fn: (tx: Prisma.TransactionClient) => Promise<void>) {
  try {
    await prisma.$transaction(
      async (tx) => {
        await fn(tx);
        throw new Rollback();
      },
      { timeout: 30_000 }
    );
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

function stamp() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

beforeAll(async () => {
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
});
afterAll(async () => prisma.$disconnect());

describe("entity versioning schema", () => {
  it("backfills INITIAL 1.0 for ACTIVE entities with source, leaves DRAFT and source-less ones, and is idempotent", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await tx.user.findFirstOrThrow();
      const s = stamp();
      const d = await tx.domain.create({ data: { name: `bf-${s}`, slug: `bf-${s}`, tenantId: TENANT } });
      const p = await tx.product.create({ data: { domainId: d.id, name: "P", slug: `p-${s}` } });
      const base = { tenantId: TENANT, domainId: d.id, productId: p.id, ownerId: user.id };

      const active = await tx.entity.create({
        data: {
          ...base, name: "Active", slug: `active-${s}`, status: "ACTIVE", version: 3,
          typespecSource: "model Active { id: string; }",
          fields: { create: [{ name: "id", slug: "id", type: "string", nullable: false, isKey: true, sortOrder: 0 }] },
        },
      });
      const draft = await tx.entity.create({
        data: { ...base, name: "Drafty", slug: `drafty-${s}`, status: "DRAFT", typespecSource: "model Drafty {}" },
      });
      const noSource = await tx.entity.create({
        data: { ...base, name: "NoSource", slug: `nosource-${s}`, status: "ACTIVE" },
      });

      await tx.$executeRawUnsafe(BACKFILL_SQL);
      await tx.$executeRawUnsafe(BACKFILL_SQL);

      const versions = await tx.entityVersion.findMany({ where: { entityId: active.id } });
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({
        major: 1, minor: 0, sequence: 3, changeKind: "INITIAL",
        resolvedSource: "model Active { id: string; }", publishedById: user.id,
      });
      expect((versions[0].fieldSnapshot as Array<{ name: string; isKey: boolean; aliases: string[] }>)[0]).toMatchObject({
        name: "id", isKey: true, aliases: [],
      });

      const a = await tx.entity.findUniqueOrThrow({ where: { id: active.id } });
      expect(a).toMatchObject({ latestVersionId: versions[0].id, hasUnpublishedChanges: false, version: 3 });

      expect(await tx.entityVersion.count({ where: { entityId: { in: [draft.id, noSource.id] } } })).toBe(0);
      const dr = await tx.entity.findUniqueOrThrow({ where: { id: draft.id } });
      expect(dr).toMatchObject({ latestVersionId: null, hasUnpublishedChanges: true });
    });
  });

  it("keeps versions immutable, unique per MAJOR.MINOR and sequence, and cascades them with the entity", async () => {
    let domainId: string | undefined;
    try {
      const user = await prisma.user.findFirstOrThrow();
      const s = stamp();
      const d = await prisma.domain.create({ data: { name: `imm-${s}`, slug: `imm-${s}`, tenantId: TENANT } });
      domainId = d.id;
      const p = await prisma.product.create({ data: { domainId: d.id, name: "P", slug: `p-${s}` } });
      const e = await prisma.entity.create({
        data: { name: "Imm", slug: `imm-${s}`, tenantId: TENANT, domainId: d.id, productId: p.id, ownerId: user.id },
      });
      const row = { entityId: e.id, resolvedSource: "model Imm {}", fieldSnapshot: [], publishedById: user.id };
      const v = await prisma.entityVersion.create({ data: { ...row, major: 1, minor: 0, sequence: 1, changeKind: "INITIAL" } });
      await prisma.entity.update({ where: { id: e.id }, data: { latestVersionId: v.id, hasUnpublishedChanges: false } });

      await expect(prisma.$executeRaw`UPDATE "entity_versions" SET "minor" = 1 WHERE "id" = ${v.id}`).rejects.toThrow(/immutable/);
      await expect(
        prisma.entityVersion.create({ data: { ...row, major: 1, minor: 0, sequence: 2, changeKind: "MINOR" } })
      ).rejects.toThrow(/Unique constraint/);
      await expect(
        prisma.entityVersion.create({ data: { ...row, major: 1, minor: 1, sequence: 1, changeKind: "MINOR" } })
      ).rejects.toThrow(/Unique constraint/);

      // Circular FK (entities.latestVersionId ↔ entity_versions.entityId) must not block the delete.
      await prisma.entity.delete({ where: { id: e.id } });
      expect(await prisma.entityVersion.count({ where: { id: v.id } })).toBe(0);
    } finally {
      if (domainId) await prisma.domain.deleteMany({ where: { id: domainId } });
    }
  });
});
```

- [ ] **Step 6: PGlite integration test** (`tests/integration/db/entity-versioning-pglite.test.ts`). Spec §11 requires migrations to be tested on both providers.

```ts
import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { applyPgliteMigrations } from "@/lib/pglite-migrate";

describe("entity versioning migrations on PGlite", () => {
  it("apply from scratch, enforce immutability and cascade versions with their entity", async () => {
    const db = new PGlite();
    try {
      const applied = await applyPgliteMigrations(db);
      expect(applied).toContain("20261014_entity_versioning");
      expect(applied).toContain("20261014_entity_versioning_backfill");

      const cols = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'entities' AND column_name IN ('latestVersionId', 'hasUnpublishedChanges')`
      );
      expect(cols.rows.map((r) => r.column_name).sort()).toEqual(["hasUnpublishedChanges", "latestVersionId"]);
      const refs = await db.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_references'`);
      expect(refs.rows).toHaveLength(1);

      await db.exec(`INSERT INTO "users" ("id", "email", "updatedAt") VALUES ('u1', 'u1@example.test', CURRENT_TIMESTAMP)`);
      await db.exec(
        `INSERT INTO "entities" ("id", "name", "slug", "tenantId", "ownerId", "updatedAt")
         VALUES ('e1', 'E', 'e', 'tenant_default', 'u1', CURRENT_TIMESTAMP)`
      );
      await db.exec(
        `INSERT INTO "entity_versions" ("id", "entityId", "major", "minor", "sequence", "resolvedSource", "fieldSnapshot", "changeKind", "publishedById")
         VALUES ('v1', 'e1', 1, 0, 1, 'model E {}', '[]', 'INITIAL', 'u1')`
      );
      await db.exec(`UPDATE "entities" SET "latestVersionId" = 'v1', "hasUnpublishedChanges" = false WHERE "id" = 'e1'`);

      await expect(db.exec(`UPDATE "entity_versions" SET "minor" = 1 WHERE "id" = 'v1'`)).rejects.toThrow(/immutable/);

      await db.exec(`DELETE FROM "entities" WHERE "id" = 'e1'`);
      const left = await db.query(`SELECT 1 FROM "entity_versions" WHERE "id" = 'v1'`);
      expect(left.rows).toHaveLength(0);
    } finally {
      await db.close();
    }
  }, 60_000);
});
```

- [ ] **Step 7: Run**

Run: `npx vitest run tests/integration/db/entity-versioning.test.ts tests/integration/db/entity-versioning-pglite.test.ts tests/integration/db/asset-levels.test.ts`
Expected: PASS. `asset-levels` is included to show the earlier migrations still behave.

- [ ] **Step 8: Verify + commit**

Run `npx tsc --noEmit` (clean) and `npx vitest run` (only the 8 baseline failures).

```bash
git add prisma/schema.prisma prisma/migrations/20261014_entity_versioning prisma/migrations/20261014_entity_versioning_backfill tests/integration/db/entity-versioning.test.ts tests/integration/db/entity-versioning-pglite.test.ts
git commit -m "feat(14.1,14.7): EntityVersion + SchemaReference tables, draft pointers, immutability trigger, ACTIVE→1.0 backfill"
```

---

### Task 3: Draft tracking on every draft-mutating path (Story 14.1)

**Files:**
- Create: `src/lib/entity-versioning/draft-state.ts`, `src/lib/entity-versioning/draft-label.ts`
- Modify: `src/services/field.service.ts` (`createField`, `updateField`, `deleteField`, `reorderFields`)
- Modify: `src/services/entity.service.ts` (`updateEntity`)
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions.ts` (`addFieldAction`, `updateFieldAction`, `deleteFieldAction`, `applyTypeSpecAction`, `updateEntityRelationshipsAction`, `updateEntityMetadataAction`, `updateEntityDescriptionAction`, `compileAndApplyTypeSpecSourceAction`)
- Modify: `src/app/(dashboard)/governance/retention/actions.ts` (`updateRetentionPolicyAction`)
- Test: `tests/unit/lib/entity-versioning/draft-state.test.ts` (create), `tests/unit/app/entity-draft-marking.test.ts` (create), `tests/unit/services/field.service.test.ts` (modify), `tests/unit/services/entity.service.test.ts` (modify)

**Complete inventory of draft-mutating paths** (verified by `grep -rn "\.field\.\(create\|update\|delete\)\|\.entity\.update" src`). tRPC (`src/server/api/routers/{entity,field}.ts`) and REST (`src/app/api/v1/schemas/**`) both delegate to the two services, so they are covered.

| Path | How it is marked |
|---|---|
| `field.service` create / update / delete / reorder | `markEntityDraftChanged` after the write |
| `entity.service.updateEntity` (name, description, draft metadata; not status-only, not lifecycle `deprecation`) | `hasUnpublishedChanges: true` in the same update |
| `addFieldAction`, `updateFieldAction` (also used by field studio), `deleteFieldAction` | `markEntityDraftChanged` after the write |
| `applyTypeSpecAction` (TypeSpec preview apply + source save) | `markEntityDraftChanged` once, when anything was added, updated or removed |
| `compileAndApplyTypeSpecSourceAction` | flag written with `typespecSource` |
| `updateEntityDescriptionAction`, `updateEntityRelationshipsAction` | flag written with the change |
| `updateEntityMetadataAction` (tags/owner, retention editor) | flag when `metadataChangesDraft` |
| `governance/retention/actions.ts updateRetentionPolicyAction` | flag when `metadataChangesDraft` |
| **Not draft changes (left as is):** `generateSchemaAction`, `publishSchemaAction`, `deploySchemaAction`, `saveSchemaFieldTypeOverrideAction` (they write `schemaVersions` / `schemaTargetTypeOverrides` bookkeeping); `typespec-source-migration.service` (system backfill); entity creation (new rows default to `true`) | — |

Ordering: a separate `markEntityDraftChanged` call runs **after** the write, inside the same `withAudit` fn or `try`, so a failure surfaces as an error the user can retry. Publish takes a row lock (Task 5), so a mark that lands during a publish waits and then sets `true`, which is correct.

**Interfaces:**
- Produces: `DRAFT_NEUTRAL_METADATA_KEYS: ReadonlySet<string>`; `metadataChangesDraft(before: unknown, after: unknown): boolean`; `entityUpdateTouchesDraft(before: { name: string; description: string; metadata: unknown }, input: { name?: string; description?: string; status?: string; metadata?: unknown }): boolean`; `markEntityDraftChanged(db: PrismaClient | Prisma.TransactionClient, entityId: string): Promise<void>`; `DraftVersionState`; `describeDraftState(s: DraftVersionState): string`; `toDraftVersionState(e: { hasUnpublishedChanges: boolean; latestVersion: VersionNumber | null }): DraftVersionState`.

- [ ] **Step 1: Failing pure tests** (`tests/unit/lib/entity-versioning/draft-state.test.ts`)

```ts
import { describe, it, expect, vi } from "vitest";
import {
  metadataChangesDraft,
  entityUpdateTouchesDraft,
  markEntityDraftChanged,
} from "@/lib/entity-versioning/draft-state";
import { describeDraftState, toDraftVersionState } from "@/lib/entity-versioning/draft-label";

describe("metadataChangesDraft", () => {
  it("treats tag, owner, relationship and retention edits as draft changes", () => {
    expect(metadataChangesDraft({ tags: ["a"] }, { tags: ["a", "b"] })).toBe(true);
    expect(metadataChangesDraft({}, { owner: "team-x" })).toBe(true);
    expect(
      metadataChangesDraft({ relationships: [] }, { relationships: [{ targetEntityId: "c", fieldId: "f", cardinality: "many-to-one" }] })
    ).toBe(true);
    expect(metadataChangesDraft({}, { retentionPolicy: { period: "P1Y" } })).toBe(true);
  });

  it("ignores system bookkeeping and lifecycle keys", () => {
    expect(metadataChangesDraft({ tags: ["a"] }, { tags: ["a"], schemaVersions: { avro: [] } })).toBe(false);
    expect(
      metadataChangesDraft(
        {},
        {
          schemaTargetTypeOverrides: {},
          semanticVersion: { major: 2, minor: 0 },
          versionHistory: [],
          typespecMigration: { status: "FLAGGED" },
          deprecation: { deprecated: true },
        }
      )
    ).toBe(false);
  });

  it("treats null, undefined and {} as the same empty metadata", () => {
    expect(metadataChangesDraft(null, {})).toBe(false);
    expect(metadataChangesDraft(undefined, null)).toBe(false);
  });
});

describe("entityUpdateTouchesDraft", () => {
  const before = { name: "Order", description: "", metadata: { tags: [] } };

  it("is false for a status-only update", () => {
    expect(entityUpdateTouchesDraft(before, { status: "ACTIVE" })).toBe(false);
  });

  it("is false when name and description are resent unchanged", () => {
    expect(entityUpdateTouchesDraft(before, { name: "Order", description: "" })).toBe(false);
  });

  it("is true for a rename, a description edit, or a draft metadata edit", () => {
    expect(entityUpdateTouchesDraft(before, { name: "PurchaseOrder" })).toBe(true);
    expect(entityUpdateTouchesDraft(before, { description: "Orders placed online" })).toBe(true);
    expect(entityUpdateTouchesDraft(before, { metadata: { tags: ["sales"] } })).toBe(true);
  });

  it("is false when only lifecycle metadata changes", () => {
    expect(entityUpdateTouchesDraft(before, { status: "DEPRECATED", metadata: { tags: [], deprecation: { deprecated: true } } })).toBe(false);
  });
});

describe("markEntityDraftChanged", () => {
  it("sets hasUnpublishedChanges on the entity row", async () => {
    const update = vi.fn().mockResolvedValue({ id: "e1" });
    await markEntityDraftChanged({ entity: { update } } as never, "e1");
    expect(update).toHaveBeenCalledWith({ where: { id: "e1" }, data: { hasUnpublishedChanges: true }, select: { id: true } });
  });
});

describe("describeDraftState / toDraftVersionState", () => {
  it("renders the three header states (spec §5.3)", () => {
    expect(describeDraftState({ latestVersionLabel: null, hasUnpublishedChanges: true })).toBe("Never published");
    expect(describeDraftState({ latestVersionLabel: "2.1", hasUnpublishedChanges: true })).toBe(
      "Draft · unpublished changes · latest v2.1"
    );
    expect(describeDraftState({ latestVersionLabel: "2.1", hasUnpublishedChanges: false })).toBe("Published · v2.1");
  });

  it("maps a loaded entity to the header state", () => {
    expect(toDraftVersionState({ hasUnpublishedChanges: false, latestVersion: { major: 3, minor: 0 } })).toEqual({
      latestVersionLabel: "3.0",
      hasUnpublishedChanges: false,
    });
    expect(toDraftVersionState({ hasUnpublishedChanges: true, latestVersion: null })).toEqual({
      latestVersionLabel: null,
      hasUnpublishedChanges: true,
    });
  });
});
```

- [ ] **Step 2: Failing action tests** (`tests/unit/app/entity-draft-marking.test.ts`)

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma, mockCompile } = vi.hoisted(() => ({
  mockPrisma: {
    entity: { findUnique: vi.fn(), update: vi.fn() },
    field: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  },
  mockCompile: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/compiler/typespec-compiler", () => ({ compileTypeSpecWithGovernance: mockCompile }));

import {
  addFieldAction,
  updateFieldAction,
  deleteFieldAction,
  applyTypeSpecAction,
  updateEntityDescriptionAction,
  updateEntityMetadataAction,
  updateEntityRelationshipsAction,
  compileAndApplyTypeSpecSourceAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";

const MARK = { where: { id: "ent-1" }, data: { hasUnpublishedChanges: true }, select: { id: true } };

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
  mockPrisma.entity.update.mockResolvedValue({ id: "ent-1" });
  mockPrisma.field.findFirst.mockResolvedValue(null);
  mockPrisma.field.findMany.mockResolvedValue([]);
});

describe("draft-mutating entity actions set hasUnpublishedChanges", () => {
  it("addFieldAction", async () => {
    mockPrisma.field.create.mockResolvedValue({ id: "fld-1", entityId: "ent-1" });
    expect(await addFieldAction("ent-1", "email", "string")).toMatchObject({ success: true });
    expect(mockPrisma.entity.update).toHaveBeenCalledWith(MARK);
  });

  it("updateFieldAction", async () => {
    mockPrisma.field.findUnique.mockResolvedValue({ id: "fld-1", entityId: "ent-1", name: "email" });
    mockPrisma.field.update.mockResolvedValue({ id: "fld-1" });
    expect(await updateFieldAction("fld-1", { description: "Primary email" })).toEqual({ success: true });
    expect(mockPrisma.entity.update).toHaveBeenCalledWith(MARK);
  });

  it("deleteFieldAction", async () => {
    mockPrisma.field.findUnique.mockResolvedValue({ id: "fld-1", entityId: "ent-1", name: "email", type: "string" });
    mockPrisma.field.delete.mockResolvedValue({ id: "fld-1" });
    expect(await deleteFieldAction("fld-1")).toEqual({ success: true });
    expect(mockPrisma.entity.update).toHaveBeenCalledWith(MARK);
  });

  it("applyTypeSpecAction marks only when something changed", async () => {
    await applyTypeSpecAction("ent-1", []);
    expect(mockPrisma.entity.update).not.toHaveBeenCalled();

    mockPrisma.field.create.mockResolvedValue({ id: "fld-2" });
    await applyTypeSpecAction("ent-1", [{ name: "phone", type: "string", isOptional: true, isKey: false, decorators: {} }]);
    expect(mockPrisma.entity.update).toHaveBeenCalledWith(MARK);
  });

  it("updateEntityDescriptionAction writes the flag with the description", async () => {
    await updateEntityDescriptionAction("ent-1", "Orders placed online");
    expect(mockPrisma.entity.update).toHaveBeenCalledWith({
      where: { id: "ent-1" },
      data: { description: "Orders placed online", hasUnpublishedChanges: true },
    });
  });

  it("updateEntityRelationshipsAction writes the flag with the relationships", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue({ metadata: {} });
    const relationships = [{ targetEntityId: "cust", fieldId: "fld-1", cardinality: "many-to-one" as const }];
    await updateEntityRelationshipsAction("ent-1", relationships);
    expect(mockPrisma.entity.update).toHaveBeenCalledWith({
      where: { id: "ent-1" },
      data: { metadata: { relationships }, hasUnpublishedChanges: true },
    });
  });

  it("updateEntityMetadataAction flags tag edits but not bookkeeping keys", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue({ metadata: { tags: ["a"] } });
    await updateEntityMetadataAction("ent-1", { tags: ["a", "b"] });
    expect(mockPrisma.entity.update).toHaveBeenLastCalledWith({
      where: { id: "ent-1" },
      data: { metadata: { tags: ["a", "b"] }, hasUnpublishedChanges: true },
    });

    await updateEntityMetadataAction("ent-1", { schemaVersions: { avro: [] } });
    expect(mockPrisma.entity.update).toHaveBeenLastCalledWith({
      where: { id: "ent-1" },
      data: { metadata: { tags: ["a"], schemaVersions: { avro: [] } } },
    });
  });

  it("compileAndApplyTypeSpecSourceAction saves source and flag together", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", typespecSource: null });
    mockCompile.mockResolvedValue({
      success: true,
      diagnostics: [],
      document: { models: [{ name: "Order", fields: [] }] },
      fieldGovernance: {},
    });
    const res = await compileAndApplyTypeSpecSourceAction("ent-1", "model Order {}");
    expect(res.success).toBe(true);
    expect(mockPrisma.entity.update).toHaveBeenCalledWith({
      where: { id: "ent-1" },
      data: { typespecSource: "model Order {}", hasUnpublishedChanges: true },
    });
  });
});
```

- [ ] **Step 3: Extend the service tests**

In `tests/unit/services/field.service.test.ts`, change the `entity` mock to `entity: { findUnique: vi.fn(), update: vi.fn() },` and append inside `describe("Field Service", …)`:

```ts
  describe("draft tracking", () => {
    const MARK = { where: { id: "ent-1" }, data: { hasUnpublishedChanges: true }, select: { id: true } };

    it("createField marks the entity draft as changed", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({ id: "ent-1" } as never);
      vi.mocked(prisma.field.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.field.create).mockResolvedValue({ id: "fld-1", entityId: "ent-1" } as never);
      await createField("ent-1", { name: "email", type: "string" }, mockCtx);
      expect(prisma.entity.update).toHaveBeenCalledWith(MARK);
    });

    it("updateField marks the owning entity", async () => {
      vi.mocked(prisma.field.findUnique).mockResolvedValue({ id: "fld-1", entityId: "ent-1", name: "email" } as never);
      vi.mocked(prisma.field.update).mockResolvedValue({ id: "fld-1" } as never);
      await updateField("fld-1", { description: "Primary email" }, mockCtx);
      expect(prisma.entity.update).toHaveBeenCalledWith(MARK);
    });

    it("deleteField marks the owning entity", async () => {
      vi.mocked(prisma.field.findUnique).mockResolvedValue({ id: "fld-1", entityId: "ent-1", name: "email" } as never);
      vi.mocked(prisma.field.delete).mockResolvedValue({ id: "fld-1" } as never);
      await deleteField("fld-1", mockCtx);
      expect(prisma.entity.update).toHaveBeenCalledWith(MARK);
    });

    it("reorderFields marks the entity", async () => {
      vi.mocked(prisma.field.findMany).mockResolvedValue([{ id: "fld-1", sortOrder: 0 }] as never);
      vi.mocked(prisma.$transaction).mockResolvedValue([]);
      await reorderFields("ent-1", ["fld-1"], mockCtx);
      expect(prisma.entity.update).toHaveBeenCalledWith(MARK);
    });
  });
```

In `tests/unit/services/entity.service.test.ts`, append inside `describe("updateEntity", …)`:

```ts
    it("flags the draft when the description changes", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({ ...existing, description: "", metadata: null } as never);
      vi.mocked(prisma.entity.update).mockResolvedValue({ ...existing, description: "d" } as never);

      await updateEntity("ent-1", { description: "d" }, mockCtx);

      expect(prisma.entity.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ description: "d", hasUnpublishedChanges: true }) })
      );
    });

    it("does not flag the draft on a status-only change", async () => {
      vi.mocked(prisma.entity.findUnique).mockResolvedValue({ ...existing, description: "", metadata: null } as never);
      vi.mocked(prisma.entity.update).mockResolvedValue({ ...existing, status: "ACTIVE" } as never);

      const result = await updateEntity("ent-1", { status: "ACTIVE" }, mockCtx);

      expect(result.success).toBe(true);
      const call = vi.mocked(prisma.entity.update).mock.calls[0][0] as { data: Record<string, unknown> };
      expect(call.data).not.toHaveProperty("hasUnpublishedChanges");
    });
```

- [ ] **Step 4: Run to verify failure**

Run: `npx vitest run tests/unit/lib/entity-versioning/draft-state.test.ts tests/unit/app/entity-draft-marking.test.ts tests/unit/services/field.service.test.ts tests/unit/services/entity.service.test.ts`
Expected: FAIL. The draft-state module is missing, and the new marking assertions are not yet met.

- [ ] **Step 5: Implement the helpers**

`src/lib/entity-versioning/draft-state.ts`

```ts
import type { PrismaClient, Prisma } from "@/generated/prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Entity metadata keys that never dirty the draft: system bookkeeping
 * (per-target emitted schemas, type overrides, legacy 2-22 version data,
 * Story 12.7 migration flags) and lifecycle state (deprecation travels with a
 * status transition). Every other key — tags, owner, relationships,
 * retentionPolicy, custom, and any key added later — is a draft change.
 */
export const DRAFT_NEUTRAL_METADATA_KEYS: ReadonlySet<string> = new Set([
  "schemaVersions",
  "schemaTargetTypeOverrides",
  "semanticVersion",
  "versionHistory",
  "typespecMigration",
  "deprecation",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** True when any non-neutral metadata key differs between before and after. */
export function metadataChangesDraft(before: unknown, after: unknown): boolean {
  const a = asRecord(before);
  const b = asRecord(after);
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (DRAFT_NEUTRAL_METADATA_KEYS.has(key)) continue;
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return true;
  }
  return false;
}

/** Whether an updateEntity input changes the draft (status-only transitions do not). */
export function entityUpdateTouchesDraft(
  before: { name: string; description: string; metadata: unknown },
  input: { name?: string; description?: string; status?: string; metadata?: unknown }
): boolean {
  if (input.name !== undefined && input.name !== before.name) return true;
  if (input.description !== undefined && input.description !== before.description) return true;
  if (input.metadata !== undefined && metadataChangesDraft(before.metadata, input.metadata)) return true;
  return false;
}

/** Flag the entity's draft as diverged from its latest published version. */
export async function markEntityDraftChanged(db: Db, entityId: string): Promise<void> {
  await db.entity.update({ where: { id: entityId }, data: { hasUnpublishedChanges: true }, select: { id: true } });
}
```

`src/lib/entity-versioning/draft-label.ts`

```ts
import { formatVersionLabel } from "./version-math";
import type { VersionNumber } from "./types";

/** What the entity header shows about Draft + Publish (spec §5.3). Client-safe. */
export interface DraftVersionState {
  latestVersionLabel: string | null;
  hasUnpublishedChanges: boolean;
}

export function describeDraftState(state: DraftVersionState): string {
  if (!state.latestVersionLabel) return "Never published";
  if (state.hasUnpublishedChanges) return `Draft · unpublished changes · latest v${state.latestVersionLabel}`;
  return `Published · v${state.latestVersionLabel}`;
}

/** Page loaders call this with the entity row (+ `latestVersion: { major, minor }` include). */
export function toDraftVersionState(entity: {
  hasUnpublishedChanges: boolean;
  latestVersion: VersionNumber | null;
}): DraftVersionState {
  return {
    latestVersionLabel: entity.latestVersion ? formatVersionLabel(entity.latestVersion) : null,
    hasUnpublishedChanges: entity.hasUnpublishedChanges,
  };
}
```

- [ ] **Step 6: Wire `field.service.ts`.** Add `import { markEntityDraftChanged } from "@/lib/entity-versioning/draft-state";`, then:

`createField`, replace the `fn` body:

```ts
      fn: async () => {
        const created = await prisma.field.create({
          data: {
            entityId,
            name: parsed.data.name,
            slug: generateSlug(parsed.data.name),
            type: parsed.data.type,
            precision: parsed.data.precision,
            scale: parsed.data.scale,
            nullable: parsed.data.nullable,
            isKey: parsed.data.isKey,
            fieldNumber: parsed.data.fieldNumber,
            description: parsed.data.description,
            aliases: parsed.data.aliases,
            classification: parsed.data.classification ?? "SENSITIVE",
            sortOrder: nextSortOrder,
            decorators:
              (parsed.data.decorators as unknown as Prisma.InputJsonValue) ??
              {},
          },
        });
        await markEntityDraftChanged(prisma, entityId);
        return created;
      },
```

`updateField`, replace `return prisma.field.update({ where: { id }, data: updateData });` with:

```ts
      const updated = await prisma.field.update({
        where: { id },
        data: updateData,
      });
      await markEntityDraftChanged(prisma, existing.entityId);
      return updated;
```

`deleteField`, replace the `fn` body:

```ts
    fn: async () => {
      await prisma.field.delete({ where: { id } });
      await markEntityDraftChanged(prisma, existing.entityId);
      return null;
    },
```

`reorderFields`, after the `await prisma.$transaction(...)` call inside `fn`, add `await markEntityDraftChanged(prisma, entityId);` before `return null;`.

- [ ] **Step 7: Wire `entity.service.ts` `updateEntity`.** Add `import { entityUpdateTouchesDraft } from "@/lib/entity-versioning/draft-state";` and replace the `const update = {…} satisfies Prisma.EntityUpdateArgs;` block:

```ts
        const touchesDraft = entityUpdateTouchesDraft(existing, parsed.data);
        const update = {
          where: { id },
          data: {
            ...parsed.data,
            metadata:
              parsed.data.metadata !== undefined
                ? (parsed.data.metadata as unknown as Prisma.InputJsonValue)
                : undefined,
            ...(touchesDraft && { hasUnpublishedChanges: true }),
          },
          include: { domain: true },
        } satisfies Prisma.EntityUpdateArgs;
```

- [ ] **Step 8: Wire `[entityId]/actions.ts`.** Add imports:

```ts
import { markEntityDraftChanged, metadataChangesDraft } from "@/lib/entity-versioning/draft-state";
```

`addFieldAction`, replace `fn: () => prisma.field.create({ … }),` with:

```ts
      fn: async () => {
        const created = await prisma.field.create({
          data: {
            entityId,
            name,
            slug: generateSlug(name),
            type,
            sortOrder: maxField ? maxField.sortOrder + 1 : 0,
            ...(opts?.description != null && { description: opts.description }),
            classification: opts?.classification !== undefined ? opts.classification : "SENSITIVE",
            ...(opts?.nullable != null && { nullable: opts.nullable }),
            ...(opts?.isKey != null && { isKey: opts.isKey }),
            ...(opts?.precision !== undefined && { precision: opts.precision }),
            ...(opts?.scale !== undefined && { scale: opts.scale }),
            fieldNumber: assignedFieldNumber,
            ...(opts?.aliases && { aliases: opts.aliases }),
            ...(opts?.decorators && { decorators: opts.decorators as Prisma.InputJsonValue }),
          },
        });
        await markEntityDraftChanged(prisma, entityId);
        return created;
      },
```

`updateFieldAction`, replace `fn: () => prisma.field.update({ … }),` with:

```ts
      fn: async () => {
        const updated = await prisma.field.update({
          where: { id: fieldId },
          data: {
            ...rest,
            ...(decorators !== undefined && { decorators: decorators as Prisma.InputJsonValue }),
          },
        });
        await markEntityDraftChanged(prisma, existing.entityId);
        return updated;
      },
```

`deleteFieldAction`, replace the `withAudit` `fn`:

```ts
      fn: async () => {
        await prisma.field.delete({ where: { id: fieldId } });
        await markEntityDraftChanged(prisma, existing.entityId);
        return null;
      },
```

`applyTypeSpecAction`, insert immediately before `revalidatePath("/schemas");` (after the removal loop):

```ts
    if (addedCount + updatedCount + removedNames.length > 0) {
      await markEntityDraftChanged(prisma, entityId);
    }
```

`updateEntityRelationshipsAction`, change the update `data` to:

```ts
          data: { metadata: updatedMeta as unknown as Prisma.InputJsonValue, hasUnpublishedChanges: true },
```

`updateEntityMetadataAction`, change the update `data` to:

```ts
          data: {
            metadata: updatedMeta as unknown as Prisma.InputJsonValue,
            ...(metadataChangesDraft(existingMeta, updatedMeta) && { hasUnpublishedChanges: true }),
          },
```

`updateEntityDescriptionAction`, change the update `data` to `{ description, hasUnpublishedChanges: true }`.

`compileAndApplyTypeSpecSourceAction`, change the final update `data` to `{ typespecSource: source, hasUnpublishedChanges: true }`.

- [ ] **Step 9: Wire `governance/retention/actions.ts`.** Add `import { metadataChangesDraft } from "@/lib/entity-versioning/draft-state";` and change the update in `updateRetentionPolicyAction` to:

```ts
    await prisma.entity.update({
      where: { id: entityId },
      data: {
        metadata: updatedMeta as Prisma.InputJsonValue,
        ...(metadataChangesDraft(existingMeta, updatedMeta) && { hasUnpublishedChanges: true }),
      },
    });
```

- [ ] **Step 10: Run the tests and expect PASS**, then the full suite

Run: `npx vitest run tests/unit/lib/entity-versioning tests/unit/app/entity-draft-marking.test.ts tests/unit/services tests/unit/features/lifecycle.test.ts tests/integration/e2e-critical-flows.test.ts tests/integration/critical-paths.test.ts`
Expected: PASS, except the one pre-existing e2e-critical-flows bigquery failure. Then `npx tsc --noEmit` should be clean and `npx vitest run` should show only the 8 baseline failures.

- [ ] **Step 11: Commit**

```bash
git add src/lib/entity-versioning/draft-state.ts src/lib/entity-versioning/draft-label.ts src/services/field.service.ts src/services/entity.service.ts "src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions.ts" "src/app/(dashboard)/governance/retention/actions.ts" tests/unit/lib/entity-versioning/draft-state.test.ts tests/unit/app/entity-draft-marking.test.ts tests/unit/services/field.service.test.ts tests/unit/services/entity.service.test.ts
git commit -m "feat(14.1): every draft-mutating path sets hasUnpublishedChanges; bookkeeping metadata stays neutral"
```

---

### Task 4: Publish planner, pure (Stories 14.2 pins, 14.3 suggestion, 14.4 rules)

**Files:**
- Create: `src/lib/entity-versioning/publish-plan.ts`
- Test: `tests/unit/lib/entity-versioning/publish-plan.test.ts`

**Interfaces:**
- Consumes: `suggestBump`, `nextVersionNumber`, `resolveBump`, `formatVersionLabel`, `INITIAL_VERSION` (Task 1).
- Produces:
  ```ts
  interface PublishState {
    entity: { id: string; name: string; status: string; version: number; hasUnpublishedChanges: boolean; typespecSource: string | null };
    latest: { id: string; major: number; minor: number; sequence: number; fieldSnapshot: FieldSnapshot[] } | null;
    currentFields: FieldSnapshot[];
    /** entityName null = referenced entity no longer exists */
    references: Array<{ entityId: string; entityName: string | null; latestVersionId: string | null }>;
  }
  type PublishBlocker =
    | { kind: "RETIRED"; message: string }
    | { kind: "NO_CHANGES"; message: string }
    | { kind: "UNPUBLISHED_REFERENCE"; entityId: string; entityName: string; message: string }
    | { kind: "MISSING_REFERENCE"; entityId: string; message: string };
  interface ReferencePin { entityId: string; entityName: string; versionId: string }
  interface PublishAnalysis {
    isFirstPublish: boolean; latestLabel: string | null; suggestedBump: BumpKind | null;
    candidateLabels: Record<BumpKind, string> | null; initialLabel: string; reasons: string[];
    diffSummary: { added: number; removed: number; modified: number }; blockers: PublishBlocker[]; pins: ReferencePin[];
  }
  interface PublishPlan { version: VersionNumber; label: string; sequence: number; changeKind: ChangeKind; pins: ReferencePin[] }
  function analyzePublish(state: PublishState): PublishAnalysis;
  function planPublish(state: PublishState, requested?: BumpKind): Result<PublishPlan>;
  ```

- [ ] **Step 1: Failing tests** (`tests/unit/lib/entity-versioning/publish-plan.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { analyzePublish, planPublish, type PublishState } from "@/lib/entity-versioning/publish-plan";
import type { FieldSnapshot } from "@/services/version-history/version.types";

function f(name: string, extra: Partial<FieldSnapshot> = {}): FieldSnapshot {
  return {
    id: `id-${name}`, name, type: "string", precision: null, scale: null, nullable: true, isKey: false,
    fieldNumber: null, description: "", classification: null, aliases: [], decorators: {}, sortOrder: 0,
    ...extra,
  };
}

const ID = f("id", { nullable: false, isKey: true });
const EMAIL = f("email");
const ENTITY: PublishState["entity"] = {
  id: "order", name: "Order", status: "DRAFT", version: 1, hasUnpublishedChanges: true, typespecSource: "model Order {}",
};

function state(overrides: Partial<PublishState> = {}): PublishState {
  return { entity: ENTITY, latest: null, currentFields: [ID], references: [], ...overrides };
}

const published = (fields: FieldSnapshot[]) => ({ id: "v-5", major: 2, minor: 1, sequence: 5, fieldSnapshot: fields });

describe("first publish", () => {
  it("is 1.0 INITIAL with sequence mirroring Entity.version", () => {
    expect(planPublish(state())).toEqual({
      success: true,
      data: { version: { major: 1, minor: 0 }, label: "1.0", sequence: 1, changeKind: "INITIAL", pins: [] },
    });
    const legacy = planPublish(state({ entity: { ...ENTITY, version: 4 } }));
    expect(legacy.success && legacy.data.sequence).toBe(4);
  });

  it("ignores a requested bump", () => {
    const res = planPublish(state(), "MAJOR");
    expect(res.success && res.data.label).toBe("1.0");
  });

  it("offers only the initial label", () => {
    expect(analyzePublish(state())).toMatchObject({
      isFirstPublish: true, latestLabel: null, suggestedBump: null, candidateLabels: null, initialLabel: "1.0", blockers: [],
    });
  });
});

describe("later publishes", () => {
  it("suggests MINOR for an additive change and allows raising to MAJOR", () => {
    const s = state({ latest: published([ID]), currentFields: [ID, EMAIL] });
    expect(analyzePublish(s)).toMatchObject({
      isFirstPublish: false, suggestedBump: "MINOR", latestLabel: "2.1", candidateLabels: { MINOR: "2.2", MAJOR: "3.0" },
    });
    expect(planPublish(s)).toMatchObject({ success: true, data: { label: "2.2", changeKind: "MINOR", sequence: 6 } });
    expect(planPublish(s, "MAJOR")).toMatchObject({ success: true, data: { label: "3.0", changeKind: "MAJOR", sequence: 6 } });
  });

  it("suggests MAJOR for a breaking change and refuses MINOR", () => {
    const s = state({ latest: published([ID, EMAIL]), currentFields: [ID] });
    expect(analyzePublish(s).suggestedBump).toBe("MAJOR");
    const low = planPublish(s, "MINOR");
    expect(!low.success && low.error.code).toBe("BUMP_TOO_LOW");
    expect(planPublish(s)).toMatchObject({ success: true, data: { label: "3.0", changeKind: "MAJOR" } });
  });
});

describe("blockers and pins", () => {
  it("blocks when nothing changed since the latest version", () => {
    const s = state({ latest: published([ID]), entity: { ...ENTITY, hasUnpublishedChanges: false } });
    expect(analyzePublish(s).blockers).toEqual([{ kind: "NO_CHANGES", message: "No unpublished changes since v2.1." }]);
  });

  it("reports every blocker together", () => {
    const s = state({
      entity: { ...ENTITY, status: "RETIRED" },
      references: [
        { entityId: "cust", entityName: "Customer", latestVersionId: null },
        { entityId: "gone", entityName: null, latestVersionId: null },
        { entityId: "addr", entityName: "Address", latestVersionId: "v-addr-3" },
      ],
    });
    const analysis = analyzePublish(s);
    expect(analysis.blockers.map((b) => b.kind)).toEqual(["RETIRED", "UNPUBLISHED_REFERENCE", "MISSING_REFERENCE"]);
    expect(analysis.pins).toEqual([{ entityId: "addr", entityName: "Address", versionId: "v-addr-3" }]);

    const res = planPublish(s);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe("PUBLISH_BLOCKED");
      expect(res.error.message).toContain("Publish Customer first");
      expect((res.error.details as { blockers: unknown[] }).blockers).toHaveLength(3);
    }
  });

  it("pins the latest published version of each referenced entity", () => {
    const s = state({ references: [{ entityId: "addr", entityName: "Address", latestVersionId: "v-addr-3" }] });
    expect(planPublish(s)).toMatchObject({
      success: true,
      data: { pins: [{ entityId: "addr", entityName: "Address", versionId: "v-addr-3" }] },
    });
  });
});
```

- [ ] **Step 2: Run to verify failure.** Run `npx vitest run tests/unit/lib/entity-versioning/publish-plan.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement** (`src/lib/entity-versioning/publish-plan.ts`)

```ts
import { ok, err, type Result } from "@/types/result";
import type { FieldSnapshot } from "@/services/version-history/version.types";
import { suggestBump } from "./bump-suggestion";
import { INITIAL_VERSION, formatVersionLabel, nextVersionNumber, resolveBump } from "./version-math";
import type { BumpKind, ChangeKind, VersionNumber } from "./types";

export interface PublishState {
  entity: {
    id: string;
    name: string;
    status: string;
    version: number;
    hasUnpublishedChanges: boolean;
    typespecSource: string | null;
  };
  latest: { id: string; major: number; minor: number; sequence: number; fieldSnapshot: FieldSnapshot[] } | null;
  currentFields: FieldSnapshot[];
  /** One entry per referenced entity; `entityName: null` means it no longer exists. */
  references: Array<{ entityId: string; entityName: string | null; latestVersionId: string | null }>;
}

export type PublishBlocker =
  | { kind: "RETIRED"; message: string }
  | { kind: "NO_CHANGES"; message: string }
  | { kind: "UNPUBLISHED_REFERENCE"; entityId: string; entityName: string; message: string }
  | { kind: "MISSING_REFERENCE"; entityId: string; message: string };

export interface ReferencePin {
  entityId: string;
  entityName: string;
  versionId: string;
}

export interface PublishAnalysis {
  isFirstPublish: boolean;
  latestLabel: string | null;
  /** null on a first publish (always 1.0). */
  suggestedBump: BumpKind | null;
  /** Next label per bump; null on a first publish. */
  candidateLabels: Record<BumpKind, string> | null;
  initialLabel: string;
  reasons: string[];
  diffSummary: { added: number; removed: number; modified: number };
  blockers: PublishBlocker[];
  pins: ReferencePin[];
}

export interface PublishPlan {
  version: VersionNumber;
  label: string;
  sequence: number;
  changeKind: ChangeKind;
  pins: ReferencePin[];
}

/** Everything the publish dialog shows. Never fails — blockers are data. */
export function analyzePublish(state: PublishState): PublishAnalysis {
  const { entity, latest } = state;
  const blockers: PublishBlocker[] = [];

  if (entity.status === "RETIRED") {
    blockers.push({ kind: "RETIRED", message: "Retired entities are read-only and cannot be published." });
  }
  if (latest && !entity.hasUnpublishedChanges) {
    blockers.push({ kind: "NO_CHANGES", message: `No unpublished changes since v${formatVersionLabel(latest)}.` });
  }

  const pins: ReferencePin[] = [];
  for (const ref of state.references) {
    if (ref.entityName === null) {
      blockers.push({
        kind: "MISSING_REFERENCE",
        entityId: ref.entityId,
        message: `A reference field points at entity "${ref.entityId}", which no longer exists.`,
      });
    } else if (ref.latestVersionId === null) {
      blockers.push({
        kind: "UNPUBLISHED_REFERENCE",
        entityId: ref.entityId,
        entityName: ref.entityName,
        message: `Publish ${ref.entityName} first`,
      });
    } else {
      pins.push({ entityId: ref.entityId, entityName: ref.entityName, versionId: ref.latestVersionId });
    }
  }

  const initialLabel = formatVersionLabel(INITIAL_VERSION);
  if (!latest) {
    return {
      isFirstPublish: true,
      latestLabel: null,
      suggestedBump: null,
      candidateLabels: null,
      initialLabel,
      reasons: [],
      diffSummary: { added: state.currentFields.length, removed: 0, modified: 0 },
      blockers,
      pins,
    };
  }

  const suggestion = suggestBump(latest.fieldSnapshot, state.currentFields);
  return {
    isFirstPublish: false,
    latestLabel: formatVersionLabel(latest),
    suggestedBump: suggestion.bump,
    candidateLabels: {
      MAJOR: formatVersionLabel(nextVersionNumber(latest, "MAJOR").version),
      MINOR: formatVersionLabel(nextVersionNumber(latest, "MINOR").version),
    },
    initialLabel,
    reasons: suggestion.reasons,
    diffSummary: suggestion.summary,
    blockers,
    pins,
  };
}

/** The version publishEntity will write, or why it cannot (all blockers at once, spec §10). */
export function planPublish(state: PublishState, requested?: BumpKind): Result<PublishPlan> {
  const analysis = analyzePublish(state);
  if (analysis.blockers.length > 0) {
    return err({
      code: "PUBLISH_BLOCKED",
      message: analysis.blockers.map((b) => b.message).join("; "),
      details: { blockers: analysis.blockers },
      suggestedFix: "Resolve every blocker, then publish again.",
    });
  }

  const { latest, entity } = state;
  if (!latest) {
    const { version, changeKind } = nextVersionNumber(null, "MINOR");
    return ok({
      version,
      label: formatVersionLabel(version),
      sequence: Math.max(entity.version, 1),
      changeKind,
      pins: analysis.pins,
    });
  }

  const bump = resolveBump(analysis.suggestedBump ?? "MINOR", requested);
  if (!bump.success) return bump;
  const { version, changeKind } = nextVersionNumber(latest, bump.data);
  return ok({ version, label: formatVersionLabel(version), sequence: latest.sequence + 1, changeKind, pins: analysis.pins });
}
```

- [ ] **Step 4: Run and expect PASS.** Run `npx vitest run tests/unit/lib/entity-versioning`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/entity-versioning/publish-plan.ts tests/unit/lib/entity-versioning/publish-plan.test.ts
git commit -m "feat(14.2,14.4): pure publish planner — blockers reported together, reference pins, raise-only bump"
```

---

### Task 5: Entity version service — publish + read APIs (Stories 14.2, 14.4; Events picker APIs)

**Files:**
- Create: `src/services/entity-version.service.ts`
- Test: `tests/integration/services/entity-version.service.test.ts`

**Interfaces:**
- Consumes: `loadEntityModel` (`src/lib/compiler/entity-model-loader.ts`), `generateTypeSpec`, `toFieldSnapshot`, `collectReferencedEntityIds`, `analyzePublish` / `planPublish`, `ServiceErrorRejection` (`src/services/scoped-create.service.ts`), `withAudit`.
- Produces (used by the Events phase Message pickers):
  ```ts
  previewPublish(entityId: string, ctx: ServiceContext): Promise<Result<PublishAnalysis>>
  publishEntity(entityId: string, opts: PublishInput, ctx: ServiceContext): Promise<Result<EntityVersionSummary>>
  listEntityVersions(entityId: string, ctx: ServiceContext): Promise<Result<EntityVersionSummary[]>>   // newest first
  getEntityVersion(entityId: string, label: string, ctx: ServiceContext): Promise<Result<EntityVersion>> // "2.1" | "v2.1"
  getLatestPublishedVersion(entityId: string, ctx: ServiceContext): Promise<Result<EntityVersion | null>> // null = never published
  ```
  Error codes: `NOT_FOUND`, `VALIDATION_ERROR`, `PUBLISH_BLOCKED` (details.blockers), `BUMP_TOO_LOW`, `CONFLICT`, `UNAUTHORIZED`, `DB_ERROR`.

- [ ] **Step 1: Failing integration test** (`tests/integration/services/entity-version.service.test.ts`)

```ts
import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  previewPublish,
  publishEntity,
  listEntityVersions,
  getEntityVersion,
  getLatestPublishedVersion,
} from "@/services/entity-version.service";
import { markEntityDraftChanged } from "@/lib/entity-versioning/draft-state";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

let prisma: PrismaClient;
let ctx: ServiceContext;
const TENANT = "tenant_default";

beforeAll(async () => {
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  const user = await prisma.user.findFirstOrThrow();
  ctx = { userId: user.id, userRole: "AUTHOR", prisma };
});
afterAll(async () => prisma.$disconnect());

function unwrap<T>(r: Result<T>): T {
  if (!r.success) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data;
}

/** A fresh domain + product; entities/fields created through the helpers live under it. */
async function scope() {
  const s = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const domain = await prisma.domain.create({ data: { name: `ev-${s}`, slug: `ev-${s}`, tenantId: TENANT } });
  const product = await prisma.product.create({ data: { domainId: domain.id, name: "P", slug: `p-${s}` } });
  const entity = (name: string) =>
    prisma.entity.create({
      data: {
        name, slug: `${name.toLowerCase()}-${s}`, tenantId: TENANT, domainId: domain.id, productId: product.id,
        ownerId: ctx.userId, typespecSource: `model ${name} { id: string; }`,
      },
    });
  const field = (
    entityId: string,
    name: string,
    opts: { nullable?: boolean; type?: string; sortOrder?: number; decorators?: Record<string, string> } = {}
  ) =>
    prisma.field.create({
      data: {
        entityId, name, slug: name, type: opts.type ?? "string", nullable: opts.nullable ?? true,
        sortOrder: opts.sortOrder ?? 0, decorators: opts.decorators ?? {},
      },
    });
  return { domainId: domain.id, entity, field };
}

async function cleanup(domainId: string | undefined) {
  if (!domainId) return;
  const versions = await prisma.entityVersion.findMany({ where: { entity: { domainId } }, select: { id: true } });
  await prisma.schemaReference.deleteMany({ where: { fromKind: "ENTITY_VERSION", fromId: { in: versions.map((v) => v.id) } } });
  await prisma.domain.deleteMany({ where: { id: domainId } });
}

describe("entity version service", () => {
  it("publishes 1.0, then the suggested MINOR, enforces MAJOR on breaking changes, and allows raising", async () => {
    let domainId: string | undefined;
    try {
      const sc = await scope();
      domainId = sc.domainId;
      const customer = await sc.entity("Customer");
      await sc.field(customer.id, "id", { nullable: false });

      const first = unwrap(await publishEntity(customer.id, {}, ctx));
      expect(first).toMatchObject({ label: "1.0", changeKind: "INITIAL", sequence: 1 });
      expect(await prisma.entity.findUniqueOrThrow({ where: { id: customer.id } })).toMatchObject({
        latestVersionId: first.id, hasUnpublishedChanges: false, version: 1,
      });

      const again = await publishEntity(customer.id, {}, ctx);
      expect(!again.success && again.error.code).toBe("PUBLISH_BLOCKED");

      await sc.field(customer.id, "email", { sortOrder: 1 });
      await markEntityDraftChanged(prisma, customer.id);
      expect(unwrap(await previewPublish(customer.id, ctx)).suggestedBump).toBe("MINOR");
      expect(unwrap(await publishEntity(customer.id, { changeSummary: "add email" }, ctx))).toMatchObject({
        label: "1.1", changeKind: "MINOR", sequence: 2, changeSummary: "add email",
      });

      await prisma.field.deleteMany({ where: { entityId: customer.id, name: "email" } });
      await markEntityDraftChanged(prisma, customer.id);
      const low = await publishEntity(customer.id, { bump: "MINOR" }, ctx);
      expect(!low.success && low.error.code).toBe("BUMP_TOO_LOW");
      expect(unwrap(await publishEntity(customer.id, {}, ctx))).toMatchObject({ label: "2.0", changeKind: "MAJOR", sequence: 3 });

      await prisma.entity.update({ where: { id: customer.id }, data: { description: "docs", hasUnpublishedChanges: true } });
      expect(unwrap(await publishEntity(customer.id, { bump: "MAJOR" }, ctx)).label).toBe("3.0");
      expect((await prisma.entity.findUniqueOrThrow({ where: { id: customer.id } })).version).toBe(4);
    } finally {
      await cleanup(domainId);
    }
  });

  it("blocks until referenced entities are published, then pins their latest version", async () => {
    let domainId: string | undefined;
    try {
      const sc = await scope();
      domainId = sc.domainId;
      const buyer = await sc.entity("Buyer");
      await sc.field(buyer.id, "id", { nullable: false });
      const order = await sc.entity("Order");
      await sc.field(order.id, "buyer", {
        type: "reference",
        decorators: { referencedEntityId: buyer.id, referencedEntityName: "Buyer" },
      });

      const blocked = await publishEntity(order.id, {}, ctx);
      expect(blocked.success).toBe(false);
      if (!blocked.success) expect(blocked.error).toMatchObject({ code: "PUBLISH_BLOCKED", message: "Publish Buyer first" });

      const buyerV = unwrap(await publishEntity(buyer.id, {}, ctx));
      const orderV = unwrap(await publishEntity(order.id, {}, ctx));
      const refs = await prisma.schemaReference.findMany({ where: { fromKind: "ENTITY_VERSION", fromId: orderV.id } });
      expect(refs).toEqual([
        expect.objectContaining({ role: "FIELD", toKind: "ENTITY_VERSION", toId: buyerV.id, isDraft: false }),
      ]);
    } finally {
      await cleanup(domainId);
    }
  });

  it("creates exactly one version under concurrent publishes", async () => {
    let domainId: string | undefined;
    try {
      const sc = await scope();
      domainId = sc.domainId;
      const race = await sc.entity("Race");
      await sc.field(race.id, "id", { nullable: false });

      const results = await Promise.all([publishEntity(race.id, {}, ctx), publishEntity(race.id, {}, ctx)]);
      expect(results.filter((r) => r.success)).toHaveLength(1);
      const failed = results.find((r) => !r.success);
      expect(failed?.success).toBe(false);
      if (failed && !failed.success) expect(["PUBLISH_BLOCKED", "CONFLICT"]).toContain(failed.error.code);
      expect(await prisma.entityVersion.count({ where: { entityId: race.id } })).toBe(1);
    } finally {
      await cleanup(domainId);
    }
  });

  it("reads versions newest first, by label, and the latest one", async () => {
    let domainId: string | undefined;
    try {
      const sc = await scope();
      domainId = sc.domainId;
      const reader = await sc.entity("Reader");
      await sc.field(reader.id, "id", { nullable: false });
      const v10 = unwrap(await publishEntity(reader.id, {}, ctx));
      await sc.field(reader.id, "note", { sortOrder: 1 });
      await markEntityDraftChanged(prisma, reader.id);
      const v11 = unwrap(await publishEntity(reader.id, {}, ctx));

      expect(unwrap(await listEntityVersions(reader.id, ctx)).map((v) => v.label)).toEqual(["1.1", "1.0"]);
      expect(unwrap(await getEntityVersion(reader.id, "1.0", ctx))).toMatchObject({ id: v10.id, changeKind: "INITIAL" });
      expect(unwrap(await getEntityVersion(reader.id, "v1.1", ctx)).id).toBe(v11.id);
      const frozen = unwrap(await getEntityVersion(reader.id, "1.1", ctx));
      expect((frozen.fieldSnapshot as Array<{ name: string }>).map((f) => f.name)).toEqual(["id", "note"]);
      expect(frozen.resolvedSource).toBe("model Reader { id: string; }");

      const missing = await getEntityVersion(reader.id, "9.9", ctx);
      expect(!missing.success && missing.error.code).toBe("NOT_FOUND");
      const bad = await getEntityVersion(reader.id, "nope", ctx);
      expect(!bad.success && bad.error.code).toBe("VALIDATION_ERROR");

      expect(unwrap(await getLatestPublishedVersion(reader.id, ctx))?.id).toBe(v11.id);
      const fresh = await sc.entity("Fresh");
      expect(unwrap(await getLatestPublishedVersion(fresh.id, ctx))).toBeNull();
      const unknown = await getLatestPublishedVersion("does-not-exist", ctx);
      expect(!unknown.success && unknown.error.code).toBe("NOT_FOUND");
    } finally {
      await cleanup(domainId);
    }
  });
});
```

- [ ] **Step 2: Run to verify failure.** Run `npx vitest run tests/integration/services/entity-version.service.test.ts`. Expected: FAIL, `Cannot find module '@/services/entity-version.service'`.

- [ ] **Step 3: Implement** (`src/services/entity-version.service.ts`)

```ts
/**
 * Entity versioning — Draft + Publish (spec §5, Phase 2a "slim").
 *
 * The Entity row + its fields are the draft. publishEntity freezes the draft
 * into an immutable EntityVersion (MAJOR.MINOR), pins every referenced
 * entity's latest published version in SchemaReference (role FIELD), and
 * moves the draft pointers — one transaction, entity row locked.
 *
 * Deferred to Phase 2b: Data Type closure in resolvedSource (14.2), per-format
 * compatibility rule tables + compatReport (14.3), MAJOR governance (14.4),
 * EntityVersionArtifact (14.5).
 */

import type { EntityVersion, PrismaClient, Prisma } from "@/generated/prisma/client";
import { withAudit, AuditUserMissingError } from "@/lib/audit";
import { ok, err, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import type { FieldSnapshot } from "@/services/version-history/version.types";
import { toFieldSnapshot } from "@/lib/diff/field-snapshot";
import { collectReferencedEntityIds } from "@/lib/entity-versioning/reference-targets";
import { analyzePublish, planPublish, type PublishAnalysis, type PublishState } from "@/lib/entity-versioning/publish-plan";
import { formatVersionLabel, parseVersionLabel } from "@/lib/entity-versioning/version-math";
import type { EntityVersionSummary, PublishInput } from "@/lib/entity-versioning/types";
import { loadEntityModel } from "@/lib/compiler/entity-model-loader";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { ServiceErrorRejection } from "@/services/scoped-create.service";

type Db = PrismaClient | Prisma.TransactionClient;

const SUMMARY_SELECT = {
  id: true,
  entityId: true,
  major: true,
  minor: true,
  sequence: true,
  changeKind: true,
  changeSummary: true,
  publishedById: true,
  publishedAt: true,
  publishedBy: { select: { name: true } },
} satisfies Prisma.EntityVersionSelect;

type SummaryRow = Prisma.EntityVersionGetPayload<{ select: typeof SUMMARY_SELECT }>;

function toSummary(v: SummaryRow): EntityVersionSummary {
  return {
    id: v.id,
    entityId: v.entityId,
    major: v.major,
    minor: v.minor,
    label: formatVersionLabel(v),
    sequence: v.sequence,
    changeKind: v.changeKind,
    changeSummary: v.changeSummary,
    publishedById: v.publishedById,
    publishedByName: v.publishedBy.name,
    publishedAt: v.publishedAt.toISOString(),
  };
}

function entityNotFound(entityId: string) {
  return err({
    code: "NOT_FOUND",
    message: `Entity with ID "${entityId}" not found`,
    suggestedFix: "Verify the entity ID and try again.",
  });
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2002";
}

async function loadPublishState(db: Db, entityId: string): Promise<Result<PublishState>> {
  const entity = await db.entity.findUnique({
    where: { id: entityId },
    include: {
      fields: { orderBy: { sortOrder: "asc" } },
      latestVersion: { select: { id: true, major: true, minor: true, sequence: true, fieldSnapshot: true } },
    },
  });
  if (!entity) return entityNotFound(entityId);

  const targetIds = collectReferencedEntityIds(entity.id, entity.fields, entity.metadata);
  const targets =
    targetIds.length > 0
      ? await db.entity.findMany({ where: { id: { in: targetIds } }, select: { id: true, name: true, latestVersionId: true } })
      : [];
  const byId = new Map(targets.map((t) => [t.id, t]));

  return ok({
    entity: {
      id: entity.id,
      name: entity.name,
      status: entity.status,
      version: entity.version,
      hasUnpublishedChanges: entity.hasUnpublishedChanges,
      typespecSource: entity.typespecSource,
    },
    latest: entity.latestVersion
      ? {
          id: entity.latestVersion.id,
          major: entity.latestVersion.major,
          minor: entity.latestVersion.minor,
          sequence: entity.latestVersion.sequence,
          fieldSnapshot: entity.latestVersion.fieldSnapshot as unknown as FieldSnapshot[],
        }
      : null,
    currentFields: entity.fields.map(toFieldSnapshot),
    references: targetIds.map((id) => {
      const t = byId.get(id);
      return { entityId: id, entityName: t?.name ?? null, latestVersionId: t?.latestVersionId ?? null };
    }),
  });
}

/** Phase 2a resolvedSource: the stored canonical source, else source generated from the field rows. */
async function draftSource(db: Db, entityId: string, stored: string | null): Promise<Result<string>> {
  if (stored) return ok(stored);
  const model = await loadEntityModel(db, entityId);
  if (!model.success) return model;
  return ok(generateTypeSpec(model.data));
}

/** What the publish dialog shows: suggested bump, next labels, reasons, blockers, pins. */
export async function previewPublish(entityId: string, ctx: ServiceContext): Promise<Result<PublishAnalysis>> {
  const state = await loadPublishState(ctx.prisma, entityId);
  if (!state.success) return state;
  return ok(analyzePublish(state.data));
}

export async function publishEntity(
  entityId: string,
  opts: PublishInput,
  ctx: ServiceContext
): Promise<Result<EntityVersionSummary>> {
  const db = ctx.prisma;
  const changeSummary = opts.changeSummary?.trim() ? opts.changeSummary.trim() : null;
  try {
    const created = await withAudit({
      action: "PUBLISH_VERSION",
      entityType: "Entity",
      entityId,
      userId: ctx.userId,
      fn: () =>
        db.$transaction(
          async (tx) => {
            // Row lock: serialises concurrent publishes of this entity, and makes a
            // concurrent draft edit's hasUnpublishedChanges=true land after our false.
            await tx.$queryRaw`SELECT "id" FROM "entities" WHERE "id" = ${entityId} FOR UPDATE`;

            const state = await loadPublishState(tx, entityId);
            if (!state.success) throw new ServiceErrorRejection(state.error);
            const plan = planPublish(state.data, opts.bump);
            if (!plan.success) throw new ServiceErrorRejection(plan.error);
            const source = await draftSource(tx, entityId, state.data.entity.typespecSource);
            if (!source.success) throw new ServiceErrorRejection(source.error);

            const version = await tx.entityVersion.create({
              data: {
                entityId,
                major: plan.data.version.major,
                minor: plan.data.version.minor,
                sequence: plan.data.sequence,
                resolvedSource: source.data,
                fieldSnapshot: state.data.currentFields as unknown as Prisma.InputJsonValue,
                changeKind: plan.data.changeKind,
                compatReport: {},
                changeSummary,
                publishedById: ctx.userId,
              },
              select: SUMMARY_SELECT,
            });

            if (plan.data.pins.length > 0) {
              await tx.schemaReference.createMany({
                data: plan.data.pins.map((pin) => ({
                  fromKind: "ENTITY_VERSION" as const,
                  fromId: version.id,
                  role: "FIELD" as const,
                  toKind: "ENTITY_VERSION" as const,
                  toId: pin.versionId,
                  isDraft: false,
                })),
                skipDuplicates: true,
              });
            }

            await tx.entity.update({
              where: { id: entityId },
              data: { latestVersionId: version.id, hasUnpublishedChanges: false, version: version.sequence },
              select: { id: true },
            });
            return version;
          },
          { timeout: 15_000 }
        ),
    });
    return ok(toSummary(created));
  } catch (e: unknown) {
    if (e instanceof ServiceErrorRejection) return err(e.serviceError);
    if (e instanceof AuditUserMissingError) return err({ code: "UNAUTHORIZED", message: e.message });
    if (isUniqueViolation(e)) {
      return err({
        code: "CONFLICT",
        message: "Another publish of this entity completed first.",
        suggestedFix: "Reload the entity and publish again.",
      });
    }
    return err({ code: "DB_ERROR", message: e instanceof Error ? e.message : "Publish failed" });
  }
}

/** Published versions, newest first (Message pickers + version list). */
export async function listEntityVersions(
  entityId: string,
  ctx: ServiceContext
): Promise<Result<EntityVersionSummary[]>> {
  const exists = await ctx.prisma.entity.findUnique({ where: { id: entityId }, select: { id: true } });
  if (!exists) return entityNotFound(entityId);
  const rows = await ctx.prisma.entityVersion.findMany({
    where: { entityId },
    orderBy: { sequence: "desc" },
    select: SUMMARY_SELECT,
  });
  return ok(rows.map(toSummary));
}

/** One frozen version by label ("2.1" or "v2.1"), incl. resolvedSource + fieldSnapshot. */
export async function getEntityVersion(
  entityId: string,
  label: string,
  ctx: ServiceContext
): Promise<Result<EntityVersion>> {
  const parsed = parseVersionLabel(label);
  if (!parsed.success) return parsed;
  const row = await ctx.prisma.entityVersion.findUnique({
    where: { entityId_major_minor: { entityId, major: parsed.data.major, minor: parsed.data.minor } },
  });
  if (!row) {
    return err({
      code: "NOT_FOUND",
      message: `Version ${formatVersionLabel(parsed.data)} of entity "${entityId}" not found`,
      suggestedFix: "List the entity's published versions and pick one of them.",
    });
  }
  return ok(row);
}

/** The latest published version, or null when the entity was never published. */
export async function getLatestPublishedVersion(
  entityId: string,
  ctx: ServiceContext
): Promise<Result<EntityVersion | null>> {
  const entity = await ctx.prisma.entity.findUnique({ where: { id: entityId }, select: { latestVersion: true } });
  if (!entity) return entityNotFound(entityId);
  return ok(entity.latestVersion);
}
```

- [ ] **Step 4: Run and expect PASS**

Run: `npx vitest run tests/integration/services/entity-version.service.test.ts`
If the concurrency test is flaky on PGlite, check that `.env` has `DB_PROVIDER=postgresql`. The integration-test convention requires PostgreSQL; PGlite runs a single connection and serialises anyway.

- [ ] **Step 5: Verify + commit.** Run `npx tsc --noEmit` (clean) and `npx vitest run` (8 baseline failures).

```bash
git add src/services/entity-version.service.ts tests/integration/services/entity-version.service.test.ts
git commit -m "feat(14.2,14.4): publishEntity — one-transaction publish with reference pins; version read APIs for Message pickers"
```

---

### Task 6: Story 2-22 reconciliation — Save never creates a version (Story 14.8, spec D1)

**Files:**
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/entity-workspace.tsx`
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions.ts` (delete `createVersionAction`)
- Modify: `src/services/version-history/version.service.ts` (delete `createSnapshot`, `toFieldSnapshot`, `toEntitySnapshot`)
- Modify: `src/services/version-history/version.types.ts` (header comment only)
- Delete: `src/lib/validation/change-level.ts`, `tests/unit/validation/change-level.test.ts`
- Modify: `tests/unit/services/version-history.service.test.ts`
- Modify: `_bmad-output/implementation-artifacts/2-22-explicit-save-semantic-versioning.md`

**What 2-22 did today** (verified): `entity-workspace.tsx` `handleUpdateField` called `updateFieldAction` → `createVersionAction` (→ `createSnapshot`, which appends to `metadata.versionHistory` and sets `Entity.version = N+1`) → `bumpSemanticVersion` (writes `metadata.semanticVersion` via `updateEntityMetadataAction`, using `classifyChangeLevel`). `handleMetaSaved` did the same with a minor bump. The Versions tab had a manual "Create Version" button. All of this is superseded: Save/Discard stays, saving updates the draft only, and versions come only from Publish (Tasks 5, 7, 8).

**Interfaces:**
- Removes: `createVersionAction`, `createSnapshot`, `classifyChangeLevel`. Keeps the legacy reads `getVersionHistory`, `getVersion`, `compareVersions`, `compareVersionsStructured`, and the actions `getVersionHistoryAction` / `compareVersionsAction`.

- [ ] **Step 1: Update the legacy service tests first.** In `tests/unit/services/version-history.service.test.ts`, remove `createSnapshot,` from the import list. Delete the `makeMockField` helper (only the `createSnapshot` block used it). Delete the whole `describe("createSnapshot", () => { … });` block; it is the block right before `describe("getVersionHistory"`. Then run `npx vitest run tests/unit/services/version-history.service.test.ts`. Expected: PASS (the read tests are unchanged).

- [ ] **Step 2: Retire `createSnapshot`.** In `src/services/version-history/version.service.ts`, delete `toFieldSnapshot`, `toEntitySnapshot` and `createSnapshot`. Replace the header comment and imports with:

```ts
/**
 * Legacy Version History Service (read-only).
 *
 * Reads the pre-Epic-14 snapshots stored in entity metadata JSONB under
 * `versionHistory`. Nothing writes them any more: Story 2-22's "every save
 * creates a version" is superseded by Draft + Publish (spec D1). Published
 * versions live in `entity_versions` (src/services/entity-version.service.ts).
 */

import { prisma } from "@/lib/db";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import type { VersionSnapshot, VersionDiff, DiffResult } from "./version.types";
import { computeFieldDiff, computeDiffResult } from "@/lib/diff/field-diff";
```

In `version.types.ts`, change the header line `MVP: snapshots stored in entity metadata JSONB under \`versionHistory\` key.` to `Legacy (read-only): pre-Epic-14 snapshots in entity metadata JSONB under \`versionHistory\`; FieldSnapshot is also the shape of EntityVersion.fieldSnapshot.`

- [ ] **Step 3: Delete `createVersionAction`** from `[entityId]/actions.ts`: the whole function plus its JSDoc ("Create a new version snapshot for an entity.").

- [ ] **Step 4: Rewire `entity-workspace.tsx`**

1. Imports: remove `createVersionAction,` from the `./actions` import. Delete `import { classifyChangeLevel } from "@/lib/validation/change-level";`. Change the lucide import to `import { Zap, Globe, Rocket, FileCode } from "lucide-react";`.
2. Delete `const [isCreatingVersion, setIsCreatingVersion] = useState(false);`.
3. Replace the `bumpSemanticVersion` helper **and** `handleUpdateField` (everything from `// Helper: bump semantic version in entity metadata` through the end of `handleUpdateField`) with:

```tsx
  // Field save — Story 2-22's explicit Save stays; saving updates the draft
  // only (spec D1). Versions are cut by Publish, never by Save.
  const handleUpdateField = useCallback(async (id: string, data: Record<string, unknown>) => {
    const result = await updateFieldAction(id, data);
    setTypeSpecTrigger((n) => n + 1);
    if (result?.error) {
      toast.error(result.error);
      return;
    }
    flashSaved();
  }, [flashSaved]);
```

4. Delete the whole `handleCreateVersion` callback.
5. Replace `handleMetaSaved` with:

```tsx
  // Metadata save (tags / owner) — updates the draft only (spec D1).
  const handleMetaSaved = useCallback(() => {
    flashSaved();
  }, [flashSaved]);
```

6. In the `activeTab === "versions"` block, replace the header `<div className="flex items-center justify-between"> … Create Version … </div>` with `<h2 className="text-heading-2 text-foreground">Legacy history (read-only)</h2>`. Replace the empty-state text `No versions created yet.` with `No legacy snapshots.`

- [ ] **Step 5: Delete the superseded classifier**

```bash
git rm src/lib/validation/change-level.ts tests/unit/validation/change-level.test.ts
```

- [ ] **Step 6: Prove no save path writes legacy versions any more**

```bash
grep -rn "createSnapshot\|createVersionAction\|classifyChangeLevel\|bumpSemanticVersion" src tests
```

Expected: no matches. `metadata.semanticVersion` is still read by `EntityHeader.tsx` until Task 8 replaces the badge. That read is harmless legacy.

- [ ] **Step 7: Story note.** Insert this block directly under the title of `_bmad-output/implementation-artifacts/2-22-explicit-save-semantic-versioning.md`:

```markdown
> **Superseded in part (2026-10-14, spec D1 / Epic 14 Phase 2a):** the explicit Save/Discard UX (AC 1, 2, 6–9) stays. AC 3–5 and 10 ("every save creates a version", save-time major/minor classification, `metadata.semanticVersion`, header `v{major}.{minor}`) are replaced by Draft + Publish: saving updates the draft only and sets `hasUnpublishedChanges`; versions are cut by Publish into `entity_versions` (`src/services/entity-version.service.ts`). `createSnapshot`, `createVersionAction` and `classifyChangeLevel` were removed; legacy `metadata.versionHistory` stays readable.
```

- [ ] **Step 8: Verify + commit.** Run `npx tsc --noEmit` (clean) and `npx vitest run` (8 baseline failures; total count lower by the deleted suites).

```bash
git add -A "src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/entity-workspace.tsx" "src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions.ts" src/services/version-history tests/unit/services/version-history.service.test.ts _bmad-output/implementation-artifacts/2-22-explicit-save-semantic-versioning.md
git commit -m "refactor(14.8): Save updates the draft only — retire createSnapshot, save-time semantic bump and change-level classifier (spec D1)"
```

---

### Task 7: Server actions for publish + versions (Story 14.4)

**Files:**
- Create: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/version-actions.ts`
- Test: `tests/unit/app/entity-version-actions.test.ts`

These actions live in a new file, which keeps merge conflicts with the concurrently edited `actions.ts` small.

**Interfaces:**
- Produces:
  ```ts
  getPublishPreviewAction(entityId: string): Promise<{ success: true; preview: PublishAnalysis } | { error: string }>
  publishEntityAction(entityId: string, input: PublishInput): Promise<{ success: true; version: EntityVersionSummary } | { error: string; code?: string }>
  listEntityVersionsAction(entityId: string): Promise<{ success: true; versions: EntityVersionSummary[] } | { error: string }>
  ```

- [ ] **Step 1: Failing test** (`tests/unit/app/entity-version-actions.test.ts`)

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  previewPublish: vi.fn(),
  publishEntity: vi.fn(),
  listEntityVersions: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { tag: "prisma" } }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/services/rbac.service", () => ({
  getEffectiveRole: vi.fn().mockResolvedValue({ success: true, data: "AUTHOR" }),
}));
vi.mock("@/services/entity-version.service", () => ({
  previewPublish: h.previewPublish,
  publishEntity: h.publishEntity,
  listEntityVersions: h.listEntityVersions,
}));

import {
  getPublishPreviewAction,
  publishEntityAction,
  listEntityVersionsAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/version-actions";

const SUMMARY = {
  id: "v1", entityId: "e1", major: 1, minor: 0, label: "1.0", sequence: 1, changeKind: "INITIAL",
  changeSummary: null, publishedById: "user-1", publishedByName: "Ada", publishedAt: "2026-10-14T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "user-1" } });
});

describe("entity version actions", () => {
  it("rejects unauthenticated calls without touching the service", async () => {
    h.auth.mockResolvedValue(null);
    expect(await publishEntityAction("e1", {})).toEqual({ error: "Not authenticated" });
    expect(await getPublishPreviewAction("e1")).toEqual({ error: "Not authenticated" });
    expect(await listEntityVersionsAction("e1")).toEqual({ error: "Not authenticated" });
    expect(h.publishEntity).not.toHaveBeenCalled();
  });

  it("rejects a bump other than MAJOR or MINOR", async () => {
    expect(await publishEntityAction("e1", { bump: "PATCH" as never })).toEqual({
      error: "bump must be MAJOR or MINOR",
      code: "VALIDATION_ERROR",
    });
    expect(h.publishEntity).not.toHaveBeenCalled();
  });

  it("publishes with the caller's context and revalidates", async () => {
    h.publishEntity.mockResolvedValue({ success: true, data: SUMMARY });
    expect(await publishEntityAction("e1", { bump: "MAJOR", changeSummary: "x" })).toEqual({ success: true, version: SUMMARY });
    expect(h.publishEntity).toHaveBeenCalledWith(
      "e1",
      { bump: "MAJOR", changeSummary: "x" },
      { userId: "user-1", userRole: "AUTHOR", prisma: { tag: "prisma" } }
    );
    expect(h.revalidatePath).toHaveBeenCalledWith("/schemas");
  });

  it("returns the service error with its code", async () => {
    h.publishEntity.mockResolvedValue({ success: false, error: { code: "PUBLISH_BLOCKED", message: "Publish Customer first" } });
    expect(await publishEntityAction("e1", {})).toEqual({ error: "Publish Customer first", code: "PUBLISH_BLOCKED" });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("passes preview and version list through", async () => {
    h.previewPublish.mockResolvedValue({ success: true, data: { isFirstPublish: true } });
    h.listEntityVersions.mockResolvedValue({ success: true, data: [SUMMARY] });
    expect(await getPublishPreviewAction("e1")).toEqual({ success: true, preview: { isFirstPublish: true } });
    expect(await listEntityVersionsAction("e1")).toEqual({ success: true, versions: [SUMMARY] });
  });
});
```

- [ ] **Step 2: Run to verify failure.** Run `npx vitest run tests/unit/app/entity-version-actions.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement** (`version-actions.ts`)

```ts
"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { getEffectiveRole } from "@/services/rbac.service";
import { listEntityVersions, previewPublish, publishEntity } from "@/services/entity-version.service";
import type { PublishAnalysis } from "@/lib/entity-versioning/publish-plan";
import { isBumpKind, type EntityVersionSummary, type PublishInput } from "@/lib/entity-versioning/types";
import type { ServiceContext } from "@/types/service-context";

const MAX_CHANGE_SUMMARY = 500;

/** Same role resolution as actions.ts (fail-closed to VIEWER). */
async function serviceContext(userId: string): Promise<ServiceContext> {
  const role = await getEffectiveRole(userId, null, { userId, userRole: "VIEWER", prisma });
  return { userId, userRole: role.success && role.data ? role.data : "VIEWER", prisma };
}

export async function getPublishPreviewAction(
  entityId: string
): Promise<{ success: true; preview: PublishAnalysis } | { error: string }> {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  const res = await previewPublish(entityId, await serviceContext(session.user.id));
  if (!res.success) return { error: res.error.message };
  return { success: true, preview: res.data };
}

export async function publishEntityAction(
  entityId: string,
  input: PublishInput
): Promise<{ success: true; version: EntityVersionSummary } | { error: string; code?: string }> {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  if (input.bump !== undefined && !isBumpKind(input.bump)) {
    return { error: "bump must be MAJOR or MINOR", code: "VALIDATION_ERROR" };
  }
  if (
    input.changeSummary !== undefined &&
    (typeof input.changeSummary !== "string" || input.changeSummary.length > MAX_CHANGE_SUMMARY)
  ) {
    return { error: `Change summary must be at most ${MAX_CHANGE_SUMMARY} characters`, code: "VALIDATION_ERROR" };
  }

  const res = await publishEntity(
    entityId,
    { bump: input.bump, changeSummary: input.changeSummary },
    await serviceContext(session.user.id)
  );
  if (!res.success) return { error: res.error.message, code: res.error.code };
  revalidatePath("/schemas");
  return { success: true, version: res.data };
}

export async function listEntityVersionsAction(
  entityId: string
): Promise<{ success: true; versions: EntityVersionSummary[] } | { error: string }> {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  const res = await listEntityVersions(entityId, await serviceContext(session.user.id));
  if (!res.success) return { error: res.error.message };
  return { success: true, versions: res.data };
}
```

- [ ] **Step 4: Run and expect PASS.** Then run `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/version-actions.ts" tests/unit/app/entity-version-actions.test.ts
git commit -m "feat(14.4): server actions for publish preview, publish and version list"
```

---

### Task 8: Minimal UI — header state, publish dialog, version list (Stories 14.4, 14.6)

**Files:**
- Create: `.../[entityId]/components/PublishEntityDialog.tsx`, `.../[entityId]/components/EntityVersionList.tsx`
- Modify: `.../[entityId]/components/EntityHeader.tsx`, `.../[entityId]/components/TypeSpecSourceTab.tsx`, `.../[entityId]/entity-workspace.tsx`, `.../[entityId]/load-entity-workspace.ts`
- Test: `tests/unit/components/entity-versioning-ui.test.tsx` (create), `tests/unit/app/load-entity-workspace.test.ts` (modify), `tests/unit/components/entity-workspace-level.test.tsx` (modify)

(`...` = `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]`.)

**Interfaces:**
- Produces: `PublishEntityForm` props `{ entityName; preview: PublishAnalysis; isPublishing; publishError: string | null; onCancel(); onConfirm(input: PublishInput) }`. `PublishEntityDialog` props `{ open; entityName; preview: PublishAnalysis | null; loadError: string | null; isPublishing; publishError: string | null; onOpenChange(open); onConfirm(input) }`. `EntityVersionList` props `{ versions: EntityVersionSummary[] }`. `EntityHeader` gains `versionState: DraftVersionState` and `onPublish?: () => void`. `EntityWorkspaceProps["entity"]` gains optional `hasUnpublishedChanges?: boolean; latestVersionLabel?: string | null`, filled by `loadEntityWorkspace`. That loader is shared by the product and Enterprise entity pages, so tenant-level entities get the same header and Publish flow.

- [ ] **Step 1: Failing UI tests** (`tests/unit/components/entity-versioning-ui.test.tsx`)

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PublishEntityForm } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/PublishEntityDialog";
import { EntityVersionList } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/EntityVersionList";
import type { PublishAnalysis } from "@/lib/entity-versioning/publish-plan";

afterEach(cleanup);

function analysis(overrides: Partial<PublishAnalysis> = {}): PublishAnalysis {
  return {
    isFirstPublish: false, latestLabel: "2.1", suggestedBump: "MINOR", candidateLabels: { MAJOR: "3.0", MINOR: "2.2" },
    initialLabel: "1.0", reasons: [], diffSummary: { added: 1, removed: 0, modified: 0 }, blockers: [], pins: [],
    ...overrides,
  };
}

const isDisabled = (el: HTMLElement) => el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";

function renderForm(preview: PublishAnalysis, onConfirm = vi.fn()) {
  render(
    <PublishEntityForm entityName="Order" preview={preview} isPublishing={false} publishError={null} onCancel={vi.fn()} onConfirm={onConfirm} />
  );
  return onConfirm;
}

describe("PublishEntityForm", () => {
  it("defaults to the suggested MINOR bump and lets the user raise it to MAJOR", () => {
    const onConfirm = renderForm(analysis());
    expect(screen.getByTestId("confirm-publish").textContent).toContain("Publish v2.2");
    fireEvent.click(screen.getByTestId("bump-major"));
    expect(screen.getByTestId("confirm-publish").textContent).toContain("Publish v3.0");
    fireEvent.click(screen.getByTestId("confirm-publish"));
    expect(onConfirm).toHaveBeenCalledWith({ bump: "MAJOR", changeSummary: undefined });
  });

  it("never offers MINOR when the change is breaking", () => {
    renderForm(analysis({ suggestedBump: "MAJOR", reasons: ['Removed field "email" — consumers depending on this field will break'] }));
    expect(isDisabled(screen.getByTestId("bump-minor"))).toBe(true);
    expect(screen.getByText(/Removed field "email"/)).toBeTruthy();
    expect(screen.getByTestId("confirm-publish").textContent).toContain("Publish v3.0");
  });

  it("first publish shows v1.0 and sends no bump", () => {
    const onConfirm = renderForm(
      analysis({ isFirstPublish: true, latestLabel: null, suggestedBump: null, candidateLabels: null })
    );
    expect(screen.queryByTestId("bump-major")).toBeNull();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: " initial import " } });
    fireEvent.click(screen.getByTestId("confirm-publish"));
    expect(onConfirm).toHaveBeenCalledWith({ bump: undefined, changeSummary: "initial import" });
  });

  it("lists blockers and disables Publish", () => {
    renderForm(
      analysis({
        blockers: [{ kind: "UNPUBLISHED_REFERENCE", entityId: "c1", entityName: "Customer", message: "Publish Customer first" }],
      })
    );
    expect(screen.getByRole("alert").textContent).toContain("Publish Customer first");
    expect(isDisabled(screen.getByTestId("confirm-publish"))).toBe(true);
  });
});

describe("EntityVersionList", () => {
  it("renders rows in the given (newest-first) order", () => {
    render(
      <EntityVersionList
        versions={[
          { id: "v2", entityId: "e", major: 1, minor: 1, label: "1.1", sequence: 2, changeKind: "MINOR", changeSummary: "add email", publishedById: "u", publishedByName: "Ada", publishedAt: "2026-10-14T10:00:00.000Z" },
          { id: "v1", entityId: "e", major: 1, minor: 0, label: "1.0", sequence: 1, changeKind: "INITIAL", changeSummary: null, publishedById: "u", publishedByName: null, publishedAt: "2026-10-13T10:00:00.000Z" },
        ]}
      />
    );
    const rows = screen.getByTestId("entity-version-list").querySelectorAll("li");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("v1.1");
    expect(rows[0].textContent).toContain("add email");
    expect(rows[1].textContent).toContain("v1.0");
  });

  it("shows an empty state", () => {
    render(<EntityVersionList versions={[]} />);
    expect(screen.getByTestId("entity-version-list-empty").textContent).toContain("Not published yet");
  });
});
```

- [ ] **Step 2: Run to verify failure.** Run `npx vitest run tests/unit/components/entity-versioning-ui.test.tsx`. Expected: FAIL, modules not found.

- [ ] **Step 3: `PublishEntityDialog.tsx`**

```tsx
"use client";

import { useState } from "react";
import { AlertTriangle, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { PublishAnalysis } from "@/lib/entity-versioning/publish-plan";
import type { BumpKind, PublishInput } from "@/lib/entity-versioning/types";

const BUMPS: BumpKind[] = ["MINOR", "MAJOR"];

interface PublishEntityFormProps {
  entityName: string;
  preview: PublishAnalysis;
  isPublishing: boolean;
  publishError: string | null;
  onCancel: () => void;
  onConfirm: (input: PublishInput) => void | Promise<void>;
}

/** Dialog body: suggested bump, raise-only control (spec Q6), summary, blockers. */
export function PublishEntityForm({
  entityName,
  preview,
  isPublishing,
  publishError,
  onCancel,
  onConfirm,
}: PublishEntityFormProps) {
  const [bump, setBump] = useState<BumpKind>(preview.suggestedBump ?? "MINOR");
  const [summary, setSummary] = useState("");
  const blocked = preview.blockers.length > 0;
  const targetLabel = preview.candidateLabels ? preview.candidateLabels[bump] : preview.initialLabel;

  return (
    <div className="space-y-space-4">
      {blocked && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-space-3">
          <p className="flex items-center gap-1.5 text-body-small font-medium text-destructive">
            <AlertTriangle className="size-4" aria-hidden="true" /> Cannot publish yet
          </p>
          <ul className="mt-space-1 list-disc pl-5 text-caption text-foreground">
            {preview.blockers.map((b, i) => (
              <li key={`${b.kind}-${i}`}>{b.message}</li>
            ))}
          </ul>
        </div>
      )}

      {preview.isFirstPublish ? (
        <p className="text-body-small text-foreground">
          First publish of <span className="font-mono">{entityName}</span>. It becomes{" "}
          <strong>v{preview.initialLabel}</strong>.
        </p>
      ) : (
        <div className="space-y-space-2">
          <p className="text-body-small text-foreground">
            Latest published: <strong>v{preview.latestLabel}</strong> · suggested bump:{" "}
            <strong>{preview.suggestedBump}</strong>
          </p>
          <div className="flex gap-space-2" role="radiogroup" aria-label="Version bump">
            {BUMPS.map((kind) => {
              const wouldLower = preview.suggestedBump === "MAJOR" && kind === "MINOR";
              return (
                <Button
                  key={kind}
                  type="button"
                  role="radio"
                  aria-checked={bump === kind}
                  variant={bump === kind ? "default" : "outline"}
                  size="sm"
                  disabled={wouldLower || isPublishing}
                  onClick={() => setBump(kind)}
                  data-testid={`bump-${kind.toLowerCase()}`}
                >
                  {kind === "MAJOR" ? "Major" : "Minor"} · v{preview.candidateLabels?.[kind]}
                </Button>
              );
            })}
          </div>
          {preview.suggestedBump === "MAJOR" && (
            <p className="text-caption text-muted-foreground">
              These changes are breaking, so they can only be published as a major version.
            </p>
          )}
          {preview.reasons.length > 0 && (
            <ul className="max-h-32 list-disc overflow-y-auto pl-5 text-caption text-muted-foreground">
              {preview.reasons.map((reason, i) => (
                <li key={`${i}-${reason}`}>{reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <label className="block">
        <span className="mb-1 block text-caption text-muted-foreground">Change summary (optional)</span>
        <Textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={2}
          maxLength={500}
          disabled={isPublishing}
        />
      </label>

      {publishError && (
        <p role="alert" className="text-body-small text-destructive">
          {publishError}
        </p>
      )}

      <div className="flex justify-end gap-space-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={isPublishing}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={blocked || isPublishing}
          onClick={() =>
            onConfirm({
              bump: preview.isFirstPublish ? undefined : bump,
              changeSummary: summary.trim() || undefined,
            })
          }
          data-testid="confirm-publish"
        >
          {isPublishing ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
          Publish v{targetLabel}
        </Button>
      </div>
    </div>
  );
}

interface PublishEntityDialogProps {
  open: boolean;
  entityName: string;
  preview: PublishAnalysis | null;
  loadError: string | null;
  isPublishing: boolean;
  publishError: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (input: PublishInput) => void | Promise<void>;
}

export function PublishEntityDialog({
  open,
  entityName,
  preview,
  loadError,
  isPublishing,
  publishError,
  onOpenChange,
  onConfirm,
}: PublishEntityDialogProps) {
  return (
    <Dialog
      open={open}
      modal
      disablePointerDismissal={isPublishing}
      onOpenChange={(next) => {
        if (!isPublishing) onOpenChange(next);
      }}
    >
      <DialogContent showCloseButton={!isPublishing} className="bg-background sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-heading-3 text-foreground">Publish {entityName}</DialogTitle>
          <DialogDescription className="text-body-small text-muted-foreground">
            Publishing freezes the current draft as an immutable version that messages and other entities can pin.
          </DialogDescription>
        </DialogHeader>
        {loadError ? (
          <p role="alert" className="text-body-small text-destructive">
            {loadError}
          </p>
        ) : preview === null ? (
          <p className="flex items-center gap-2 text-body-small text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Checking changes…
          </p>
        ) : (
          <PublishEntityForm
            key={preview.latestLabel ?? "initial"}
            entityName={entityName}
            preview={preview}
            isPublishing={isPublishing}
            publishError={publishError}
            onCancel={() => onOpenChange(false)}
            onConfirm={onConfirm}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: `EntityVersionList.tsx`**

```tsx
"use client";

import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/date-format";
import type { EntityVersionSummary } from "@/lib/entity-versioning/types";

interface EntityVersionListProps {
  /** Newest first (as returned by listEntityVersionsAction). */
  versions: EntityVersionSummary[];
}

export function EntityVersionList({ versions }: EntityVersionListProps) {
  if (versions.length === 0) {
    return (
      <p className="text-body-small text-muted-foreground" data-testid="entity-version-list-empty">
        Not published yet. Publish to cut version 1.0.
      </p>
    );
  }
  return (
    <ul className="space-y-space-2" data-testid="entity-version-list">
      {versions.map((v) => (
        <li
          key={v.id}
          className="flex items-center justify-between gap-space-3 rounded-lg border border-border/50 px-space-4 py-space-3"
        >
          <div className="flex min-w-0 items-center gap-space-3">
            <span className="font-mono text-body-small font-medium text-foreground">v{v.label}</span>
            <Badge variant="secondary">{v.changeKind}</Badge>
            {v.changeSummary && <span className="truncate text-caption text-muted-foreground">{v.changeSummary}</span>}
          </div>
          <span className="shrink-0 text-caption text-muted-foreground">
            {v.publishedByName ?? "Unknown"} · {formatDateTime(v.publishedAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 5: Run the UI tests and expect PASS.** Run `npx vitest run tests/unit/components/entity-versioning-ui.test.tsx`.

- [ ] **Step 6: `EntityHeader.tsx`.** Replace the `semanticVersion` badge with the draft state, and add the Publish button.

Imports: change `import { ChevronRight, Check } from "lucide-react";` to `import { ChevronRight, Check, Upload } from "lucide-react";`. Delete `import { Badge } from "@/components/ui/badge";`. Add `import { describeDraftState, type DraftVersionState } from "@/lib/entity-versioning/draft-label";`.

Add to `EntityHeaderProps` and to the destructured parameters:

```tsx
  /** Draft + Publish state (spec §5.3). */
  versionState: DraftVersionState;
  /** Opens the publish dialog; omit for read-only entities. */
  onPublish?: () => void;
```

Replace the whole `<Badge variant="secondary">v{(() => { … })()}</Badge>` element with:

```tsx
        <span
          data-testid="entity-version-state"
          className={`rounded-md border px-2 py-0.5 text-caption ${
            versionState.hasUnpublishedChanges && versionState.latestVersionLabel
              ? "border-warning/50 text-warning"
              : "border-border text-muted-foreground"
          }`}
        >
          {describeDraftState(versionState)}
        </span>
```

Replace the bare `{toolbar}` (right side of the header row) with:

```tsx
        <div className="flex items-center gap-space-2">
          {onPublish && (
            <Button size="sm" onClick={onPublish} className="gap-1.5" data-testid="publish-entity-button">
              <Upload className="w-3.5 h-3.5" />
              Publish
            </Button>
          )}
          {toolbar}
        </div>
```

- [ ] **Step 7: `TypeSpecSourceTab.tsx`.** Add `onSaved?: () => void;` to `TypeSpecSourceTabProps`, destructure it, and call `onSaved?.();` right after `setWasGenerated(false);` in `handleSave`.

- [ ] **Step 8: `load-entity-workspace.ts`.** This is the shared loader for the product and Enterprise entity pages. Add `latestVersion: { select: { major: true, minor: true } },` to `ENTITY_INCLUDE`. Add `import { toDraftVersionState } from "@/lib/entity-versioning/draft-label";`. In the returned `props.entity` object, after `metadata: …`, add:

```ts
        ...toDraftVersionState({ hasUnpublishedChanges: entity.hasUnpublishedChanges, latestVersion: entity.latestVersion }),
```

Then append to `describe("loadEntityWorkspace", …)` in `tests/unit/app/load-entity-workspace.test.ts`:

```ts
  it("maps the draft + publish state for the header", async () => {
    mockEntityFindFirst.mockResolvedValueOnce(entityRow({ hasUnpublishedChanges: true, latestVersion: { major: 2, minor: 1 } }));

    const data = await loadEntityWorkspace({ slugOrId: "order", productId: "prod-1", tenantId: "tenant-1" });

    expect(data?.props.entity).toMatchObject({ latestVersionLabel: "2.1", hasUnpublishedChanges: true });
  });

  it("reports a never-published entity", async () => {
    mockEntityFindFirst.mockResolvedValueOnce(entityRow({ hasUnpublishedChanges: true, latestVersion: null }));

    const data = await loadEntityWorkspace({ slugOrId: "order", productId: null, tenantId: "tenant-1" });

    expect(data?.props.entity).toMatchObject({ latestVersionLabel: null, hasUnpublishedChanges: true });
  });
```

- [ ] **Step 9: `entity-workspace.tsx`**

1. Imports: change the lucide import to `import { Zap, Globe, Rocket, FileCode, Upload } from "lucide-react";` and add:

```tsx
import { getPublishPreviewAction, publishEntityAction, listEntityVersionsAction } from "./version-actions";
import { PublishEntityDialog } from "./components/PublishEntityDialog";
import { EntityVersionList } from "./components/EntityVersionList";
import type { PublishAnalysis } from "@/lib/entity-versioning/publish-plan";
import type { EntityVersionSummary, PublishInput } from "@/lib/entity-versioning/types";
import type { DraftVersionState } from "@/lib/entity-versioning/draft-label";
```

2. In `EntityWorkspaceProps["entity"]`, after `metadata`, add:

```tsx
    /** Draft + Publish state (spec §5.3). Optional so loaders that predate Phase 2a still compile. */
    hasUnpublishedChanges?: boolean;
    latestVersionLabel?: string | null;
```

3. Directly after the `// View tab state` line (`const [activeTab, setActiveTab] = …`), insert:

```tsx
  // Draft + Publish state (spec §5.3). Server props are the source of truth;
  // saves flip the local copy until the next server render (React "adjust
  // state when props change" pattern — no effect).
  const serverVersionKey = `${entity.latestVersionLabel ?? ""}|${entity.hasUnpublishedChanges ?? true}`;
  const [versionStateKey, setVersionStateKey] = useState(serverVersionKey);
  const [versionState, setVersionState] = useState<DraftVersionState>({
    latestVersionLabel: entity.latestVersionLabel ?? null,
    hasUnpublishedChanges: entity.hasUnpublishedChanges ?? true,
  });
  if (versionStateKey !== serverVersionKey) {
    setVersionStateKey(serverVersionKey);
    setVersionState({
      latestVersionLabel: entity.latestVersionLabel ?? null,
      hasUnpublishedChanges: entity.hasUnpublishedChanges ?? true,
    });
  }
  const markDraftDirty = useCallback(() => {
    setVersionState((s) => (s.hasUnpublishedChanges ? s : { ...s, hasUnpublishedChanges: true }));
  }, []);

  // Publish dialog + published versions
  const [publishedVersions, setPublishedVersions] = useState<EntityVersionSummary[]>([]);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishPreview, setPublishPreview] = useState<PublishAnalysis | null>(null);
  const [publishLoadError, setPublishLoadError] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
```

4. Replace `handleUpdateField` (from Task 6) so it marks the draft:

```tsx
  const handleUpdateField = useCallback(async (id: string, data: Record<string, unknown>) => {
    const result = await updateFieldAction(id, data);
    setTypeSpecTrigger((n) => n + 1);
    if (result?.error) {
      toast.error(result.error);
      return;
    }
    markDraftDirty();
    flashSaved();
  }, [flashSaved, markDraftDirty]);
```

5. Replace `handleMetaSaved` (from Task 6):

```tsx
  const handleMetaSaved = useCallback(() => {
    markDraftDirty();
    flashSaved();
  }, [flashSaved, markDraftDirty]);
```

6. Replace `handleOpenHistory`:

```tsx
  const handleOpenHistory = useCallback(async () => {
    const [published, legacy] = await Promise.all([
      listEntityVersionsAction(entity.id),
      getVersionHistoryAction(entity.id),
    ]);
    if (!("error" in published)) {
      setPublishedVersions(published.versions);
    }
    if (legacy.versions) {
      setVersionHistory(legacy.versions as VersionSnapshot[]);
    }
  }, [entity.id]);
```

7. Add, after `handleOpenHistory`:

```tsx
  const handleOpenPublish = useCallback(async () => {
    if (fieldDirtyRef.current) {
      const confirmed = window.confirm("You have unsaved field edits. Publish the last saved draft without them?");
      if (!confirmed) return;
    }
    setPublishOpen(true);
    setPublishPreview(null);
    setPublishLoadError(null);
    setPublishError(null);
    const res = await getPublishPreviewAction(entity.id);
    if ("error" in res) setPublishLoadError(res.error);
    else setPublishPreview(res.preview);
  }, [entity.id]);

  const handleConfirmPublish = useCallback(async (input: PublishInput) => {
    setIsPublishing(true);
    setPublishError(null);
    try {
      const res = await publishEntityAction(entity.id, input);
      if ("error" in res) {
        setPublishError(res.error);
        return;
      }
      setVersionState({ latestVersionLabel: res.version.label, hasUnpublishedChanges: false });
      setPublishedVersions((prev) => [res.version, ...prev]);
      setPublishOpen(false);
      toast.success(`Published ${entity.name} v${res.version.label}`);
      router.refresh();
    } finally {
      setIsPublishing(false);
    }
  }, [entity.id, entity.name, router]);
```

8. `EntityHeader` usage: add the props `versionState={versionState}` and `onPublish={readOnly_ ? undefined : handleOpenPublish}`.

9. `FieldEditor` callbacks: replace `onAddField`, `onUpdateField` and `onDeleteField` with:

```tsx
                onAddField={async (name, type, opts) => {
                  const result = await addFieldAction(entity.id, name, type, opts);
                  setTypeSpecTrigger((n) => n + 1);
                  if (!result?.error) markDraftDirty();
                  return result;
                }}
                onUpdateField={async (id, data) => {
                  const result = await updateFieldAction(id, data);
                  setTypeSpecTrigger((n) => n + 1);
                  if (!result?.error) markDraftDirty();
                }}
                onDeleteField={async (id) => {
                  const result = await deleteFieldAction(id);
                  if (selectedFieldId === id) {
                    setSelectedFieldId(null);
                    setRightPanelTab("typespec-preview");
                  }
                  setTypeSpecTrigger((n) => n + 1);
                  if (!result?.error) markDraftDirty();
                }}
```

10. `TypeSpecSourceTab` usage: `<TypeSpecSourceTab entityId={entity.id} entityName={entity.name} readOnly={readOnly_} onSaved={markDraftDirty} />`.

11. Replace the whole `{activeTab === "versions" && ( … )}` block with:

```tsx
        {activeTab === "versions" && (
          <div className="space-y-space-6">
            <div className="flex items-center justify-between">
              <h2 className="text-heading-2 text-foreground">Published Versions</h2>
              {!readOnly_ && (
                <Button
                  variant="outline"
                  onClick={handleOpenPublish}
                  className="gap-1.5"
                  data-testid="versions-publish-button"
                >
                  <Upload className="w-4 h-4" />
                  Publish
                </Button>
              )}
            </div>
            <EntityVersionList versions={publishedVersions} />

            <div className="border-t border-border/50 pt-space-4 space-y-space-3">
              <h3 className="text-heading-3 text-foreground">Legacy history (read-only)</h3>
              {showDiff && diffResult && (
                <DiffViewer diff={diffResult} onClose={handleCloseDiff} />
              )}
              {versionHistory.length > 0 ? (
                <div className="space-y-space-2">
                  {versionHistory.map((v, idx) => (
                    <div
                      key={v.version}
                      className="flex items-center justify-between rounded-lg border border-border/50 px-space-4 py-space-3"
                    >
                      <div>
                        <span className="text-body-small font-medium text-foreground">
                          v{v.version}
                        </span>
                        <span className="text-caption text-muted-foreground ml-space-3">
                          {formatDateTime(v.timestamp)}
                        </span>
                      </div>
                      {idx < versionHistory.length - 1 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            handleViewDiff(v.version, versionHistory[idx + 1].version)
                          }
                          className="text-caption"
                        >
                          View Diff
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-body-small text-muted-foreground">No legacy snapshots.</p>
              )}
            </div>

            {/* Change log */}
            <div className="border-t border-border/50 pt-space-4">
              <h3 className="text-heading-3 text-foreground mb-space-3">Change Log</h3>
              <ChangeHistoryView
                entityId={entity.id}
                fetchHistory={fetchChangeHistory}
                onViewDiff={handleHistoryViewDiff}
              />
            </div>
          </div>
        )}
```

12. Just before `{/* Type Mapping Override Dialog */}`, render the dialog:

```tsx
      <PublishEntityDialog
        open={publishOpen}
        entityName={entity.name}
        preview={publishPreview}
        loadError={publishLoadError}
        isPublishing={isPublishing}
        publishError={publishError}
        onOpenChange={setPublishOpen}
        onConfirm={handleConfirmPublish}
      />
```

- [ ] **Step 10: Workspace header test.** In `tests/unit/components/entity-workspace-level.test.tsx`, add this mock next to the existing `.../[entityId]/actions` mock. Without it, the real server-action module pulls in `@/lib/db` under jsdom.

```tsx
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/version-actions", () => ({
  getPublishPreviewAction: vi.fn(),
  publishEntityAction: vi.fn(),
  listEntityVersionsAction: vi.fn(),
}));
```

and append:

```tsx
describe("EntityWorkspace draft + publish header", () => {
  const productEntity = props({}).entity;

  it("shows 'Never published' and a Publish button for an unpublished draft", () => {
    render(<EntityWorkspace {...props({})} />);
    expect(screen.getByTestId("entity-version-state").textContent).toBe("Never published");
    expect(screen.getByTestId("publish-entity-button")).toBeDefined();
  });

  it("shows the latest version with unpublished changes from the loader", () => {
    render(
      <EntityWorkspace {...props({ entity: { ...productEntity, latestVersionLabel: "2.1", hasUnpublishedChanges: true } })} />
    );
    expect(screen.getByTestId("entity-version-state").textContent).toBe("Draft · unpublished changes · latest v2.1");
  });

  it("offers Publish on an Enterprise entity too", () => {
    render(<EntityWorkspace {...TENANT_PROPS} />);
    expect(screen.getByTestId("publish-entity-button")).toBeDefined();
  });

  it("hides Publish for a retired entity", () => {
    render(
      <EntityWorkspace
        {...props({ entity: { ...productEntity, status: "RETIRED", latestVersionLabel: "1.0", hasUnpublishedChanges: false } })}
      />
    );
    expect(screen.getByTestId("entity-version-state").textContent).toBe("Published · v1.0");
    expect(screen.queryByTestId("publish-entity-button")).toBeNull();
  });
});
```

Run: `npx vitest run tests/unit/components/entity-workspace-level.test.tsx tests/unit/app/load-entity-workspace.test.ts tests/unit/components/entity-versioning-ui.test.tsx`. Expected: PASS.

- [ ] **Step 11: Verify.** Run `npx tsc --noEmit` (clean), `npx eslint "src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]" src/lib/entity-versioning src/services/entity-version.service.ts` (no new errors), and `npx vitest run` (8 baseline failures).

- [ ] **Step 12: Commit**

```bash
git add "src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]" tests/unit/components/entity-versioning-ui.test.tsx tests/unit/components/entity-workspace-level.test.tsx tests/unit/app/load-entity-workspace.test.ts
git commit -m "feat(14.4,14.6): entity header draft state, publish dialog with raise-only bump, published version list"
```

---

### Task 9: Exit verification + manual smoke

**Files:** none new.

- [ ] **Step 1: Full checks**

```bash
npx tsc --noEmit
npx eslint src/lib/entity-versioning src/lib/diff/field-snapshot.ts src/services/entity-version.service.ts src/services/field.service.ts src/services/entity.service.ts "src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]" "src/app/(dashboard)/governance/retention/actions.ts"
npx vitest run 2>&1 | tail -25
```

Expected: tsc clean. No new lint errors. Exactly the 8 baseline failures (db-emitter-parity ×4, e2e-critical-flows bigquery ×1, schemas-tab ×3), all from `@typespec/db`.

- [ ] **Step 2: Manual smoke** on a second port, since the main checkout may already be using 3000:

```bash
NEXTAUTH_URL=http://localhost:3001 npx next dev -p 3001
```

1. Open an entity that was ACTIVE before the migration. The header shows `Published · v1.0`. The Versions tab lists `v1.0 · INITIAL`. The legacy list still shows its old `vN` snapshots.
2. Edit a field description and click Save. The header flips to `Draft · unpublished changes · latest v1.0`. No new legacy snapshot appears.
3. Click Publish. The dialog suggests MINOR with buttons `Minor · v1.1` / `Major · v2.0`. Confirm. The header shows `Published · v1.1`.
4. Delete a field and click Publish. The dialog suggests MAJOR, the Minor button is disabled, and the reasons list `Removed field …`. Confirm to get `v2.0`.
5. Add a reference field pointing at a never-published entity, then click Publish. The dialog shows `Publish <B> first` and Publish is disabled.
6. A brand-new entity shows `Never published`. Publishing it yields `v1.0`.

- [ ] **Step 3: Confirm the branch and hand off**

```bash
git log --oneline feat/events-asyncapi..HEAD
git status --short
```

Expected: 8 commits (Tasks 1–8) and a clean tree. Report to the coordinator: the migration folder names (and whether they still sort last on the base branch), the summary line from `db:migrate-typespec-source`, and the reminder that Story 18.1 must reuse `SchemaReference` instead of re-creating it.

---

## Phase 2a exit criteria

- `npx tsc --noEmit` clean; `npx vitest run` shows only the 8 baseline failures; the new DB tests pass on PostgreSQL and PGlite.
- Every IN-scope item is delivered: `EntityVersion` (immutable, both uniques), `SchemaReference` (all enum values; `FIELD` pins written), draft pointers, `publishEntity` (1.0 INITIAL, suggested MINOR/MAJOR, raise-only, reference pins, "Publish B first", one transaction), `hasUnpublishedChanges` on every draft path, the read APIs `listEntityVersions` / `getEntityVersion` / `getLatestPublishedVersion`, header + dialog + version list, the ACTIVE→1.0 backfill, and the Story 2-22 reconciliation.
- The Events phase can call `getLatestPublishedVersion(entityId)`, `listEntityVersions(entityId)` and `getEntityVersion(entityId, "2.1")`, and can write `SchemaReference` rows with `fromKind` `MESSAGE` / `MESSAGE_VERSION`. Story 18.1 reuses the `schema_references` table and its enums from this phase.
- The Deferred table is carried into the Phase 2b plan, including the delete restriction, which must land before Events pins go live.
