# Events & Platform Completeness — Program Plan + Phase 1 (Levels, Naming, Navigation)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 1 delivers the Tenant/Domain/Product placement model (level columns, line-unique names), the Data Types rename, the Enterprise workspace, level-aware navigation with one canonical URL builder, and the one-time TypeSpec-source migration that later versioning depends on.

**Architecture:** Every level-bearing table gets `tenantId` + nullable `domainId` / `productId`; a pure `levels.ts` module derives and validates levels; a `name-registry` service enforces cross-kind name uniqueness along a tenant→domain→product line under a per-tenant advisory lock; `assetHref()` is the single URL builder; the domains-tree API returns the full Enterprise → Domain → Product tree that the redesigned sidebar renders, hiding empty categories.

**Tech Stack:** Next.js (App Router, server actions), Prisma 7 + PostgreSQL / PGlite, Vitest, Playwright, Tailwind design tokens.

**Spec:** `docs/superpowers/specs/2026-10-13-events-asyncapi-design.md`

## Global Constraints

- All services return `Result<T, ServiceError>` from `@/types/result`; never throw across a service boundary.
- All mutations wrapped with `withAudit` (`@/lib/audit`) where the surrounding code already does so.
- Migrations: hand-written, idempotent SQL in `prisma/migrations/<YYYYMMDD>_<name>/migration.sql` (existing convention, e.g. `20261001_add_tenant_product_hierarchy`); applied to PostgreSQL via `npm run db:deploy` and to PGlite automatically by `src/lib/pglite-migrate.ts`. After editing `prisma/schema.prisma`, run `npm run db:generate`.
- Placement matrix (spec §4.1): Data Types → Tenant/Domain/Product; Entities → Tenant/Product; APIs → Domain/Product; Traits → Tenant/Domain/Product; Messages/Channels/Event Specs → Product only.
- Level derivation: `productId` set → PRODUCT; else `domainId` set → DOMAIN; else TENANT. Invariant: `productId IS NULL OR domainId IS NOT NULL`.
- No overriding. Names unique across all kinds along one tenant ∪ domain ∪ product line; sibling domains/products may reuse names. Comparison is case-insensitive.
- UI label is **"Data Types"**; tab id is `data-types`; legacy `?tab=types` keeps working.
- Reserved slugs: schema route `enterprise`, `type-mappings`; entity route `new`, `events`, `channels`, `messages`, `specs`, `traits`, `data-types`, `apis`.
- Empty nav categories are hidden at every level; New menus offer only kinds allowed at that level.
- Every navigation path and link must work (spec §4.7).
- Tests: Vitest unit tests in `tests/unit/**`, DB-backed integration tests in `tests/integration/**` (real `DATABASE_URL`, pattern of `tests/integration/services/entity-lifecycle.test.ts`), Playwright in `tests/e2e/**`.
- Baseline before Phase 1 (2026-10-13): `npx tsc --noEmit` clean; `npx vitest run` → 9 pre-existing failures (db-emitter-parity ×4, e2e-critical-flows bigquery, schemas-tab ×3 — all from broken `@typespec/db`, Story 16.4; left-sidebar-domain-assets — rewritten in Task 9). Do not count these as regressions; do not let the count grow.

## Review Focus

1. **Case-only name collisions** (`Order` vs `order` in the same line) — expected: rejected as a conflict. Test in Task 5.
2. **Tenant-level entity with no domain/product opened from every entry point** (sidebar, command palette, cross-reference link) — expected: resolves to `/schemas/enterprise/entities/<slug>`, never a 404. Tests in Tasks 7 and 14.
3. **Legacy deep links** (`?tab=types`, 2-segment `/schemas/<domain>/<entitySlug>`) — expected: still land on the right page. Tests in Tasks 7, 11 and 14.
4. **Domain or entity whose slug equals a reserved segment** (`enterprise`, `events`, …) — expected: creation rejected with a clear message. Test in Task 7.
5. **Concurrent creates of the same name in one tenant** — expected: exactly one succeeds. Test in Task 5.

---

## Program phases (master plan)

Each phase gets its own detailed plan file when reached (`docs/superpowers/plans/2026-10-13-events-asyncapi-phase-N.md`).

| Phase | Stories | Notes |
|---|---|---|
| **1 (this file)** | 21.5, 13.1, 13.2, 13.3, 13.5, 13.6, 13.7, 13.8, 13.9 | Foundations |
| 2 | 13.4, 14.1–14.8, 21.6 | Versioning; 13.4 moved here because it shares the Data Type closure with 14.2 |
| 3 | 16.2, 16.3, 16.5, 16.6, 16.10, 16.4, 16.7, 16.8, 16.9; 16.1 investigation | Formats / emitters |
| 4 | 18.1–18.4, 18.6–18.9; 18.5 when registry available | Events core |
| 5 | 19.1–19.7, 20.1–20.5 | AsyncAPI import + visual builder (registry-dependent parts gated) |
| 6 | 15.2–15.9, 17.1, 17.4–17.6; 15.1 when registry available | Import + APIs completeness |
| 7 | 21.1–21.4 | Cleanup |
| 8 | 22.x | Follow-ups |

---

## File structure (Phase 1)

| File | Responsibility |
|---|---|
| `src/lib/compiler/entity-model-loader.ts` (create) | Load an entity + fields and build `SuperSchemaModel` (de-duplicates the inline loader in `getTypeSpecSourceAction`) |
| `src/services/typespec-source-migration.service.ts` (create) | Story 12.7 batch migration: generate, round-trip compile, write or flag; idempotent |
| `scripts/migrate-typespec-source.ts` (create) | CLI wrapper for the migration |
| `src/lib/levels.ts` (create) | Pure level derivation + placement validation |
| `prisma/schema.prisma` (modify) | Level columns, nullable FKs |
| `prisma/migrations/20261013_add_asset_levels/migration.sql` (create) | Columns, backfill, CHECK constraints, index changes |
| `src/services/name-registry.service.ts` (create) | Line-uniqueness check, advisory lock helper, conflict report |
| `scripts/report-name-conflicts.ts` (create) | CLI conflict report |
| `src/lib/navigation/asset-href.ts` (create) | Canonical URL builder |
| `src/lib/slug.ts` (modify) | Reserved slug sets |
| `src/app/api/domains-tree/route.ts` (modify) | Full tree: enterprise + domains + products with per-level counts |
| `src/hooks/useDomainsTree.ts` (modify) | New tree types |
| `src/components/layout/LeftSidebar.tsx` (modify) | Enterprise section, domain + product nodes, hidden empty categories |
| `src/components/layout/sidebar/SidebarNodes.tsx` (create) | Extracted presentational nodes (category, leaf, entity row, badges) |
| `src/app/(dashboard)/schemas/[domainSlug]/domain-tabs.tsx` (create) | Domain page tabs: Products / Data Types / APIs |
| `src/app/(dashboard)/schemas/[domainSlug]/page.tsx` (modify) | Loads domain-level data types + APIs |
| `src/app/(dashboard)/schemas/[domainSlug]/domain-workspace.tsx` (modify) | Product workspace: tab ids, labels, level-aware New menu, inherited sections |
| `src/app/(dashboard)/schemas/[domainSlug]/components/DomainTypesTab.tsx` (modify) | `scope` prop (level to create at) + read-only inherited sections |
| `src/app/(dashboard)/schemas/[domainSlug]/actions.ts` (modify) | Level-aware creates; name-registry checks |
| `src/services/entity.service.ts` (modify) | Level-aware create; name-registry check |
| `src/app/(dashboard)/schemas/enterprise/page.tsx` (create) | Enterprise workspace (Data Types, Entities) |
| `src/app/(dashboard)/schemas/enterprise/enterprise-workspace.tsx` (create) | Client component for the above |
| `src/app/(dashboard)/schemas/enterprise/new/page.tsx` (create) | New tenant-level entity |
| `src/app/(dashboard)/schemas/enterprise/entities/[entityId]/page.tsx` (create) | Tenant entity workspace |
| `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/load-entity-workspace.ts` (create) | Shared server loader used by product + tenant entity pages |
| `tests/e2e/navigation.spec.ts` (create) | Click-through + link crawl |

---

### Task 1: TypeSpec-source batch migration (Story 21.5 / 12.7)

**Files:**
- Create: `src/lib/compiler/entity-model-loader.ts`
- Create: `src/services/typespec-source-migration.service.ts`
- Create: `scripts/migrate-typespec-source.ts`
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions.ts` (`getTypeSpecSourceAction`, ~lines 1615–1667) to use the loader
- Test: `tests/unit/services/typespec-source-migration.test.ts`

**Interfaces:**
- Produces: `loadEntityModel(db: Db, entityId: string): Promise<Result<SuperSchemaModel>>`; `migrateEntityTypeSpecSource(db: Db, entityId: string, deps?: MigrationDeps): Promise<Result<EntityMigrationOutcome>>`; `runTypeSpecSourceMigration(db: Db, deps?: MigrationDeps): Promise<Result<MigrationSummary>>`.
- Types:
  ```ts
  type EntityMigrationOutcome = { entityId: string; status: "SKIPPED" | "MIGRATED" | "FLAGGED"; diagnostics?: GovernanceDiagnostic[] };
  type MigrationSummary = { migrated: number; skipped: number; flagged: number; outcomes: EntityMigrationOutcome[] };
  type MigrationDeps = {
    generate: (model: SuperSchemaModel) => string;                       // default generateTypeSpec
    compile: (source: string) => Promise<CompileWithGovernanceResult>;   // default compileTypeSpecWithGovernance
  };
  ```

- [ ] **Step 1: Write the failing tests** (`tests/unit/services/typespec-source-migration.test.ts`)

```ts
import { describe, it, expect, vi } from "vitest";
import { migrateEntityTypeSpecSource, runTypeSpecSourceMigration } from "@/services/typespec-source-migration.service";

function fakeDb(entities: Array<{ id: string; typespecSource: string | null; metadata?: unknown }>) {
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  return {
    updates,
    entity: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const e = entities.find((x) => x.id === where.id);
        return e
          ? { ...e, name: "Order", description: "", status: "ACTIVE", version: 1, domainId: "d1", metadata: e.metadata ?? null, domain: { id: "d1", name: "Payments" } }
          : null;
      }),
      findMany: vi.fn(async () => entities.map((e) => ({ id: e.id }))),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push({ id: where.id, data });
        return {};
      }),
    },
    field: { findMany: vi.fn(async () => []) },
  };
}

describe("migrateEntityTypeSpecSource", () => {
  it("skips entities that already have typespecSource (idempotent)", async () => {
    const db = fakeDb([{ id: "e1", typespecSource: "model Order {}" }]);
    const res = await migrateEntityTypeSpecSource(db as never, "e1", {
      generate: () => "model X {}",
      compile: vi.fn(),
    });
    expect(res.success && res.data.status).toBe("SKIPPED");
    expect(db.updates).toHaveLength(0);
  });

  it("writes source when it round-trips clean", async () => {
    const db = fakeDb([{ id: "e1", typespecSource: null }]);
    const res = await migrateEntityTypeSpecSource(db as never, "e1", {
      generate: () => "model Order {}",
      compile: async () => ({ success: true, diagnostics: [] }) as never,
    });
    expect(res.success && res.data.status).toBe("MIGRATED");
    expect(db.updates[0].data.typespecSource).toBe("model Order {}");
  });

  it("flags entities whose generated source fails to compile, leaving typespecSource null", async () => {
    const db = fakeDb([{ id: "e1", typespecSource: null, metadata: { tags: ["x"] } }]);
    const diag = { severity: "error", code: "unknown-identifier", message: "bad", target: "Order" };
    const res = await migrateEntityTypeSpecSource(db as never, "e1", {
      generate: () => "model Order { x: Nope }",
      compile: async () => ({ success: false, diagnostics: [diag] }) as never,
    });
    expect(res.success && res.data.status).toBe("FLAGGED");
    const data = db.updates[0].data as { typespecSource?: unknown; metadata: Record<string, unknown> };
    expect(data.typespecSource).toBeUndefined();
    expect(data.metadata.tags).toEqual(["x"]);
    expect((data.metadata.typespecMigration as { status: string }).status).toBe("FLAGGED");
  });
});

describe("runTypeSpecSourceMigration", () => {
  it("summarises outcomes across all entities", async () => {
    const db = fakeDb([
      { id: "e1", typespecSource: "model A {}" },
      { id: "e2", typespecSource: null },
    ]);
    const res = await runTypeSpecSourceMigration(db as never, {
      generate: () => "model B {}",
      compile: async () => ({ success: true, diagnostics: [] }) as never,
    });
    expect(res.success && res.data).toMatchObject({ migrated: 1, skipped: 1, flagged: 0 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/services/typespec-source-migration.test.ts`
Expected: FAIL — `Cannot find module '@/services/typespec-source-migration.service'`.

- [ ] **Step 3: Implement the loader** (`src/lib/compiler/entity-model-loader.ts`)

```ts
import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { compileEntity } from "@/lib/compiler/compiler.service";
import type { SuperSchemaModel } from "@/types/super-schema-model";
import { ok, err, type Result } from "@/types/result";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Load an entity and its field rows and build the emitter-facing
 * SuperSchemaModel. Shared by the TypeSpec Source tab's lazy generation and
 * the one-time batch migration so both produce identical source.
 */
export async function loadEntityModel(db: Db, entityId: string): Promise<Result<SuperSchemaModel>> {
  const entity = await db.entity.findUnique({ where: { id: entityId }, include: { domain: true } });
  if (!entity) {
    return err({ code: "NOT_FOUND", message: `Entity "${entityId}" not found` });
  }
  const fields = await db.field.findMany({ where: { entityId }, orderBy: { sortOrder: "asc" } });

  return ok(
    compileEntity(
      {
        id: entity.id,
        name: entity.name,
        description: entity.description,
        status: entity.status,
        version: entity.version,
        domainId: entity.domainId,
        metadata: entity.metadata,
        domain: entity.domain
          ? { id: entity.domain.id, name: entity.domain.name, slug: entity.domain.name.toLowerCase().replace(/\s+/g, "-") }
          : null,
      },
      fields.map((f) => ({
        id: f.id,
        name: f.name,
        type: f.type,
        precision: f.precision,
        scale: f.scale,
        nullable: f.nullable,
        isKey: f.isKey,
        fieldNumber: f.fieldNumber,
        description: f.description,
        classification: f.classification,
        aliases: f.aliases,
        decorators: f.decorators,
        sortOrder: f.sortOrder,
      }))
    )
  );
}
```

(Keep the exact field mapping `getTypeSpecSourceAction` uses today; if `compileEntity`'s input type rejects `domainId: string | null` after Task 4, widen `PrismaEntityInput.domainId` to `string | null` in `compiler.service.ts`.)

- [ ] **Step 4: Implement the service** (`src/services/typespec-source-migration.service.ts`)

```ts
import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { compileTypeSpecWithGovernance, type GovernanceDiagnostic } from "@/lib/compiler/typespec-compiler";
import { loadEntityModel } from "@/lib/compiler/entity-model-loader";
import type { SuperSchemaModel } from "@/types/super-schema-model";
import { ok, err, type Result } from "@/types/result";

type Db = PrismaClient | Prisma.TransactionClient;

export type EntityMigrationOutcome = {
  entityId: string;
  status: "SKIPPED" | "MIGRATED" | "FLAGGED";
  diagnostics?: GovernanceDiagnostic[];
};
export type MigrationSummary = { migrated: number; skipped: number; flagged: number; outcomes: EntityMigrationOutcome[] };
export type MigrationDeps = {
  generate: (model: SuperSchemaModel) => string;
  compile: typeof compileTypeSpecWithGovernance;
};

const defaultDeps: MigrationDeps = { generate: generateTypeSpec, compile: compileTypeSpecWithGovernance };

/**
 * Story 12.7: give one entity its canonical typespecSource. Idempotent — an
 * entity that already has source is skipped. Generated source must compile
 * clean under the real compiler before it is written; otherwise the entity is
 * flagged in metadata.typespecMigration and left on the old path.
 */
export async function migrateEntityTypeSpecSource(
  db: Db,
  entityId: string,
  deps: MigrationDeps = defaultDeps
): Promise<Result<EntityMigrationOutcome>> {
  const entity = await db.entity.findUnique({ where: { id: entityId } });
  if (!entity) return err({ code: "NOT_FOUND", message: `Entity "${entityId}" not found` });
  if (entity.typespecSource) return ok({ entityId, status: "SKIPPED" });

  const model = await loadEntityModel(db, entityId);
  if (!model.success) return model;

  const source = deps.generate(model.data);
  const compiled = await deps.compile(source);
  const metadata = (entity.metadata as Record<string, unknown> | null) ?? {};

  if (!compiled.success) {
    await db.entity.update({
      where: { id: entityId },
      data: {
        metadata: {
          ...metadata,
          typespecMigration: { status: "FLAGGED", at: new Date().toISOString(), diagnostics: compiled.diagnostics },
        } as Prisma.InputJsonValue,
      },
    });
    return ok({ entityId, status: "FLAGGED", diagnostics: compiled.diagnostics });
  }

  const { typespecMigration: _drop, ...rest } = metadata;
  await db.entity.update({
    where: { id: entityId },
    data: { typespecSource: source, metadata: rest as Prisma.InputJsonValue },
  });
  return ok({ entityId, status: "MIGRATED" });
}

export async function runTypeSpecSourceMigration(
  db: Db,
  deps: MigrationDeps = defaultDeps
): Promise<Result<MigrationSummary>> {
  const ids = await db.entity.findMany({ select: { id: true }, orderBy: { createdAt: "asc" } });
  const summary: MigrationSummary = { migrated: 0, skipped: 0, flagged: 0, outcomes: [] };
  for (const { id } of ids) {
    const res = await migrateEntityTypeSpecSource(db, id, deps);
    if (!res.success) return res;
    summary.outcomes.push(res.data);
    if (res.data.status === "MIGRATED") summary.migrated++;
    else if (res.data.status === "SKIPPED") summary.skipped++;
    else summary.flagged++;
  }
  return ok(summary);
}
```

(If `GovernanceDiagnostic` is not exported from `typespec-compiler.ts`, export it there.)

- [ ] **Step 5: Run tests — expect PASS**

Run: `npx vitest run tests/unit/services/typespec-source-migration.test.ts`

- [ ] **Step 6: Script** (`scripts/migrate-typespec-source.ts`) — mirrors `scripts/db.ts` style

```ts
import "dotenv/config";
import { prisma } from "@/lib/db";
import { runTypeSpecSourceMigration } from "@/services/typespec-source-migration.service";

async function main() {
  const res = await runTypeSpecSourceMigration(prisma);
  if (!res.success) {
    console.error(res.error.message);
    process.exit(1);
  }
  const { migrated, skipped, flagged, outcomes } = res.data;
  console.log(`TypeSpec source migration: ${migrated} migrated, ${skipped} skipped, ${flagged} flagged`);
  for (const o of outcomes.filter((x) => x.status === "FLAGGED")) {
    console.log(`  FLAGGED ${o.entityId}: ${o.diagnostics?.map((d) => `${d.code}: ${d.message}`).join("; ")}`);
  }
  await prisma.$disconnect();
}

void main();
```

Add to `package.json` scripts: `"db:migrate-typespec-source": "tsx scripts/migrate-typespec-source.ts"`.

- [ ] **Step 7: Refactor `getTypeSpecSourceAction`** to call `loadEntityModel(prisma, entityId)` + `generateTypeSpec(model.data)` instead of its inline loader (behavior unchanged). Run `npx vitest run tests/unit` and `npx tsc --noEmit`; expect baseline only.

- [ ] **Step 8: Run against the dev DB** — `npm run db:migrate-typespec-source`; record the summary line in the commit message body.

- [ ] **Step 9: Commit**

```bash
git add src/lib/compiler/entity-model-loader.ts src/services/typespec-source-migration.service.ts scripts/migrate-typespec-source.ts package.json "src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions.ts" tests/unit/services/typespec-source-migration.test.ts
git commit -m "feat(12.7): one-time TypeSpec source batch migration with round-trip check"
```

---

### Task 2: Rename "Types" → "Data Types" (Story 13.1)

**Files:**
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/domain-workspace.tsx` (tab def ~line 126, `DomainTab` type line 50, initial tab parsing ~line 234, create dropdown ~lines 56–90)
- Test: `tests/unit/components/domain-workspace-tabs.test.tsx` (create)

**Interfaces:**
- Produces: `DomainTab = "entities" | "data-types" | "apis"`; exported helper `normalizeWorkspaceTab(raw: string | null): DomainTab` (maps legacy `"types"` → `"data-types"`, unknown → `"entities"`).

(The sidebar label is rewritten in Task 9.)

- [ ] **Step 1: Failing test**

```tsx
import { describe, it, expect } from "vitest";
import { normalizeWorkspaceTab } from "@/app/(dashboard)/schemas/[domainSlug]/domain-workspace";

describe("normalizeWorkspaceTab", () => {
  it("maps legacy ?tab=types to data-types", () => {
    expect(normalizeWorkspaceTab("types")).toBe("data-types");
  });
  it("keeps known tabs", () => {
    expect(normalizeWorkspaceTab("apis")).toBe("apis");
    expect(normalizeWorkspaceTab("data-types")).toBe("data-types");
  });
  it("falls back to entities", () => {
    expect(normalizeWorkspaceTab(null)).toBe("entities");
    expect(normalizeWorkspaceTab("bogus")).toBe("entities");
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`normalizeWorkspaceTab` not exported).

- [ ] **Step 3: Implement**

```ts
type DomainTab = "entities" | "data-types" | "apis";

export function normalizeWorkspaceTab(raw: string | null): DomainTab {
  if (raw === "types") return "data-types";
  if (raw === "data-types" || raw === "apis" || raw === "entities") return raw;
  return "entities";
}
```

- Tab definitions: `{ icon: Hash, label: "Data Types", id: "data-types" }`.
- `useState<DomainTab>(normalizeWorkspaceTab(searchParams.get("tab")))`.
- Replace every `activeTab === "types"` / `setActiveTab("types")` with `"data-types"`.
- Create dropdown: replace the three "New Enum / New Scalar / New Union" items with a "New Data Type" group header (non-clickable label row `text-[10px] uppercase text-muted-foreground px-3 pt-2`) followed by indented items "Enum", "Scalar", "Union" using the same actions.

- [ ] **Step 4: Run** `npx vitest run tests/unit/components/domain-workspace-tabs.test.tsx` → PASS; `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit** — `git commit -m "feat(13.1): rename Types to Data Types; legacy ?tab=types alias"`

---

### Task 3: Level helpers (Story 13.2, pure module)

**Files:**
- Create: `src/lib/levels.ts`
- Test: `tests/unit/lib/levels.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type AssetLevel = "TENANT" | "DOMAIN" | "PRODUCT";
  export type LevelKind = "dataType" | "entity" | "api" | "trait" | "message" | "channel" | "eventSpec";
  export interface LevelScope { tenantId: string; domainId: string | null; productId: string | null }
  export const ALLOWED_LEVELS: Record<LevelKind, readonly AssetLevel[]>;
  export function levelOf(scope: { domainId: string | null; productId: string | null }): AssetLevel;
  export function validateScope(kind: LevelKind, scope: LevelScope): Result<LevelScope>;
  export function kindLabel(kind: LevelKind): string;
  ```

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { levelOf, validateScope, ALLOWED_LEVELS } from "@/lib/levels";

describe("levelOf", () => {
  it("derives levels", () => {
    expect(levelOf({ domainId: null, productId: null })).toBe("TENANT");
    expect(levelOf({ domainId: "d", productId: null })).toBe("DOMAIN");
    expect(levelOf({ domainId: "d", productId: "p" })).toBe("PRODUCT");
  });
});

describe("validateScope", () => {
  const t = "t1";
  it("rejects productId without domainId", () => {
    const r = validateScope("dataType", { tenantId: t, domainId: null, productId: "p" });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.code).toBe("INVALID_SCOPE");
  });
  it("enforces the placement matrix", () => {
    expect(validateScope("entity", { tenantId: t, domainId: "d", productId: null }).success).toBe(false);
    expect(validateScope("entity", { tenantId: t, domainId: null, productId: null }).success).toBe(true);
    expect(validateScope("api", { tenantId: t, domainId: null, productId: null }).success).toBe(false);
    expect(validateScope("api", { tenantId: t, domainId: "d", productId: null }).success).toBe(true);
    expect(validateScope("message", { tenantId: t, domainId: "d", productId: null }).success).toBe(false);
    expect(validateScope("trait", { tenantId: t, domainId: null, productId: null }).success).toBe(true);
  });
  it("matrix matches spec §4.1", () => {
    expect(ALLOWED_LEVELS).toEqual({
      dataType: ["TENANT", "DOMAIN", "PRODUCT"],
      entity: ["TENANT", "PRODUCT"],
      api: ["DOMAIN", "PRODUCT"],
      trait: ["TENANT", "DOMAIN", "PRODUCT"],
      message: ["PRODUCT"],
      channel: ["PRODUCT"],
      eventSpec: ["PRODUCT"],
    });
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing).

- [ ] **Step 3: Implement** (`src/lib/levels.ts`)

```ts
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
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit** — `git commit -m "feat(13.2): level derivation and placement-matrix validation"`

---

### Task 4: Level columns — Prisma schema + migration (Story 13.2)

**Files:**
- Modify: `prisma/schema.prisma` (`Tenant`, `Domain`, `Product`, `Entity`, `SharedEnum`, `CustomScalar`, `UnionType`, `ServiceDefinition`)
- Create: `prisma/migrations/20261013_add_asset_levels/migration.sql`
- Modify: every TypeScript site `npx tsc --noEmit` flags after `npm run db:generate` (expected: places that read `entity.domain.*` / `entity.product.*` / `entity.domainId` as non-null)
- Test: `tests/integration/db/asset-levels.test.ts`

**Interfaces:**
- Produces (Prisma): `tenantId String` on the 5 tables; `Entity.domainId String?`, `Entity.productId String?`; `SharedEnum/CustomScalar/UnionType.domainId String?` + `productId String?`; `ServiceDefinition.productId String?` (domainId stays required). Relations: `tenant Tenant`, `product Product?` added where missing.

- [ ] **Step 1: Schema edits** (`prisma/schema.prisma`)

```prisma
model Tenant {
  // ...existing fields...
  entities       Entity[]
  sharedEnums    SharedEnum[]
  customScalars  CustomScalar[]
  unionTypes     UnionType[]
  services       ServiceDefinition[]
}

model Product {
  // ...existing fields...
  sharedEnums    SharedEnum[]
  customScalars  CustomScalar[]
  unionTypes     UnionType[]
  services       ServiceDefinition[]
}

model Entity {
  id             String           @id @default(cuid())
  name           String
  slug           String
  tenantId       String
  domainId       String?
  productId      String?
  // ...rest unchanged...
  tenant        Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  domain        Domain?  @relation(fields: [domainId], references: [id], onDelete: Cascade)
  product       Product? @relation(fields: [productId], references: [id], onDelete: Cascade)
  // ...
  @@unique([slug, productId])
  @@unique([name, productId])
  @@index([tenantId])
  @@map("entities")
}

model SharedEnum {
  id          String   @id @default(cuid())
  name        String
  values      String[]
  description String   @default("")
  tenantId    String
  domainId    String?
  productId   String?
  tenant      Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  domain      Domain?  @relation(fields: [domainId], references: [id], onDelete: Cascade)
  product     Product? @relation(fields: [productId], references: [id], onDelete: Cascade)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([tenantId])
  @@index([domainId])
  @@index([productId])
  @@map("shared_enums")
}
// CustomScalar and UnionType: identical level block (tenantId / domainId? / productId? + 3 relations + 3 indexes); remove @@unique([name, domainId]).

model ServiceDefinition {
  // ...existing...
  tenantId    String
  productId   String?
  tenant      Tenant      @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  product     Product?    @relation(fields: [productId], references: [id], onDelete: Cascade)
  // remove @@unique([name, domainId]); add:
  @@index([tenantId])
  @@index([productId])
}
```

Uniqueness for Data Types and APIs moves to the name registry (Task 5); no code uses their compound unique keys (verified: no `name_domainId` references in `src/`).

- [ ] **Step 2: Migration SQL** (`prisma/migrations/20261013_add_asset_levels/migration.sql`)

```sql
-- Asset levels (spec §4.2): Tenant / Domain / Product placement for Data Types,
-- Entities and APIs. Level is derived: productId → PRODUCT, else domainId →
-- DOMAIN, else TENANT. Idempotent so a partial apply can be re-run.

-- ── tenantId columns + backfill from the parent domain ──────────────────────
ALTER TABLE "entities"            ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "shared_enums"        ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "custom_scalars"      ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "union_types"         ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "service_definitions" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

UPDATE "entities" t            SET "tenantId" = d."tenantId" FROM "domains" d WHERE t."domainId" = d."id" AND t."tenantId" IS NULL;
UPDATE "shared_enums" t        SET "tenantId" = d."tenantId" FROM "domains" d WHERE t."domainId" = d."id" AND t."tenantId" IS NULL;
UPDATE "custom_scalars" t      SET "tenantId" = d."tenantId" FROM "domains" d WHERE t."domainId" = d."id" AND t."tenantId" IS NULL;
UPDATE "union_types" t         SET "tenantId" = d."tenantId" FROM "domains" d WHERE t."domainId" = d."id" AND t."tenantId" IS NULL;
UPDATE "service_definitions" t SET "tenantId" = d."tenantId" FROM "domains" d WHERE t."domainId" = d."id" AND t."tenantId" IS NULL;

ALTER TABLE "entities"            ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "shared_enums"        ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "custom_scalars"      ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "union_types"         ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "service_definitions" ALTER COLUMN "tenantId" SET NOT NULL;

-- ── productId on data types + APIs ───────────────────────────────────────────
ALTER TABLE "shared_enums"        ADD COLUMN IF NOT EXISTS "productId" TEXT;
ALTER TABLE "custom_scalars"      ADD COLUMN IF NOT EXISTS "productId" TEXT;
ALTER TABLE "union_types"         ADD COLUMN IF NOT EXISTS "productId" TEXT;
ALTER TABLE "service_definitions" ADD COLUMN IF NOT EXISTS "productId" TEXT;

-- ── nullable domain/product for tenant-level rows ────────────────────────────
ALTER TABLE "entities"       ALTER COLUMN "domainId"  DROP NOT NULL;
ALTER TABLE "entities"       ALTER COLUMN "productId" DROP NOT NULL;
ALTER TABLE "shared_enums"   ALTER COLUMN "domainId"  DROP NOT NULL;
ALTER TABLE "custom_scalars" ALTER COLUMN "domainId"  DROP NOT NULL;
ALTER TABLE "union_types"    ALTER COLUMN "domainId"  DROP NOT NULL;

-- ── foreign keys ─────────────────────────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "entities" ADD CONSTRAINT "entities_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "shared_enums" ADD CONSTRAINT "shared_enums_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "shared_enums" ADD CONSTRAINT "shared_enums_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "custom_scalars" ADD CONSTRAINT "custom_scalars_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "custom_scalars" ADD CONSTRAINT "custom_scalars_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "union_types" ADD CONSTRAINT "union_types_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "union_types" ADD CONSTRAINT "union_types_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "service_definitions" ADD CONSTRAINT "service_definitions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "service_definitions" ADD CONSTRAINT "service_definitions_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── placement CHECK constraints (spec §4.1) ──────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "entities" ADD CONSTRAINT "entities_level_check"
    CHECK (("productId" IS NULL AND "domainId" IS NULL) OR ("productId" IS NOT NULL AND "domainId" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "shared_enums" ADD CONSTRAINT "shared_enums_level_check" CHECK ("productId" IS NULL OR "domainId" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "custom_scalars" ADD CONSTRAINT "custom_scalars_level_check" CHECK ("productId" IS NULL OR "domainId" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "union_types" ADD CONSTRAINT "union_types_level_check" CHECK ("productId" IS NULL OR "domainId" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- service_definitions: domainId already NOT NULL → domain or product only.

-- ── uniqueness moves to the name registry (line uniqueness, spec §4.3) ───────
DROP INDEX IF EXISTS "shared_enums_name_domainId_key";
DROP INDEX IF EXISTS "custom_scalars_name_domainId_key";
DROP INDEX IF EXISTS "union_types_name_domainId_key";
DROP INDEX IF EXISTS "service_definitions_name_domainId_key";

CREATE INDEX IF NOT EXISTS "entities_tenantId_idx"             ON "entities"("tenantId");
CREATE INDEX IF NOT EXISTS "shared_enums_tenantId_idx"         ON "shared_enums"("tenantId");
CREATE INDEX IF NOT EXISTS "shared_enums_domainId_idx"         ON "shared_enums"("domainId");
CREATE INDEX IF NOT EXISTS "shared_enums_productId_idx"        ON "shared_enums"("productId");
CREATE INDEX IF NOT EXISTS "custom_scalars_tenantId_idx"       ON "custom_scalars"("tenantId");
CREATE INDEX IF NOT EXISTS "custom_scalars_domainId_idx"       ON "custom_scalars"("domainId");
CREATE INDEX IF NOT EXISTS "custom_scalars_productId_idx"      ON "custom_scalars"("productId");
CREATE INDEX IF NOT EXISTS "union_types_tenantId_idx"          ON "union_types"("tenantId");
CREATE INDEX IF NOT EXISTS "union_types_domainId_idx"          ON "union_types"("domainId");
CREATE INDEX IF NOT EXISTS "union_types_productId_idx"         ON "union_types"("productId");
CREATE INDEX IF NOT EXISTS "service_definitions_tenantId_idx"  ON "service_definitions"("tenantId");
CREATE INDEX IF NOT EXISTS "service_definitions_productId_idx" ON "service_definitions"("productId");
```

Before writing the DROP INDEX lines, confirm the real index names: `grep -rn "name_domainId_key" prisma/migrations`.

- [ ] **Step 3: Apply + generate**

Run: `npm run db:deploy && npm run db:generate`
Expected: migration `20261013_add_asset_levels` applied; client regenerated.

- [ ] **Step 4: Integration test** (`tests/integration/db/asset-levels.test.ts`) — pattern of `tests/integration/db/schema.test.ts`

```ts
import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

let prisma: PrismaClient;
const TENANT = "tenant_default";

beforeAll(async () => {
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
});
afterAll(async () => prisma.$disconnect());

describe("asset levels", () => {
  it("allows a tenant-level entity (no domain, no product)", async () => {
    const user = await prisma.user.findFirstOrThrow();
    const e = await prisma.entity.create({
      data: { name: `TenantEnt${Date.now()}`, slug: `tenant-ent-${Date.now()}`, tenantId: TENANT, ownerId: user.id },
    });
    expect(e.domainId).toBeNull();
    await prisma.entity.delete({ where: { id: e.id } });
  });

  it("rejects an entity at domain level (CHECK)", async () => {
    const user = await prisma.user.findFirstOrThrow();
    const d = await prisma.domain.create({ data: { name: `lvl-${Date.now()}`, slug: `lvl-${Date.now()}`, tenantId: TENANT } });
    await expect(
      prisma.entity.create({ data: { name: "X", slug: "x", tenantId: TENANT, domainId: d.id, ownerId: user.id } })
    ).rejects.toThrow(/entities_level_check/);
    await prisma.domain.delete({ where: { id: d.id } });
  });

  it("rejects a data type with productId but no domainId (CHECK)", async () => {
    const d = await prisma.domain.create({ data: { name: `lvl2-${Date.now()}`, slug: `lvl2-${Date.now()}`, tenantId: TENANT } });
    const p = await prisma.product.create({ data: { domainId: d.id, name: "P", slug: `p-${Date.now()}` } });
    await expect(
      prisma.sharedEnum.create({ data: { name: "E", values: ["A"], tenantId: TENANT, productId: p.id } })
    ).rejects.toThrow(/shared_enums_level_check/);
    await prisma.domain.delete({ where: { id: d.id } });
  });

  it("backfilled tenantId on existing rows", async () => {
    const missing = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM "entities" WHERE "tenantId" IS NULL`;
    expect(Number(missing[0].n)).toBe(0);
  });
});
```

Run: `npx vitest run tests/integration/db/asset-levels.test.ts` → PASS.

- [ ] **Step 5: Fix the type ripple.** Run `npx tsc --noEmit`. For each error:
  - Creates (`prisma.entity.create`, `sharedEnum.create`, `customScalar.create`, `unionType.create`, `serviceDefinition.create` in `actions.ts` lines ~88, 158, 300, 350, 400, 450, 482, 906, 926, 948, 978, 1035; `src/services/entity.service.ts:63`; `prisma/seed.ts`) now require `tenantId` → pass the domain's tenantId: load `const domain = await db.domain.findUniqueOrThrow({ where: { id: domainId }, select: { tenantId: true } })` once per action and spread `tenantId: domain.tenantId`. (Task 6 replaces these with the level-aware create path; here only make it compile and keep behavior.)
  - Reads of `entity.domain.x` / `entity.product.x` → use optional chaining with an explicit tenant-level branch (e.g. breadcrumb shows "Enterprise" when `entity.domain` is null). Do not use non-null assertions.
- [ ] **Step 6: Verify** — `npx tsc --noEmit` clean; `npx vitest run` → only the 9 baseline failures.
- [ ] **Step 7: Commit** — `git commit -m "feat(13.2): tenant/domain/product level columns, CHECK constraints, backfill"`

---

### Task 5: Name registry + conflict report (Story 13.3)

**Files:**
- Create: `src/services/name-registry.service.ts`
- Create: `scripts/report-name-conflicts.ts`
- Test: `tests/unit/services/name-registry.test.ts`, `tests/integration/services/name-registry.test.ts`

**Interfaces:**
- Consumes: `LevelScope`, `levelOf` (Task 3).
- Produces:
  ```ts
  export type RegistryKind = "entity" | "sharedEnum" | "customScalar" | "unionType" | "service";
  export interface NamedAsset { kind: RegistryKind; id: string; name: string; tenantId: string; domainId: string | null; productId: string | null }
  export function inSameLine(a: Pick<NamedAsset,"tenantId"|"domainId"|"productId">, b: Pick<NamedAsset,"tenantId"|"domainId"|"productId">): boolean;
  export function findLineConflict(candidate: Omit<NamedAsset,"id"|"kind"> & { exclude?: { kind: RegistryKind; id: string } }, existing: NamedAsset[]): NamedAsset | null;
  export async function assertNameAvailable(db: Db, candidate: Omit<NamedAsset,"id"|"kind"> & { exclude?: { kind: RegistryKind; id: string } }): Promise<Result<void>>;
  export async function withTenantNameLock<T>(db: PrismaClient, tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  export async function findNameConflicts(db: Db, tenantId: string): Promise<Array<{ name: string; assets: NamedAsset[] }>>;
  ```
- Registry is extended in Phase 4 with `trait | message | channel | eventSpec` (add to `RegistryKind` and the `loadLineCandidates` query list).

- [ ] **Step 1: Failing unit tests** (pure functions)

```ts
import { describe, it, expect } from "vitest";
import { inSameLine, findLineConflict, type NamedAsset } from "@/services/name-registry.service";

const T = "t1";
const asset = (over: Partial<NamedAsset>): NamedAsset => ({
  kind: "entity", id: "x", name: "Order", tenantId: T, domainId: null, productId: null, ...over,
});

describe("inSameLine", () => {
  it("tenant is in line with everything in the tenant", () => {
    expect(inSameLine(asset({}), asset({ domainId: "d1", productId: "p1" }))).toBe(true);
  });
  it("domain is in line with its products but not sibling domains", () => {
    expect(inSameLine(asset({ domainId: "d1" }), asset({ domainId: "d1", productId: "p1" }))).toBe(true);
    expect(inSameLine(asset({ domainId: "d1" }), asset({ domainId: "d2" }))).toBe(false);
  });
  it("sibling products are not in line", () => {
    expect(inSameLine(asset({ domainId: "d1", productId: "p1" }), asset({ domainId: "d1", productId: "p2" }))).toBe(false);
  });
  it("different tenants never conflict", () => {
    expect(inSameLine(asset({}), asset({ tenantId: "t2" }))).toBe(false);
  });
});

describe("findLineConflict", () => {
  it("detects cross-kind, case-insensitive conflicts", () => {
    const existing = [asset({ kind: "sharedEnum", id: "e1", name: "order", domainId: "d1" })];
    const hit = findLineConflict({ name: "Order", tenantId: T, domainId: "d1", productId: "p1" }, existing);
    expect(hit?.id).toBe("e1");
  });
  it("ignores the excluded asset (rename of itself)", () => {
    const existing = [asset({ id: "e1", name: "Order", domainId: "d1", productId: "p1" })];
    const hit = findLineConflict(
      { name: "Order", tenantId: T, domainId: "d1", productId: "p1", exclude: { kind: "entity", id: "e1" } },
      existing
    );
    expect(hit).toBeNull();
  });
  it("allows the same name in a sibling product", () => {
    const existing = [asset({ id: "e1", domainId: "d1", productId: "p1" })];
    expect(findLineConflict({ name: "Order", tenantId: T, domainId: "d1", productId: "p2" }, existing)).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** (`src/services/name-registry.service.ts`)

```ts
import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { ok, err, type Result } from "@/types/result";
import { levelOf, levelLabel } from "@/lib/levels";

type Db = PrismaClient | Prisma.TransactionClient;

export type RegistryKind = "entity" | "sharedEnum" | "customScalar" | "unionType" | "service";

export interface NamedAsset {
  kind: RegistryKind;
  id: string;
  name: string;
  tenantId: string;
  domainId: string | null;
  productId: string | null;
}

type Placement = Pick<NamedAsset, "tenantId" | "domainId" | "productId">;
type Candidate = Omit<NamedAsset, "id" | "kind"> & { exclude?: { kind: RegistryKind; id: string } };

const KIND_LABEL: Record<RegistryKind, string> = {
  entity: "Entity",
  sharedEnum: "Enum",
  customScalar: "Scalar",
  unionType: "Union",
  service: "API",
};

/** True when one placement is an ancestor-or-self of the other (spec §4.3). */
export function inSameLine(a: Placement, b: Placement): boolean {
  if (a.tenantId !== b.tenantId) return false;
  if (!a.domainId || !b.domainId) return true; // tenant level is in every line
  if (a.domainId !== b.domainId) return false;
  if (!a.productId || !b.productId) return true; // domain level is in every product line of that domain
  return a.productId === b.productId;
}

export function findLineConflict(candidate: Candidate, existing: NamedAsset[]): NamedAsset | null {
  const name = candidate.name.trim().toLowerCase();
  for (const a of existing) {
    if (candidate.exclude && a.kind === candidate.exclude.kind && a.id === candidate.exclude.id) continue;
    if (a.name.trim().toLowerCase() !== name) continue;
    if (inSameLine(candidate, a)) return a;
  }
  return null;
}

/** Load every named asset whose placement could share a line with the candidate. */
async function loadLineCandidates(db: Db, c: Candidate): Promise<NamedAsset[]> {
  const nameFilter = { equals: c.name.trim(), mode: "insensitive" as const };
  const where = { tenantId: c.tenantId, name: nameFilter };
  const select = { id: true, name: true, tenantId: true, domainId: true, productId: true };
  const [entities, enums, scalars, unions, services] = await Promise.all([
    db.entity.findMany({ where, select }),
    db.sharedEnum.findMany({ where, select }),
    db.customScalar.findMany({ where, select }),
    db.unionType.findMany({ where, select }),
    db.serviceDefinition.findMany({ where, select }),
  ]);
  return [
    ...entities.map((r) => ({ ...r, kind: "entity" as const })),
    ...enums.map((r) => ({ ...r, kind: "sharedEnum" as const })),
    ...scalars.map((r) => ({ ...r, kind: "customScalar" as const })),
    ...unions.map((r) => ({ ...r, kind: "unionType" as const })),
    ...services.map((r) => ({ ...r, kind: "service" as const })),
  ];
}

export async function assertNameAvailable(db: Db, candidate: Candidate): Promise<Result<void>> {
  const hit = findLineConflict(candidate, await loadLineCandidates(db, candidate));
  if (!hit) return ok(undefined);
  return err({
    code: "NAME_CONFLICT",
    message: `"${candidate.name}" is already used by ${KIND_LABEL[hit.kind]} "${hit.name}" at ${levelLabel(levelOf(hit))} level.`,
    details: { conflict: hit },
    suggestedFix: "Names must be unique across Enterprise, Domain and Product levels. Choose a different name.",
  });
}

/** Serialize name checks + writes within one tenant (spec §4.3). */
export async function withTenantNameLock<T>(
  db: PrismaClient,
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`;
    return fn(tx);
  });
}

export async function findNameConflicts(db: Db, tenantId: string): Promise<Array<{ name: string; assets: NamedAsset[] }>> {
  const select = { id: true, name: true, tenantId: true, domainId: true, productId: true };
  const where = { tenantId };
  const [entities, enums, scalars, unions, services] = await Promise.all([
    db.entity.findMany({ where, select }),
    db.sharedEnum.findMany({ where, select }),
    db.customScalar.findMany({ where, select }),
    db.unionType.findMany({ where, select }),
    db.serviceDefinition.findMany({ where, select }),
  ]);
  const all: NamedAsset[] = [
    ...entities.map((r) => ({ ...r, kind: "entity" as const })),
    ...enums.map((r) => ({ ...r, kind: "sharedEnum" as const })),
    ...scalars.map((r) => ({ ...r, kind: "customScalar" as const })),
    ...unions.map((r) => ({ ...r, kind: "unionType" as const })),
    ...services.map((r) => ({ ...r, kind: "service" as const })),
  ];
  const byName = new Map<string, NamedAsset[]>();
  for (const a of all) {
    const key = a.name.trim().toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), a]);
  }
  const conflicts: Array<{ name: string; assets: NamedAsset[] }> = [];
  for (const [, group] of byName) {
    if (group.length < 2) continue;
    const clashing = group.filter((a) => group.some((b) => b !== a && inSameLine(a, b)));
    if (clashing.length > 0) conflicts.push({ name: clashing[0].name, assets: clashing });
  }
  return conflicts;
}
```

- [ ] **Step 4: Run unit tests — expect PASS.**

- [ ] **Step 5: Integration test — concurrency** (`tests/integration/services/name-registry.test.ts`)

```ts
import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { assertNameAvailable, withTenantNameLock } from "@/services/name-registry.service";

let prisma: PrismaClient;
const TENANT = "tenant_default";

beforeAll(() => {
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
});
afterAll(async () => prisma.$disconnect());

describe("name registry (db)", () => {
  it("only one of two concurrent same-name creates succeeds", async () => {
    const domain = await prisma.domain.create({ data: { name: `nr-${Date.now()}`, slug: `nr-${Date.now()}`, tenantId: TENANT } });
    const name = `Race${Date.now()}`;
    const attempt = () =>
      withTenantNameLock(prisma, TENANT, async (tx) => {
        const free = await assertNameAvailable(tx, { name, tenantId: TENANT, domainId: domain.id, productId: null });
        if (!free.success) return "conflict";
        await tx.sharedEnum.create({ data: { name, values: ["A"], tenantId: TENANT, domainId: domain.id } });
        return "created";
      });
    const results = await Promise.all([attempt(), attempt()]);
    expect(results.sort()).toEqual(["conflict", "created"]);
    await prisma.domain.delete({ where: { id: domain.id } });
  });
});
```

Run → PASS.

- [ ] **Step 6: Conflict report script** (`scripts/report-name-conflicts.ts`)

```ts
import "dotenv/config";
import { prisma } from "@/lib/db";
import { findNameConflicts } from "@/services/name-registry.service";

async function main() {
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } });
  let total = 0;
  for (const t of tenants) {
    const conflicts = await findNameConflicts(prisma, t.id);
    total += conflicts.length;
    for (const c of conflicts) {
      console.log(`[${t.name}] "${c.name}": ${c.assets.map((a) => `${a.kind}#${a.id} (domain=${a.domainId ?? "-"}, product=${a.productId ?? "-"})`).join(", ")}`);
    }
  }
  console.log(`${total} name conflict group(s).`);
  await prisma.$disconnect();
}
void main();
```

Add `"db:name-conflicts": "tsx scripts/report-name-conflicts.ts"` to `package.json`. Run it once against the dev DB and paste the summary into the commit body.

- [ ] **Step 7: Commit** — `git commit -m "feat(13.3): line-unique name registry with tenant advisory lock + conflict report"`

---

### Task 6: Level-aware creates wired through the registry (Stories 13.2 + 13.3)

**Files:**
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/actions.ts` — `createEntityAction` (~line 55), the second entity create (~line 158), `createSharedEnumAction`, `createCustomScalarAction`, `createUnionTypeAction`, `createServiceAction`, `getOrCreateEntityServiceAction`, `createDomainAssetsFromImportAction` (~line 606+), and entity rename (search `name:` updates in `updateEntityAction`, if present)
- Modify: `src/services/entity.service.ts` (`createEntity`, `updateEntity` name changes)
- Create: `src/lib/asset-scope.ts`
- Test: `tests/unit/lib/asset-scope.test.ts`, extend `tests/unit/app/schema-import-actions.test.ts`

**Interfaces:**
- Consumes: `validateScope` (Task 3), `assertNameAvailable`, `withTenantNameLock` (Task 5).
- Produces:
  ```ts
  // src/lib/asset-scope.ts
  export type ScopeTarget = { level: "TENANT"; tenantId: string } | { level: "DOMAIN"; domainId: string } | { level: "PRODUCT"; productId: string };
  export async function resolveScope(db: Db, target: ScopeTarget): Promise<Result<LevelScope>>;
  ```
  Data Type actions gain an optional final parameter `target?: ScopeTarget` (default `{ level: "DOMAIN", domainId }` — current behavior). `createEntityAction(domainId, data, productId?)` keeps its signature; a new `createTenantEntityAction(data)` creates at tenant level for the active tenant (`getActiveTenantId()`).

- [ ] **Step 1: Failing test for `resolveScope`**

```ts
import { describe, it, expect, vi } from "vitest";
import { resolveScope } from "@/lib/asset-scope";

const db = {
  domain: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === "d1" ? { id: "d1", tenantId: "t1" } : null)) },
  product: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === "p1" ? { id: "p1", domainId: "d1", domain: { tenantId: "t1" } } : null)) },
};

describe("resolveScope", () => {
  it("resolves product → domain → tenant", async () => {
    const r = await resolveScope(db as never, { level: "PRODUCT", productId: "p1" });
    expect(r.success && r.data).toEqual({ tenantId: "t1", domainId: "d1", productId: "p1" });
  });
  it("resolves domain", async () => {
    const r = await resolveScope(db as never, { level: "DOMAIN", domainId: "d1" });
    expect(r.success && r.data).toEqual({ tenantId: "t1", domainId: "d1", productId: null });
  });
  it("resolves tenant", async () => {
    const r = await resolveScope(db as never, { level: "TENANT", tenantId: "t1" });
    expect(r.success && r.data).toEqual({ tenantId: "t1", domainId: null, productId: null });
  });
  it("NOT_FOUND for unknown product", async () => {
    const r = await resolveScope(db as never, { level: "PRODUCT", productId: "nope" });
    expect(!r.success && r.error.code).toBe("NOT_FOUND");
  });
});
```

- [ ] **Step 2: Run — FAIL.** **Step 3: Implement** `src/lib/asset-scope.ts`:

```ts
import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import type { LevelScope } from "@/lib/levels";
import { ok, err, type Result } from "@/types/result";

type Db = PrismaClient | Prisma.TransactionClient;

export type ScopeTarget =
  | { level: "TENANT"; tenantId: string }
  | { level: "DOMAIN"; domainId: string }
  | { level: "PRODUCT"; productId: string };

export async function resolveScope(db: Db, target: ScopeTarget): Promise<Result<LevelScope>> {
  if (target.level === "TENANT") return ok({ tenantId: target.tenantId, domainId: null, productId: null });
  if (target.level === "DOMAIN") {
    const d = await db.domain.findUnique({ where: { id: target.domainId }, select: { id: true, tenantId: true } });
    if (!d) return err({ code: "NOT_FOUND", message: `Domain "${target.domainId}" not found` });
    return ok({ tenantId: d.tenantId, domainId: d.id, productId: null });
  }
  const p = await db.product.findUnique({
    where: { id: target.productId },
    select: { id: true, domainId: true, domain: { select: { tenantId: true } } },
  });
  if (!p) return err({ code: "NOT_FOUND", message: `Product "${target.productId}" not found` });
  return ok({ tenantId: p.domain.tenantId, domainId: p.domainId, productId: p.id });
}
```

Run → PASS.

- [ ] **Step 4: Rewrite each create action with one pattern** (example: `createSharedEnumAction`)

```ts
export async function createSharedEnumAction(
  domainId: string,
  data: { name: string; values: string[]; description?: string },
  target: ScopeTarget = { level: "DOMAIN", domainId }
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  const scope = await resolveScope(prisma, target);
  if (!scope.success) return { error: scope.error.message };
  const valid = validateScope("dataType", scope.data);
  if (!valid.success) return { error: valid.error.message };
  try {
    const result = await withTenantNameLock(prisma, scope.data.tenantId, async (tx) => {
      const free = await assertNameAvailable(tx, { name: data.name, ...scope.data });
      if (!free.success) return free;
      await tx.sharedEnum.create({
        data: { name: data.name, values: data.values, description: data.description ?? "", ...scope.data },
      });
      return { success: true as const, data: undefined };
    });
    if (!result.success) return { error: result.error.message };
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : "Failed to create enum" };
  }
}
```

Apply the same pattern (kind `"dataType"`) to `createCustomScalarAction`, `createUnionTypeAction`; kind `"api"` to `createServiceAction` (target default `{ level: "DOMAIN", domainId }`; accept `{ level: "PRODUCT", productId }`) and `getOrCreateEntityServiceAction` (scope = the entity's own scope; tenant-level entities resolve the API to the entity's... — APIs cannot be tenant level, so return `{ error: "Enterprise entities cannot own APIs" }` for tenant-level entities); kind `"entity"` to both entity creates (scope = product target; `ensureDefaultProductId` fallback kept) and `entity.service.createEntity`.
- `createDomainAssetsFromImportAction`: inside its existing `$transaction`, first `SELECT pg_advisory_xact_lock(hashtext(tenantId))`, then call `assertNameAvailable(tx, …)` per created asset; on the first conflict throw a typed `NameConflictError` caught outside the transaction and returned as `{ success: false, errors: [message] }` in the existing `BulkImportResult` shape.
- Renames: wherever an entity / data type / service `name` is updated, call `assertNameAvailable` with `exclude: { kind, id }` inside `withTenantNameLock`.
- New `createTenantEntityAction(data)` in `src/app/(dashboard)/schemas/enterprise/actions.ts` (file created in Task 12) — implemented there.

- [ ] **Step 5: Extend `tests/unit/app/schema-import-actions.test.ts`** with a case where the mocked registry returns a conflict and the action returns `success: false` with the conflict message (mock `@/services/name-registry.service` with `vi.mock`, returning `{ success: false, error: { code: "NAME_CONFLICT", message: "dup" } }` from `assertNameAvailable`, and `withTenantNameLock: (_db, _t, fn) => fn(txMock)`).

- [ ] **Step 6: Verify** — `npx vitest run tests/unit` (baseline only), `npx tsc --noEmit` clean.

- [ ] **Step 7: Commit** — `git commit -m "feat(13.2,13.3): level-aware creates and renames enforce line-unique names"`

---

### Task 7: `assetHref()` + reserved slugs (Stories 13.7, 13.5)

**Files:**
- Create: `src/lib/navigation/asset-href.ts`
- Modify: `src/lib/slug.ts`
- Modify: domain/product/entity create paths that already call `isReservedSchemaRouteSlug` / `isReservedEntityRouteSlug` (find with `grep -rn "isReserved" src`) — product creation must also reject reserved product slugs (`new` is not a product route, but `enterprise` is only a domain concern; products sit under a domain so no extra set is needed)
- Test: `tests/unit/lib/asset-href.test.ts`, `tests/unit/lib/slug.test.ts` (extend or create)

**Interfaces:**
- Produces:
  ```ts
  export type AssetRef =
    | { kind: "enterprise" }
    | { kind: "domain"; domainSlug: string }
    | { kind: "product"; domainSlug: string; productSlug: string }
    | { kind: "entity"; slug: string; domainSlug: string | null; productSlug: string | null }
    | { kind: "dataTypes"; domainSlug: string | null; productSlug: string | null }
    | { kind: "apis"; domainSlug: string; productSlug: string | null }
    | { kind: "traits"; domainSlug: string | null; productSlug: string | null }
    | { kind: "trait"; id: string; domainSlug: string | null; productSlug: string | null }
    | { kind: "message" | "channel" | "eventSpec"; id: string; domainSlug: string; productSlug: string }
    | { kind: "field"; entitySlug: string; fieldId: string; domainSlug: string | null; productSlug: string | null }
    | { kind: "newEntity"; domainSlug: string | null; productSlug: string | null };
  export function assetHref(ref: AssetRef, opts?: { version?: string; query?: Record<string, string> }): string;
  ```

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from "vitest";
import { assetHref } from "@/lib/navigation/asset-href";

describe("assetHref", () => {
  it("levels", () => {
    expect(assetHref({ kind: "enterprise" })).toBe("/schemas/enterprise");
    expect(assetHref({ kind: "domain", domainSlug: "payments" })).toBe("/schemas/payments");
    expect(assetHref({ kind: "product", domainSlug: "payments", productSlug: "checkout" })).toBe("/schemas/payments/checkout");
  });
  it("entities at product and tenant level", () => {
    expect(assetHref({ kind: "entity", slug: "order", domainSlug: "payments", productSlug: "checkout" })).toBe("/schemas/payments/checkout/order");
    expect(assetHref({ kind: "entity", slug: "customer", domainSlug: null, productSlug: null })).toBe("/schemas/enterprise/entities/customer");
  });
  it("version deep link", () => {
    expect(assetHref({ kind: "entity", slug: "order", domainSlug: "payments", productSlug: "checkout" }, { version: "2.1" }))
      .toBe("/schemas/payments/checkout/order?version=2.1");
  });
  it("data types tab at each level", () => {
    expect(assetHref({ kind: "dataTypes", domainSlug: null, productSlug: null })).toBe("/schemas/enterprise?tab=data-types");
    expect(assetHref({ kind: "dataTypes", domainSlug: "payments", productSlug: null })).toBe("/schemas/payments?tab=data-types");
    expect(assetHref({ kind: "dataTypes", domainSlug: "payments", productSlug: "checkout" })).toBe("/schemas/payments/checkout?tab=data-types");
  });
  it("apis tab at domain and product", () => {
    expect(assetHref({ kind: "apis", domainSlug: "payments", productSlug: null })).toBe("/schemas/payments?tab=apis");
    expect(assetHref({ kind: "apis", domainSlug: "payments", productSlug: "checkout" })).toBe("/schemas/payments/checkout?tab=apis");
  });
  it("event kinds", () => {
    expect(assetHref({ kind: "eventSpec", id: "s1", domainSlug: "payments", productSlug: "checkout" })).toBe("/schemas/payments/checkout/specs/s1");
    expect(assetHref({ kind: "message", id: "m1", domainSlug: "payments", productSlug: "checkout" })).toBe("/schemas/payments/checkout/messages/m1");
    expect(assetHref({ kind: "channel", id: "c1", domainSlug: "payments", productSlug: "checkout" })).toBe("/schemas/payments/checkout/channels/c1");
  });
  it("traits at each level", () => {
    expect(assetHref({ kind: "trait", id: "t1", domainSlug: null, productSlug: null })).toBe("/schemas/enterprise/traits/t1");
    expect(assetHref({ kind: "trait", id: "t1", domainSlug: "payments", productSlug: null })).toBe("/schemas/payments/traits/t1");
    expect(assetHref({ kind: "trait", id: "t1", domainSlug: "payments", productSlug: "checkout" })).toBe("/schemas/payments/checkout/traits/t1");
  });
  it("new entity", () => {
    expect(assetHref({ kind: "newEntity", domainSlug: null, productSlug: null })).toBe("/schemas/enterprise/new");
    expect(assetHref({ kind: "newEntity", domainSlug: "payments", productSlug: "checkout" })).toBe("/schemas/payments/checkout/new");
  });
  it("encodes slugs", () => {
    expect(assetHref({ kind: "domain", domainSlug: "a b" })).toBe("/schemas/a%20b");
  });
});
```

And in `tests/unit/lib/slug.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isReservedSchemaRouteSlug, isReservedEntityRouteSlug } from "@/lib/slug";

describe("reserved slugs", () => {
  it("schema route", () => {
    expect(isReservedSchemaRouteSlug("enterprise")).toBe(true);
    expect(isReservedSchemaRouteSlug("type-mappings")).toBe(true);
    expect(isReservedSchemaRouteSlug("payments")).toBe(false);
  });
  it("entity route", () => {
    for (const s of ["new", "events", "channels", "messages", "specs", "traits", "data-types", "apis"]) {
      expect(isReservedEntityRouteSlug(s)).toBe(true);
    }
    expect(isReservedEntityRouteSlug("order")).toBe(false);
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement**

`src/lib/slug.ts`:

```ts
const RESERVED_SCHEMA_ROUTE_SLUGS = new Set(["type-mappings", "enterprise"]);

// Static route segments that sit beside the dynamic [entityId] segment
// (/schemas/[domainSlug]/[productSlug]/<segment>). An entity whose slug
// matches one would be shadowed by the static page and become unreachable.
const RESERVED_ENTITY_ROUTE_SLUGS = new Set([
  "new", "events", "channels", "messages", "specs", "traits", "data-types", "apis",
]);
```

`src/lib/navigation/asset-href.ts`:

```ts
/**
 * The single source of truth for in-app URLs (spec §4.5). Every link —
 * sidebar, command palette, cards, breadcrumbs, cross-product references,
 * version deep links — goes through here.
 */
export type AssetRef =
  | { kind: "enterprise" }
  | { kind: "domain"; domainSlug: string }
  | { kind: "product"; domainSlug: string; productSlug: string }
  | { kind: "entity"; slug: string; domainSlug: string | null; productSlug: string | null }
  | { kind: "dataTypes"; domainSlug: string | null; productSlug: string | null }
  | { kind: "apis"; domainSlug: string; productSlug: string | null }
  | { kind: "traits"; domainSlug: string | null; productSlug: string | null }
  | { kind: "trait"; id: string; domainSlug: string | null; productSlug: string | null }
  | { kind: "message" | "channel" | "eventSpec"; id: string; domainSlug: string; productSlug: string }
  | { kind: "field"; entitySlug: string; fieldId: string; domainSlug: string | null; productSlug: string | null }
  | { kind: "newEntity"; domainSlug: string | null; productSlug: string | null };

const ROOT = "/schemas";
const ENTERPRISE = `${ROOT}/enterprise`;
const enc = encodeURIComponent;

function levelBase(domainSlug: string | null, productSlug: string | null): string {
  if (!domainSlug) return ENTERPRISE;
  if (!productSlug) return `${ROOT}/${enc(domainSlug)}`;
  return `${ROOT}/${enc(domainSlug)}/${enc(productSlug)}`;
}

function entityBase(slug: string, domainSlug: string | null, productSlug: string | null): string {
  if (!domainSlug || !productSlug) return `${ENTERPRISE}/entities/${enc(slug)}`;
  return `${levelBase(domainSlug, productSlug)}/${enc(slug)}`;
}

const EVENT_SEGMENT = { message: "messages", channel: "channels", eventSpec: "specs" } as const;

function path(ref: AssetRef): { path: string; query: Record<string, string> } {
  switch (ref.kind) {
    case "enterprise":
      return { path: ENTERPRISE, query: {} };
    case "domain":
      return { path: levelBase(ref.domainSlug, null), query: {} };
    case "product":
      return { path: levelBase(ref.domainSlug, ref.productSlug), query: {} };
    case "entity":
      return { path: entityBase(ref.slug, ref.domainSlug, ref.productSlug), query: {} };
    case "field":
      return { path: `${entityBase(ref.entitySlug, ref.domainSlug, ref.productSlug)}/fields/${enc(ref.fieldId)}`, query: {} };
    case "dataTypes":
      return { path: levelBase(ref.domainSlug, ref.productSlug), query: { tab: "data-types" } };
    case "apis":
      return { path: levelBase(ref.domainSlug, ref.productSlug), query: { tab: "apis" } };
    case "traits":
      return { path: levelBase(ref.domainSlug, ref.productSlug), query: { tab: "traits" } };
    case "trait":
      return { path: `${levelBase(ref.domainSlug, ref.productSlug)}/traits/${enc(ref.id)}`, query: {} };
    case "message":
    case "channel":
    case "eventSpec":
      return { path: `${levelBase(ref.domainSlug, ref.productSlug)}/${EVENT_SEGMENT[ref.kind]}/${enc(ref.id)}`, query: {} };
    case "newEntity":
      return { path: `${levelBase(ref.domainSlug, ref.productSlug)}/new`, query: {} };
  }
}

export function assetHref(ref: AssetRef, opts: { version?: string; query?: Record<string, string> } = {}): string {
  const { path: p, query } = path(ref);
  const qs = new URLSearchParams({ ...query, ...(opts.query ?? {}) });
  if (opts.version) qs.set("version", opts.version);
  const s = qs.toString();
  return s ? `${p}?${s}` : p;
}
```

- [ ] **Step 4: Run — PASS.** Also wire reserved checks: domain creation (`createDomainAction`, find via `grep -rn "isReservedSchemaRouteSlug" src`) already uses the schema set — verify `enterprise` now rejects with a user-facing message; entity creation already uses the entity set.

- [ ] **Step 5: Commit** — `git commit -m "feat(13.7,13.5): canonical assetHref URL builder; reserve enterprise + event route slugs"`

---

### Task 8: Domains-tree API v2 (Story 13.8 data)

**Files:**
- Modify: `src/app/api/domains-tree/route.ts`
- Modify: `src/hooks/useDomainsTree.ts`
- Create: `src/lib/navigation/build-explorer-tree.ts` (pure shaping, testable)
- Test: `tests/unit/lib/build-explorer-tree.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ExplorerEntity { id: string; name: string; slug: string; status: string }
  export interface ExplorerCounts { dataTypes: number; apis: number; entities: number; traits: number; messages: number; channels: number; eventSpecs: number }
  export interface ExplorerProduct { id: string; name: string; slug: string; isSystem: boolean; counts: ExplorerCounts; entities: ExplorerEntity[] }
  export interface ExplorerDomain { id: string; name: string; slug: string; isSystem: boolean; counts: Pick<ExplorerCounts, "dataTypes" | "apis" | "traits">; products: ExplorerProduct[] }
  export interface ExplorerTree { enterprise: { counts: Pick<ExplorerCounts, "dataTypes" | "entities" | "traits">; entities: ExplorerEntity[] }; domains: ExplorerDomain[] }
  export function buildExplorerTree(input: ExplorerRows): ExplorerTree;
  ```
  `ExplorerRows` = flat row arrays: `domains`, `products`, `entities` (with `domainId`, `productId`), and level-tagged data type / service rows `{ domainId, productId }`. Traits / messages / channels / eventSpecs counts are `0` until Phase 4 adds the tables.
- The hook keeps its name `useDomainsTree` but returns `ExplorerTree`; `domainsTreeQueryKey` unchanged so existing invalidations keep working.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { buildExplorerTree } from "@/lib/navigation/build-explorer-tree";

describe("buildExplorerTree", () => {
  it("places rows at the right level and counts per level", () => {
    const tree = buildExplorerTree({
      domains: [{ id: "d1", name: "Payments", slug: "payments", isSystem: false }],
      products: [{ id: "p1", domainId: "d1", name: "Checkout", slug: "checkout", isSystem: false }],
      entities: [
        { id: "e0", name: "Customer", slug: "customer", status: "ACTIVE", domainId: null, productId: null },
        { id: "e1", name: "Order", slug: "order", status: "DRAFT", domainId: "d1", productId: "p1" },
      ],
      dataTypes: [
        { domainId: null, productId: null },
        { domainId: "d1", productId: null },
        { domainId: "d1", productId: "p1" },
        { domainId: "d1", productId: "p1" },
      ],
      services: [{ domainId: "d1", productId: null }],
    });
    expect(tree.enterprise.counts).toEqual({ dataTypes: 1, entities: 1, traits: 0 });
    expect(tree.enterprise.entities.map((e) => e.slug)).toEqual(["customer"]);
    expect(tree.domains[0].counts).toEqual({ dataTypes: 1, apis: 1, traits: 0 });
    expect(tree.domains[0].products[0].counts).toMatchObject({ dataTypes: 2, apis: 0, entities: 1 });
    expect(tree.domains[0].products[0].entities.map((e) => e.slug)).toEqual(["order"]);
  });
});
```

- [ ] **Step 2: Run — FAIL.** **Step 3: Implement** `src/lib/navigation/build-explorer-tree.ts`:

```ts
export interface ExplorerEntity { id: string; name: string; slug: string; status: string }
export interface ExplorerCounts { dataTypes: number; apis: number; entities: number; traits: number; messages: number; channels: number; eventSpecs: number }
export interface ExplorerProduct { id: string; name: string; slug: string; isSystem: boolean; counts: ExplorerCounts; entities: ExplorerEntity[] }
export interface ExplorerDomain { id: string; name: string; slug: string; isSystem: boolean; counts: Pick<ExplorerCounts, "dataTypes" | "apis" | "traits">; products: ExplorerProduct[] }
export interface ExplorerTree {
  enterprise: { counts: Pick<ExplorerCounts, "dataTypes" | "entities" | "traits">; entities: ExplorerEntity[] };
  domains: ExplorerDomain[];
}

type LevelRow = { domainId: string | null; productId: string | null };
export interface ExplorerRows {
  domains: Array<{ id: string; name: string; slug: string; isSystem: boolean }>;
  products: Array<{ id: string; domainId: string; name: string; slug: string; isSystem: boolean }>;
  entities: Array<ExplorerEntity & LevelRow>;
  dataTypes: LevelRow[];
  services: LevelRow[];
}

const TENANT = "__tenant__";
const keyOf = (r: LevelRow) => r.productId ?? r.domainId ?? TENANT;

function countBy(rows: LevelRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(keyOf(r), (m.get(keyOf(r)) ?? 0) + 1);
  return m;
}

export function buildExplorerTree(input: ExplorerRows): ExplorerTree {
  const dataTypes = countBy(input.dataTypes);
  const services = countBy(input.services);
  const entitiesByKey = new Map<string, ExplorerEntity[]>();
  for (const e of [...input.entities].sort((a, b) => a.name.localeCompare(b.name))) {
    const k = keyOf(e);
    entitiesByKey.set(k, [...(entitiesByKey.get(k) ?? []), { id: e.id, name: e.name, slug: e.slug, status: e.status }]);
  }
  const tenantEntities = entitiesByKey.get(TENANT) ?? [];

  return {
    enterprise: {
      counts: { dataTypes: dataTypes.get(TENANT) ?? 0, entities: tenantEntities.length, traits: 0 },
      entities: tenantEntities,
    },
    domains: input.domains.map((d) => ({
      id: d.id,
      name: d.name,
      slug: d.slug,
      isSystem: d.isSystem,
      counts: { dataTypes: dataTypes.get(d.id) ?? 0, apis: services.get(d.id) ?? 0, traits: 0 },
      products: input.products
        .filter((p) => p.domainId === d.id)
        .sort((a, b) => Number(b.isSystem) - Number(a.isSystem) || a.name.localeCompare(b.name))
        .map((p) => {
          const entities = entitiesByKey.get(p.id) ?? [];
          return {
            id: p.id,
            name: p.name,
            slug: p.slug,
            isSystem: p.isSystem,
            counts: {
              dataTypes: dataTypes.get(p.id) ?? 0,
              apis: services.get(p.id) ?? 0,
              entities: entities.length,
              traits: 0,
              messages: 0,
              channels: 0,
              eventSpecs: 0,
            },
            entities,
          };
        }),
    })),
  };
}
```

Then rewrite the route:

```ts
import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";
import { getActiveTenantId } from "@/lib/active-tenant";
import { buildExplorerTree } from "@/lib/navigation/build-explorer-tree";

export async function GET() {
  const tenantId = await getActiveTenantId();
  const levelSelect = { domainId: true, productId: true } as const;
  const [domains, products, entities, enums, scalars, unions, services] = await Promise.all([
    prisma.domain.findMany({ where: { tenantId }, orderBy: [{ isSystem: "desc" }, { name: "asc" }], select: { id: true, name: true, slug: true, isSystem: true } }),
    prisma.product.findMany({ where: { domain: { tenantId } }, select: { id: true, domainId: true, name: true, slug: true, isSystem: true } }),
    prisma.entity.findMany({ where: { tenantId }, orderBy: { name: "asc" }, select: { id: true, name: true, slug: true, status: true, domainId: true, productId: true } }),
    prisma.sharedEnum.findMany({ where: { tenantId }, select: levelSelect }),
    prisma.customScalar.findMany({ where: { tenantId }, select: levelSelect }),
    prisma.unionType.findMany({ where: { tenantId }, select: levelSelect }),
    prisma.serviceDefinition.findMany({ where: { tenantId }, select: levelSelect }),
  ]);
  return NextResponse.json(
    buildExplorerTree({ domains, products, entities, dataTypes: [...enums, ...scalars, ...unions], services })
  );
}
```

- [ ] **Step 4: Update `useDomainsTree.ts`** types to `ExplorerTree` (re-export the types from `build-explorer-tree.ts`). Run `npx tsc --noEmit`: fix every consumer of the old `DomainTreeNode[]` shape (`LeftSidebar.tsx` is rewritten in Task 9; `CommandPalette` and any other consumer — `grep -rn "useDomainsTree\|DomainTreeNode\|DomainTreeEntity" src` — map to the new shape using `assetHref`).

- [ ] **Step 5: Run tests — PASS; commit** — `git commit -m "feat(13.8): explorer tree API with enterprise/domain/product levels"`

---

### Task 9: Left sidebar redesign (Story 13.8)

**Files:**
- Modify: `src/components/layout/LeftSidebar.tsx`
- Create: `src/components/layout/sidebar/SidebarNodes.tsx` (move `SidebarCategory`, `SidebarLeafCategory`, `CountBadge`, `getStatusColor`, add `SidebarEntityRow`)
- Rewrite test: `tests/unit/components/left-sidebar-domain-assets.test.tsx`

**Interfaces:**
- Consumes: `useDomainsTree(): { data?: ExplorerTree }` (Task 8), `assetHref` (Task 7).
- Behavior:
  - Top: **Enterprise** node (expanded by default) → `Data Types (n)` leaf (`assetHref({kind:"dataTypes",domainSlug:null,productSlug:null})`), `Entities (n)` expandable list. Each hidden when its count is 0. The Enterprise node itself always renders (it is the entry point to create tenant-level items); its "+" opens `assetHref({kind:"newEntity",domainSlug:null,productSlug:null})`.
  - Domain node → `Data Types` leaf, `APIs` leaf (each hidden when 0) → product nodes (hidden list when none).
  - Product node → `Entities` expandable (hidden when 0), `Data Types`, `APIs` leaves (hidden when 0). Phase 4 adds Events / Messages / Channels / Traits leaves here.
  - Active state from `usePathname()` + `useSearchParams().get("tab")` (replace the `window.location` helper so active state re-renders on navigation).
  - Search filters entities at every level; domains/products with a matching name or a matching entity remain visible.
  - Domain "+" → `assetHref({kind:"newEntity", domainSlug, productSlug: <first product slug or "default">})`.

- [ ] **Step 1: Rewrite the test** (`tests/unit/components/left-sidebar-domain-assets.test.tsx`) — mock `useDomainsTree` and `next/navigation`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LeftSidebar } from "@/components/layout/LeftSidebar";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/schemas/payments",
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams(""),
}));

const tree = {
  enterprise: { counts: { dataTypes: 2, entities: 1, traits: 0 }, entities: [{ id: "e0", name: "Customer", slug: "customer", status: "ACTIVE" }] },
  domains: [
    {
      id: "d1", name: "Payments", slug: "payments", isSystem: false,
      counts: { dataTypes: 0, apis: 1, traits: 0 },
      products: [
        { id: "p1", name: "Checkout", slug: "checkout", isSystem: false,
          counts: { dataTypes: 3, apis: 0, entities: 1, traits: 0, messages: 0, channels: 0, eventSpecs: 0 },
          entities: [{ id: "e1", name: "Order", slug: "order", status: "DRAFT" }] },
      ],
    },
  ],
};
vi.mock("@/hooks/useDomainsTree", () => ({ useDomainsTree: () => ({ data: tree, isLoading: false, isError: false, refetch: vi.fn() }) }));

const props = { width: 260, isCollapsed: false, onMouseDown: vi.fn(), onDoubleClick: vi.fn() };

describe("LeftSidebar", () => {
  beforeEach(() => push.mockReset());

  it("renders Enterprise with its non-empty categories", () => {
    render(<LeftSidebar {...props} />);
    expect(screen.getByText("Enterprise")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("enterprise-data-types"));
    expect(push).toHaveBeenCalledWith("/schemas/enterprise?tab=data-types");
  });

  it("hides empty domain categories and shows non-empty ones", () => {
    render(<LeftSidebar {...props} />);
    expect(screen.queryByTestId("domain-d1-data-types")).toBeNull();
    fireEvent.click(screen.getByTestId("domain-d1-apis"));
    expect(push).toHaveBeenCalledWith("/schemas/payments?tab=apis");
  });

  it("renders products with their categories and links entities canonically", () => {
    render(<LeftSidebar {...props} />);
    fireEvent.click(screen.getByText("Checkout"));
    expect(push).toHaveBeenCalledWith("/schemas/payments/checkout");
    expect(screen.queryByTestId("product-p1-apis")).toBeNull();
    fireEvent.click(screen.getByTestId("product-p1-data-types"));
    expect(push).toHaveBeenCalledWith("/schemas/payments/checkout?tab=data-types");
    fireEvent.click(screen.getByText("Order"));
    expect(push).toHaveBeenCalledWith("/schemas/payments/checkout/order");
  });

  it("uses the label Data Types, never Types", () => {
    render(<LeftSidebar {...props} />);
    expect(screen.queryByText(/^Types$/)).toBeNull();
    expect(screen.getAllByText("Data Types").length).toBeGreaterThan(0);
  });
});
```

(Products of the active domain render expanded by default so `Checkout` and its entity are visible; enterprise expanded by default.)

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Keep the existing visual language (classes, icons, resize handle, skeleton, error, empty state). Structure:

```tsx
// LeftSidebar.tsx (core render, abbreviated to the parts that change)
const { data: tree, isError, isLoading, refetch } = useDomainsTree();
const searchParams = useSearchParams();
const activeTab = searchParams.get("tab");
// expansion state: one Set<string> of user-expanded keys + one of user-collapsed keys,
// keys: "enterprise", "enterprise:entities", `d:${id}`, `p:${id}`, `p:${id}:entities`.
// defaults: enterprise + enterprise:entities, active domain, every product of the active domain, active product's entities.

<EnterpriseNode tree={tree.enterprise} ... />
{filteredDomains.map((domain) => (
  <DomainNode key={domain.id} domain={domain} ...>
    {domain.counts.dataTypes > 0 && (
      <SidebarLeafCategory testId={`domain-${domain.id}-data-types`} label="Data Types" count={domain.counts.dataTypes}
        icon={<Hash className="w-3 h-3 shrink-0" />}
        active={pathname === assetHref({ kind: "domain", domainSlug: domain.slug }) && activeTab === "data-types"}
        onClick={() => router.push(assetHref({ kind: "dataTypes", domainSlug: domain.slug, productSlug: null }))} />
    )}
    {domain.counts.apis > 0 && ( /* same with "apis", Globe icon */ )}
    {domain.products.map((product) => (
      <ProductNode key={product.id} domain={domain} product={product} ...>
        {product.counts.entities > 0 && <SidebarCategory testId={`product-${product.id}-entities`} label="Entities" ... />}
        {/* entity rows → router.push(assetHref({ kind: "entity", slug, domainSlug: domain.slug, productSlug: product.slug })) */}
        {product.counts.dataTypes > 0 && <SidebarLeafCategory testId={`product-${product.id}-data-types`} label="Data Types" ... />}
        {product.counts.apis > 0 && <SidebarLeafCategory testId={`product-${product.id}-apis`} label="APIs" ... />}
      </ProductNode>
    ))}
  </DomainNode>
))}
```

`SidebarLeafCategory` and `SidebarCategory` gain a `testId` prop rendered as `data-testid`. The "Explorer" header count stays (`domains.length`).

- [ ] **Step 4: Run** the test → PASS; run full unit suite → baseline minus the previously failing sidebar test (now 8 baseline failures).
- [ ] **Step 5: Commit** — `git commit -m "feat(13.8): explorer sidebar with Enterprise, products, hidden empty categories"` (this supersedes the uncommitted `domainPath→productPath` edit in `LeftSidebar.tsx`; stage the whole file).

---

### Task 10: Domain page tabs — Products / Data Types / APIs (Story 13.6)

**Files:**
- Create: `src/app/(dashboard)/schemas/[domainSlug]/domain-tabs.tsx` (client: tab bar + panels)
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/page.tsx` (load domain-level data types + APIs; render `DomainTabs` wrapping `ProductGrid`)
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/components/DomainTypesTab.tsx` (add `target: ScopeTarget` prop passed to create actions; add optional `inherited?: { label: string; href: string; sharedEnums; customScalars; unionTypes }[]` rendered read-only)
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/components/DomainApisTab.tsx` (add `target: ScopeTarget` prop; create service at that level)
- Test: `tests/unit/components/domain-tabs.test.tsx`

**Interfaces:**
- Consumes: `ScopeTarget` (Task 6), `assetHref` (Task 7), `normalizeWorkspaceTab`-style parsing.
- Produces: `DomainTabs({ domain, products, tiers, dataTypes, services, inheritedDataTypes })` where tab ids are `products | data-types | apis` (legacy `types` → `data-types`), default `products`.

- [ ] **Step 1: Failing test** — renders three tabs; `?tab=data-types` selects Data Types; DomainTypesTab receives `target={{ level: "DOMAIN", domainId }}`; Enterprise data types appear in a read-only "From Enterprise" section with a link to `/schemas/enterprise?tab=data-types`.

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DomainTabs } from "@/app/(dashboard)/schemas/[domainSlug]/domain-tabs";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams("tab=data-types"),
  usePathname: () => "/schemas/payments",
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/product-grid", () => ({ ProductGrid: () => <div>grid</div> }));

describe("DomainTabs", () => {
  it("shows Data Types tab with inherited enterprise section", () => {
    render(
      <DomainTabs
        domain={{ id: "d1", name: "Payments", slug: "payments", description: "" }}
        productGridProps={{} as never}
        dataTypes={{ sharedEnums: [], customScalars: [], unionTypes: [] }}
        inheritedDataTypes={[{ label: "From Enterprise", href: "/schemas/enterprise?tab=data-types", sharedEnums: [{ id: "x", name: "Country", values: ["US"], description: "" }], customScalars: [], unionTypes: [] }]}
        services={[]}
      />
    );
    expect(screen.getByRole("tab", { name: "Products" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Data Types", selected: true })).toBeInTheDocument();
    expect(screen.getByText("From Enterprise")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /From Enterprise/ })).toHaveAttribute("href", "/schemas/enterprise?tab=data-types");
  });
});
```

- [ ] **Step 2: Run — FAIL.** **Step 3: Implement** `domain-tabs.tsx` with `role="tablist"` / `role="tab"` / `aria-selected`, tab state synced to `?tab=` via `router.replace`. Page loader adds:

```ts
const [enums, scalars, unions, services, tenantEnums, tenantScalars, tenantUnions] = await Promise.all([
  prisma.sharedEnum.findMany({ where: { domainId: resolved.id, productId: null }, orderBy: { name: "asc" } }),
  prisma.customScalar.findMany({ where: { domainId: resolved.id, productId: null }, orderBy: { name: "asc" } }),
  prisma.unionType.findMany({ where: { domainId: resolved.id, productId: null }, orderBy: { name: "asc" } }),
  prisma.serviceDefinition.findMany({ where: { domainId: resolved.id, productId: null }, orderBy: { name: "asc" }, include: { entity: { select: { id: true, name: true, slug: true } }, operations: { orderBy: { name: "asc" }, include: { parameters: true, responses: true } } } }),
  prisma.sharedEnum.findMany({ where: { tenantId: resolved.tenantId, domainId: null }, orderBy: { name: "asc" } }),
  prisma.customScalar.findMany({ where: { tenantId: resolved.tenantId, domainId: null }, orderBy: { name: "asc" } }),
  prisma.unionType.findMany({ where: { tenantId: resolved.tenantId, domainId: null }, orderBy: { name: "asc" } }),
]);
```

Map rows to the existing `SharedEnumData` / `CustomScalarData` / `UnionTypeData` / `ServiceData` shapes exactly as `[productSlug]/page.tsx` does today (copy those mapping blocks into a shared helper `src/app/(dashboard)/schemas/[domainSlug]/map-asset-rows.ts` and use it from both pages).

- [ ] **Step 4: Run — PASS;** `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(13.6): domain page tabs for Products, Data Types and APIs"`

---

### Task 11: Product workspace — product-level items + inherited sections + level-aware New menu (Story 13.6)

**Files:**
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/page.tsx` (query product-level data types/APIs; domain + tenant data types as inherited; domain APIs as inherited)
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/domain-workspace.tsx` (pass `target={{ level: "PRODUCT", productId }}` to `DomainTypesTab` / `DomainApisTab`; render inherited sections; New menu limited to product kinds; breadcrumbs via `assetHref`)
- Test: extend `tests/unit/components/domain-workspace-tabs.test.tsx`

**Interfaces:**
- Consumes: `DomainTypesTab` `target` + `inherited` props (Task 10), `assetHref`.
- Query shapes: product-level `where: { productId: product.id }`; inherited domain `where: { domainId: domain.id, productId: null }`; inherited tenant `where: { tenantId: domain.tenantId, domainId: null }`.

- [ ] **Step 1: Failing test** — rendering `DomainWorkspace` with `?tab=data-types` shows sections "From Domain" (link `/schemas/payments?tab=data-types`) and "From Enterprise" (link `/schemas/enterprise?tab=data-types`) when inherited lists are non-empty, and hides each section when its list is empty. New-menu items are exactly: New Entity, New Data Type ▸ (Enum / Scalar / Union), New API.
- [ ] **Step 2: Run — FAIL.** **Step 3: Implement** (new optional props `inheritedDataTypes` / `inheritedServices` on `DomainWorkspaceProps`; pass-through to tabs). Replace hard-coded hrefs at `domain-workspace.tsx` lines ~251, 512–520, 553, 893, 905, 917, 973 with `assetHref` (`newEntity`, `domain`, `entity`).
- [ ] **Step 4: Run — PASS;** `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(13.6): product workspace shows product-level items with inherited domain/enterprise sections"`

---

### Task 12: Enterprise workspace + tenant entity routes (Story 13.5)

**Files:**
- Create: `src/app/(dashboard)/schemas/enterprise/page.tsx`, `enterprise-workspace.tsx`, `actions.ts`
- Create: `src/app/(dashboard)/schemas/enterprise/new/page.tsx`
- Create: `src/app/(dashboard)/schemas/enterprise/entities/[entityId]/page.tsx`
- Create: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/load-entity-workspace.ts` (extract the server-side data loading from `[entityId]/page.tsx` into `loadEntityWorkspace(where: { slugOrId: string; productId: string | null; tenantId: string })`)
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/page.tsx` (use the loader)
- Modify: `EntityCreationWizard` props to accept `target: ScopeTarget` (product or tenant) and `onCreatedHref` via `assetHref`
- Test: `tests/unit/app/enterprise-actions.test.ts`, `tests/unit/app/load-entity-workspace.test.ts`

**Interfaces:**
- Produces: `createTenantEntityAction(data: { name: string; description: string; fields: CreateFieldInput[] }): Promise<{ success: true; entity: { id: string; slug: string } } | { error: string }>` — scope `{ level: "TENANT", tenantId: await getActiveTenantId() }`, validated with `validateScope("entity", …)`, name checked under `withTenantNameLock`, slug checked with `isReservedEntityRouteSlug`.
- Enterprise page tabs: `data-types` (default when entities empty) | `entities`; Traits tab arrives in Phase 4. Data Types tab = `DomainTypesTab` with `target={{ level: "TENANT", tenantId }}`.
- Entity workspace for tenant entities: breadcrumb "Enterprise › <Entity>"; all intra-entity links via `assetHref({ kind: "entity", slug, domainSlug: null, productSlug: null })`; features requiring a product/domain (APIs tab) hidden for tenant entities.

- [ ] **Step 1: Failing tests**
  - `createTenantEntityAction` rejects reserved slugs (`"Events"` → slug `events`), rejects line conflicts (mock registry), creates with `domainId: null, productId: null, tenantId` on success.
  - `loadEntityWorkspace` resolves by slug first then id, scoped by `productId` (null = tenant) and `tenantId`; returns `null` when not found.
- [ ] **Step 2: Run — FAIL.** **Step 3: Implement.** The tenant entity page:

```tsx
// src/app/(dashboard)/schemas/enterprise/entities/[entityId]/page.tsx
import { notFound } from "next/navigation";
import { getActiveTenantId } from "@/lib/active-tenant";
import { loadEntityWorkspace } from "../../../[domainSlug]/[productSlug]/[entityId]/load-entity-workspace";
import { EntityWorkspace } from "../../../[domainSlug]/[productSlug]/[entityId]/entity-workspace";

interface Props { params: Promise<{ entityId: string }> }

export default async function EnterpriseEntityPage({ params }: Props) {
  const { entityId } = await params;
  const tenantId = await getActiveTenantId();
  const data = await loadEntityWorkspace({ slugOrId: entityId, productId: null, tenantId });
  if (!data) notFound();
  return <EntityWorkspace {...data.props} />;
}
```

(`loadEntityWorkspace` returns `{ props }` with exactly the props the product page passes to `EntityWorkspace` today, plus `level: "TENANT" | "PRODUCT"`; `EntityWorkspace` uses `level` to hide the APIs tab and to build breadcrumbs.)

- [ ] **Step 4: Run — PASS;** `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(13.5): Enterprise workspace, tenant-level entity routes and creation"`

---

### Task 13: Migrate remaining link sites to `assetHref` (Story 13.7)

**Files:** every hit of the commands below outside `asset-href.ts` itself:

```bash
grep -rn '`/schemas/\${' src --include=*.tsx --include=*.ts
grep -rn '"/schemas/' src --include=*.tsx --include=*.ts
```

Known sites (from exploration): `src/components/custom/CommandPalette*` (entity + field nav), `src/app/api/command-palette-fields/route.ts`, `EntityCard`, `EntityCreationWizard`, `EntityHeader` (breadcrumb), `field-editor` / `field-studio`, `DeprecationBanner`, compliance / deployment / notifications / lineage link builders.

**Interfaces:** Consumes `assetHref`. API routes that return hrefs (command palette fields) must return `domainSlug: string | null` and `productSlug: string | null` so the client builds links with `assetHref`.

- [ ] **Step 1: Failing test** — `tests/unit/lib/no-handbuilt-schema-links.test.ts`: reads all `src/**/*.{ts,tsx}` files (via `fs` + `glob` from `node:fs/promises` recursive `readdir`) and asserts no file other than `src/lib/navigation/asset-href.ts` and the legacy redirect in `[productSlug]/page.tsx` contains the regex `` /[`"']\/schemas\/\$\{/ ``.

```ts
import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const ALLOW = new Set([
  "src/lib/navigation/asset-href.ts",
  "src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/page.tsx",
]);

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "generated") out.push(...(await walk(p))); }
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("links", () => {
  it("every /schemas link is built by assetHref", async () => {
    const offenders: string[] = [];
    for (const f of await walk("src")) {
      if (ALLOW.has(f)) continue;
      const text = await readFile(f, "utf8");
      if (/[`"']\/schemas\/\$\{/.test(text)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — FAIL** (lists offenders). **Step 3:** Replace each with `assetHref(...)`. **Step 4:** Run → PASS; `npx tsc --noEmit` clean; full unit suite → baseline.
- [ ] **Step 5: Commit** — `git commit -m "refactor(13.7): route every schema link through assetHref"`

---

### Task 14: Playwright navigation click-through + link crawl (Story 13.9)

**Files:**
- Create: `tests/e2e/navigation.spec.ts`

**Interfaces:** Consumes `test`, `expect`, `unique` from `tests/e2e/helpers/auth.ts`.

- [ ] **Step 1: Write the spec**

```ts
import { test, expect, unique } from "./helpers/auth";

test.describe("navigation", () => {
  test("every sidebar node and breadcrumb resolves", async ({ authedPage: page }) => {
    await page.goto("/schemas");
    const sidebar = page.getByTestId("left-sidebar");
    const nodes = sidebar.locator("[data-testid$='-data-types'], [data-testid$='-apis'], [data-testid$='-entities']");
    const count = await nodes.count();
    for (let i = 0; i < count; i++) {
      await nodes.nth(i).click();
      await expect(page.locator("text=404")).toHaveCount(0);
      await expect(page).not.toHaveURL(/\/404/);
    }
  });

  test("legacy links still land", async ({ authedPage: page }) => {
    const res = await page.goto("/schemas/enterprise?tab=types");
    expect(res?.status()).toBeLessThan(400);
  });

  test("tenant-level entity is reachable from the sidebar", async ({ authedPage: page }) => {
    const name = unique("Ent");
    await page.goto("/schemas/enterprise/new");
    await page.getByRole("button", { name: /blank/i }).click();
    await page.getByLabel(/name/i).first().fill(name);
    await page.getByRole("button", { name: /create/i }).click();
    await page.waitForURL(/\/schemas\/enterprise\/entities\//);
    await page.goto("/schemas");
    await page.getByTestId("left-sidebar").getByText(name).click();
    await expect(page).toHaveURL(/\/schemas\/enterprise\/entities\//);
  });

  test("link crawl: no rendered href on workspace pages 404s", async ({ authedPage: page, request }) => {
    const start = ["/schemas", "/schemas/enterprise"];
    const seen = new Set<string>();
    const queue = [...start];
    while (queue.length && seen.size < 150) {
      const url = queue.shift()!;
      if (seen.has(url)) continue;
      seen.add(url);
      await page.goto(url);
      const hrefs = await page.$$eval("a[href^='/schemas']", (as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!));
      for (const h of hrefs) {
        if (!seen.has(h)) {
          const res = await request.get(h);
          expect(res.status(), `broken link ${h} on ${url}`).toBeLessThan(400);
          queue.push(h);
        }
      }
    }
  });
});
```

(The `request` fixture shares the authenticated storage state only if configured; if it does not, replace `request.get(h)` with `page.goto(h)` and assert on the response status.)

- [ ] **Step 2: Run** — `npx playwright test tests/e2e/navigation.spec.ts` against a running dev server (`reuseExistingServer`). Expected: PASS. Fix any broken link by routing it through `assetHref`.
- [ ] **Step 3: Commit** — `git commit -m "test(13.9): e2e navigation click-through and link crawl"`

---

## Phase 1 exit criteria

- `npx tsc --noEmit` clean.
- `npx vitest run` → only the 8 remaining baseline failures (all `@typespec/db`, Story 16.4).
- `npx playwright test tests/e2e/navigation.spec.ts tests/e2e/schema-lifecycle.spec.ts` green.
- `npm run db:name-conflicts` output reviewed; `npm run db:migrate-typespec-source` run on dev DB.
- Spec §4 fully implemented except §4.4 TypeSpec namespaces / Data Type resolution (moved to Phase 2 with 14.2).
