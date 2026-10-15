/**
 * Direct-DB fixtures for E2E specs.
 *
 * Playwright runs in Node, so specs can create and delete rows themselves against
 * DATABASE_URL (from .env). This needs the PostgreSQL provider: the embedded PGlite
 * database is single-process, so a second process (this one) cannot share it with
 * the running app.
 *
 * Why plain `pg` and not the generated PrismaClient: `src/generated/prisma/client.ts`
 * is ESM-only (`import.meta.url`), and Playwright loads spec code as CommonJS, so it
 * cannot be imported here. The SQL below targets the Prisma-mapped tables
 * (`domains`, `products`, `entities`, `fields`); every NOT NULL column without a DB
 * default is supplied (Prisma generates ids and `updatedAt` client-side).
 *
 * Fixtures make coverage deterministic (a domain, product and entities always
 * exist for the navigation checks to hit) and guarantee cleanup: deleting a domain
 * cascades to its products, entities and assets, and tenant-level entities are
 * deleted explicitly.
 */

import "dotenv/config";
import { randomBytes } from "node:crypto";
import { TEST_EMAIL } from "./auth";

interface PgPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

const DEFAULT_TENANT_ID = "tenant_default";

let pool: PgPool | undefined;

function pg(): PgPool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "E2E fixtures need DATABASE_URL (PostgreSQL provider). Set it in .env; the embedded PGlite database cannot be shared with the running app."
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- no @types/pg; see header
    const { Pool } = require("pg") as { Pool: new (config: { connectionString: string }) => PgPool };
    pool = new Pool({ connectionString });
  }
  return pool;
}

export async function disconnectDb() {
  await pool?.end();
  pool = undefined;
}

/** The tenant the logged-in admin sees (mirrors `getActiveTenantId` without a cookie). */
export async function activeTenantId(): Promise<string> {
  const { rows } = await pg().query(
    `SELECT id FROM tenants WHERE "isActive" = true ORDER BY "isSystem" DESC, name ASC LIMIT 1`
  );
  return (rows[0]?.id as string | undefined) ?? DEFAULT_TENANT_ID;
}

/** Lowercase alphanumeric suffix, unique per call. */
function suffix() {
  return `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
}

function newId() {
  return `e2e${randomBytes(10).toString("hex")}`;
}

export interface NavFixtures {
  tenantId: string;
  domain: { id: string; name: string; slug: string };
  product: { id: string; name: string; slug: string };
  /** Product-level entity with one field. */
  productEntity: { id: string; name: string; slug: string; fieldId: string };
  /** Tenant-level (Enterprise) entity with one field. */
  tenantEntity: { id: string; name: string; slug: string };
}

/** Create a domain + product + product-level entity + tenant-level entity, all uniquely named. */
export async function createNavFixtures(): Promise<NavFixtures> {
  const db = pg();
  const tenantId = await activeTenantId();
  const owner = await db.query(
    `SELECT id FROM users ORDER BY (email = $1) DESC, "createdAt" ASC LIMIT 1`,
    [TEST_EMAIL]
  );
  const ownerId = owner.rows[0]?.id as string | undefined;
  if (!ownerId) throw new Error("E2E fixtures need a seeded user (npm run db:seed).");

  const s = suffix();
  const domain = { id: newId(), name: `e2e-nav-dom-${s}`, slug: `e2e-nav-dom-${s}` };
  const product = { id: newId(), name: `e2e-nav-prod-${s}`, slug: `e2e-nav-prod-${s}` };
  const productEntityName = `NavProdEnt${s}`;
  const tenantEntityName = `NavTenantEnt${s}`;
  const productEntity = {
    id: newId(),
    name: productEntityName,
    slug: productEntityName.toLowerCase(),
    fieldId: newId(),
  };
  const tenantEntity = { id: newId(), name: tenantEntityName, slug: tenantEntityName.toLowerCase() };
  const tenantEntityFieldId = newId();

  const entitySql = `INSERT INTO entities (id, name, slug, "tenantId", "domainId", "productId", "ownerId", "updatedAt")
                     VALUES ($1, $2, $3, $4, $5, $6, $7, now())`;
  const fieldSql = `INSERT INTO fields (id, "entityId", name, slug, type, nullable, "isKey", "sortOrder", "updatedAt")
                    VALUES ($1, $2, 'id', 'id', 'string', false, true, 0, now())`;

  try {
    await db.query(`INSERT INTO domains (id, name, slug, "tenantId", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [
      domain.id,
      domain.name,
      domain.slug,
      tenantId,
    ]);
    await db.query(`INSERT INTO products (id, name, slug, "domainId", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [
      product.id,
      product.name,
      product.slug,
      domain.id,
    ]);
    await db.query(entitySql, [
      productEntity.id,
      productEntity.name,
      productEntity.slug,
      tenantId,
      domain.id,
      product.id,
      ownerId,
    ]);
    await db.query(fieldSql, [productEntity.fieldId, productEntity.id]);
    await db.query(entitySql, [tenantEntity.id, tenantEntity.name, tenantEntity.slug, tenantId, null, null, ownerId]);
    await db.query(fieldSql, [tenantEntityFieldId, tenantEntity.id]);
  } catch (error) {
    // Never leave a half-built fixture behind.
    await deleteNavFixtures({ tenantId, domain, product, productEntity, tenantEntity });
    throw error;
  }

  return { tenantId, domain, product, productEntity, tenantEntity };
}

/** Delete everything `createNavFixtures` made. Safe to call twice or on partial state. */
export async function deleteNavFixtures(fixtures: NavFixtures | undefined) {
  if (!fixtures) return;
  const db = pg();
  // Explicit: tenant-level entities are not reachable through a domain cascade.
  await db.query(`DELETE FROM entities WHERE id = $1`, [fixtures.tenantEntity.id]);
  // Edge rows have no FKs, so a specs / messages / entity-versions run leaves them behind: remove them first.
  await deleteSchemaReferencesForDomain(fixtures.domain.id);
  // Cascades to the product and its entities/fields, and to any channels, messages, traits, event specs and their
  // versions a spec created under it. The immutability triggers (20261015 / 20261016 *_no_delete) only refuse a
  // DIRECT delete of a published version; a delete of the owning row, or of a domain above it, is the sanctioned path.
  await db.query(`DELETE FROM domains WHERE id = $1`, [fixtures.domain.id]);
}

/**
 * `schema_references` has no FKs (polymorphic), so deleting a domain cascades to its messages, specs, versions and
 * entity versions but leaves the edge rows that start at them. This deletes those edges; `deleteNavFixtures` calls it
 * before the domain delete, and a spec may call it directly.
 *
 * Harmless next to the `entity_versions` delete trigger (20261017_schema_reference_ghost_edges) and the AFTER DELETE
 * triggers of 20261016_events_core_no_delete: they remove the same rows during the cascade, so this call then finds
 * nothing left. Returns the number of edge rows removed.
 */
export async function deleteSchemaReferencesForDomain(domainId: string): Promise<number> {
  const res = await pg().query(
    `DELETE FROM schema_references WHERE "fromId" IN (
       SELECT id FROM messages WHERE "domainId" = $1
       UNION SELECT mv.id FROM message_versions mv JOIN messages m ON m.id = mv."messageId" WHERE m."domainId" = $1
       UNION SELECT id FROM event_specs WHERE "domainId" = $1
       UNION SELECT sv.id FROM event_spec_versions sv JOIN event_specs s ON s.id = sv."eventSpecId" WHERE s."domainId" = $1
       UNION SELECT ev.id FROM entity_versions ev JOIN entities e ON e.id = ev."entityId" WHERE e."domainId" = $1
       UNION SELECT id FROM traits WHERE "domainId" = $1) RETURNING id`,
    [domainId]
  );
  return res.rows.length;
}

/** A second product in a fixture domain (the consumer side of a cross-product reference). Removed with the domain. */
export async function createProductInDomain(domainId: string): Promise<{ id: string; name: string; slug: string }> {
  const s = suffix();
  const product = { id: newId(), name: `e2e-nav-prod2-${s}`, slug: `e2e-nav-prod2-${s}` };
  await pg().query(`INSERT INTO products (id, name, slug, "domainId", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [
    product.id,
    product.name,
    product.slug,
    domainId,
  ]);
  return product;
}

export interface ForeignTenantSpec {
  tenantId: string;
  domainId: string;
  specId: string;
}

/**
 * An event spec that lives in ANOTHER tenant. The tenant is inactive, so `activeTenantId()` and the tenant switcher never
 * pick it. Its id must answer exactly like an unknown id, over REST and on the page.
 */
export async function createForeignTenantSpec(): Promise<ForeignTenantSpec> {
  const db = pg();
  const s = suffix();
  const ids = { tenantId: newId(), domainId: newId(), productId: newId(), specId: newId() };
  try {
    await db.query(`INSERT INTO tenants (id, name, slug, "isActive", "updatedAt") VALUES ($1, $2, $3, false, now())`, [
      ids.tenantId,
      `e2e-foreign-tenant-${s}`,
      `e2e-foreign-tenant-${s}`,
    ]);
    await db.query(`INSERT INTO domains (id, name, slug, "tenantId", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [
      ids.domainId,
      `e2e-foreign-dom-${s}`,
      `e2e-foreign-dom-${s}`,
      ids.tenantId,
    ]);
    await db.query(`INSERT INTO products (id, name, slug, "domainId", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [
      ids.productId,
      `e2e-foreign-prod-${s}`,
      `e2e-foreign-prod-${s}`,
      ids.domainId,
    ]);
    await db.query(
      `INSERT INTO event_specs (id, name, document, "tenantId", "domainId", "productId", "updatedAt")
       VALUES ($1, $2, '{}'::jsonb, $3, $4, $5, now())`,
      [ids.specId, `foreign-spec-${s}`, ids.tenantId, ids.domainId, ids.productId]
    );
  } catch (error) {
    // Never leave a half-built fixture behind.
    await deleteForeignTenantSpec({ tenantId: ids.tenantId, domainId: ids.domainId, specId: ids.specId });
    throw error;
  }
  return { tenantId: ids.tenantId, domainId: ids.domainId, specId: ids.specId };
}

/** Delete everything `createForeignTenantSpec` made. Safe to call twice or on partial state. */
export async function deleteForeignTenantSpec(fixture: ForeignTenantSpec | undefined) {
  if (!fixture) return;
  const db = pg();
  // The domain cascade removes its product and event spec; the tenant row is deleted explicitly.
  await db.query(`DELETE FROM domains WHERE id = $1`, [fixture.domainId]);
  await db.query(`DELETE FROM tenants WHERE id = $1`, [fixture.tenantId]);
}

/** Delete domains by exact name (cascades to products/entities/assets). Returns rows deleted. */
export async function deleteDomainsByName(names: readonly string[]): Promise<number> {
  if (names.length === 0) return 0;
  const res = await pg().query(`DELETE FROM domains WHERE name = ANY($1::text[]) RETURNING id`, [[...names]]);
  return res.rows.length;
}

/** Delete tenant-level entities by exact name. Returns rows deleted. */
export async function deleteTenantEntitiesByName(names: readonly string[]): Promise<number> {
  if (names.length === 0) return 0;
  const res = await pg().query(
    `DELETE FROM entities WHERE name = ANY($1::text[]) AND "domainId" IS NULL AND "productId" IS NULL RETURNING id`,
    [[...names]]
  );
  return res.rows.length;
}

/** Row counts used by the leftover audit: domains, products, entities matching the given names. */
export async function countByNames(names: { domains?: string[]; entities?: string[] }): Promise<number> {
  const db = pg();
  let total = 0;
  if (names.domains?.length) {
    const r = await db.query(`SELECT count(*)::int AS n FROM domains WHERE name = ANY($1::text[])`, [names.domains]);
    total += r.rows[0].n as number;
  }
  if (names.entities?.length) {
    const r = await db.query(`SELECT count(*)::int AS n FROM entities WHERE name = ANY($1::text[])`, [names.entities]);
    total += r.rows[0].n as number;
  }
  return total;
}
