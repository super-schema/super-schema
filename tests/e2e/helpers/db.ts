/**
 * Direct-DB fixtures for E2E specs.
 *
 * Playwright runs in Node, so specs can create and delete rows themselves against a PostgreSQL database: `E2E_DATABASE_URL` (what the
 * release runner provisions: a throwaway database, dropped at the end), else the developer's `DATABASE_URL` (the shell's, or `.env`;
 * `.env` is not even read while `E2E_DATABASE_URL` is set). It needs the PostgreSQL provider: the embedded PGlite database is
 * single-process, so a second process (this one) cannot share it with the running app.
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

import { randomBytes } from "node:crypto";
import { TEST_EMAIL } from "./auth-state";

export interface PgPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

const DEFAULT_TENANT_ID = "tenant_default";

let pool: PgPool | undefined;

type Env = Record<string, string | undefined>;

/**
 * The connection string the suite uses: `E2E_DATABASE_URL`; only when that is not set, `DATABASE_URL` (the shell's, else `.env`'s).
 * `.env` is read here and nowhere earlier, so a run with `E2E_DATABASE_URL` never loads a developer's database settings.
 */
export function e2eDatabaseUrl(env: Env = process.env): string | undefined {
  if (env.E2E_DATABASE_URL) return env.E2E_DATABASE_URL;
  if (!env.DATABASE_URL) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded on demand, see above
    (require("dotenv") as { config(options: { processEnv: Env; quiet: boolean }): void }).config({ processEnv: env, quiet: true });
  }
  return env.DATABASE_URL || undefined;
}

export function pg(): PgPool {
  if (!pool) {
    const connectionString = e2eDatabaseUrl();
    if (!connectionString) {
      throw new Error(
        "E2E fixtures need a PostgreSQL database: set E2E_DATABASE_URL (the release runner does), or DATABASE_URL in the shell or .env. The embedded PGlite database cannot be shared with the running app."
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

/** The user that owns what the fixtures create: the seeded admin (TEST_EMAIL), else the oldest user. */
export async function seededOwnerId(): Promise<string> {
  const owner = await pg().query(`SELECT id FROM users ORDER BY (email = $1) DESC, "createdAt" ASC LIMIT 1`, [TEST_EMAIL]);
  const ownerId = owner.rows[0]?.id as string | undefined;
  if (!ownerId) throw new Error("E2E fixtures need a seeded user (npm run db:seed).");
  return ownerId;
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
  const ownerId = await seededOwnerId();

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
  // Edge rows have no FKs, so an events / entity-versions run leaves them behind: remove them first.
  await deleteSchemaReferencesForDomain(fixtures.domain.id);
  // Cascades to the product and its entities/fields, and to any traits, events and their versions a spec created under it. The immutability triggers (20261015 / 20261016 *_no_delete) only refuse a
  // DIRECT delete of a published version; a delete of the owning row, or of a domain above it, is the sanctioned path.
  await db.query(`DELETE FROM domains WHERE id = $1`, [fixtures.domain.id]);
}

/**
 * `schema_references` has no FKs (polymorphic), so deleting a domain cascades to its events, event versions and
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
       SELECT id FROM event_specs WHERE "domainId" = $1
       UNION SELECT sv.id FROM event_spec_versions sv JOIN event_specs s ON s.id = sv."eventSpecId" WHERE s."domainId" = $1
       UNION SELECT ev.id FROM entity_versions ev JOIN entities e ON e.id = ev."entityId" WHERE e."domainId" = $1
       UNION SELECT id FROM traits WHERE "domainId" = $1) RETURNING id`,
    [domainId]
  );
  return res.rows.length;
}

export interface WorkspaceRows {
  tenantId: string;
  domain: { id: string; name: string; slug: string };
  product: { id: string; name: string; slug: string };
  /** One per requested name: product-level, with one key field `id`. */
  entities: Array<{ id: string; name: string; slug: string; fieldId: string }>;
}

/**
 * A domain and a product under it, uniquely named, and one product-level entity (with one key field `id`) per name in `entityNames`.
 * The rows behind the `workspace` fixture (helpers/fixtures.ts); `deleteWorkspaceRows` removes them. A name must be a plain TypeSpec
 * identifier (letters and digits): it is the entity's name, and its slug is the lowercased name.
 */
export async function createWorkspaceRows(entityNames: readonly string[] = []): Promise<WorkspaceRows> {
  const db = pg();
  const tenantId = await activeTenantId();
  const ownerId = await seededOwnerId();
  const s = suffix();
  const domain = { id: newId(), name: `e2e-ws-dom-${s}`, slug: `e2e-ws-dom-${s}` };
  const product = { id: newId(), name: `e2e-ws-prod-${s}`, slug: `e2e-ws-prod-${s}` };
  const entities = entityNames.map((name) => ({ id: newId(), name, slug: name.toLowerCase(), fieldId: newId() }));
  const rows: WorkspaceRows = { tenantId, domain, product, entities };
  try {
    await db.query(`INSERT INTO domains (id, name, slug, "tenantId", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [
      domain.id, domain.name, domain.slug, tenantId,
    ]);
    await db.query(`INSERT INTO products (id, name, slug, "domainId", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [
      product.id, product.name, product.slug, domain.id,
    ]);
    for (const entity of entities) {
      await db.query(
        `INSERT INTO entities (id, name, slug, "tenantId", "domainId", "productId", "ownerId", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
        [entity.id, entity.name, entity.slug, tenantId, domain.id, product.id, ownerId]
      );
      await db.query(
        `INSERT INTO fields (id, "entityId", name, slug, type, nullable, "isKey", "sortOrder", "updatedAt")
         VALUES ($1, $2, 'id', 'id', 'string', false, true, 0, now())`,
        [entity.fieldId, entity.id]
      );
    }
  } catch (error) {
    // Never leave a half-built workspace behind.
    await deleteWorkspaceRows(rows);
    throw error;
  }
  return rows;
}

/** Delete everything `createWorkspaceRows` made, and whatever a test created under its domain. Safe to call twice or on partial state. */
export async function deleteWorkspaceRows(rows: WorkspaceRows | undefined): Promise<void> {
  if (!rows) return;
  // Edge rows have no FKs: remove them first, then the domain (cascades to the product, its entities, events and versions).
  await deleteSchemaReferencesForDomain(rows.domain.id);
  await pg().query(`DELETE FROM domains WHERE id = $1`, [rows.domain.id]);
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

/** Delete users by exact e-mail address (their sessions, accounts and role assignments cascade). Returns rows deleted. */
export async function deleteUsersByEmail(emails: readonly string[]): Promise<number> {
  if (emails.length === 0) return 0;
  const res = await pg().query(`DELETE FROM users WHERE email = ANY($1::text[]) RETURNING id`, [[...emails]]);
  return res.rows.length;
}

/**
 * An event spec (an Events asset) in a product of a domain: a draft with an empty document, the least that counts as "the domain holds
 * an event" for the deletion guard. It goes with the domain (the cascade).
 */
export async function createEventSpecInProduct(domainId: string, productId: string): Promise<{ id: string; name: string }> {
  const db = pg();
  const domain = await db.query(`SELECT "tenantId" FROM domains WHERE id = $1`, [domainId]);
  const tenantId = domain.rows[0]?.tenantId as string | undefined;
  if (!tenantId) throw new Error(`createEventSpecInProduct: no domain ${domainId}`);
  const spec = { id: newId(), name: `e2e-event-${suffix()}` };
  await db.query(
    `INSERT INTO event_specs (id, name, document, "tenantId", "domainId", "productId", "updatedAt")
     VALUES ($1, $2, '{}'::jsonb, $3, $4, $5, now())`,
    [spec.id, spec.name, tenantId, domainId, productId]
  );
  return spec;
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

// ---------------------------------------------------------------------------
// Rows for the admin, governance, compliance, discovery and glossary specs. Each `create*` has its own `delete*`, and a spec removes
// what it made in a `finally` / `afterEach`: nothing here is shared between tests.
// ---------------------------------------------------------------------------

/** A user with no password (nobody signs in as them): the row the admin Users tab lists. Remove with `deleteUsersByEmail`. */
export async function createUserRow(input: { email: string; name?: string | null }): Promise<{ id: string; email: string }> {
  const id = newId();
  await pg().query(`INSERT INTO users (id, email, name, "updatedAt") VALUES ($1, $2, $3, now())`, [id, input.email, input.name ?? null]);
  return { id, email: input.email };
}

/**
 * A user who can sign in (`signInCaller`, helpers/api.ts): the password is stored as the app stores it (bcrypt), at cost 4 instead of the
 * app's 12, which the app's own `bcrypt.compare` accepts and which makes the test's sign-in cheap. Remove with `deleteUsersByEmail`.
 */
export async function createUserWithPassword(input: { email: string; password: string; name?: string | null }): Promise<{ id: string; email: string; password: string }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded on demand: only the specs that sign a second user in need it
  const { hashSync } = require("bcryptjs") as { hashSync(password: string, rounds: number): string };
  const id = newId();
  await pg().query(`INSERT INTO users (id, email, name, password, "updatedAt") VALUES ($1, $2, $3, $4, now())`, [id, input.email, input.name ?? null, hashSync(input.password, 4)]);
  return { id, email: input.email, password: input.password };
}

/**
 * A token as the app issues one: 32 random bytes as base64url, and only their SHA-256 stored (src/lib/auth/tokens.ts). There is no e-mail to read a link
 * from, so a spec makes the row itself and opens `/invite/<token>` or `/reset/<token>`.
 */
function newLinkToken(): { token: string; tokenHash: string } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- same reason as `createUserWithPassword`: loaded on demand
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: createHash("sha256").update(token).digest("hex") };
}

/**
 * A live invitation (7 days, or `expiresInHours`) for an address, made by `createdById`, carrying `roles` (`scopeKey` is `T:<tenantId>`, `D:<domainId>`,
 * `P:<productId>` or `G`). Returns the token to put in the link. Remove with `deleteInvitationsByEmail` (and the user it made with `deleteUsersByEmail`).
 */
export async function createInvitationRow(input: {
  email: string;
  createdById: string;
  roles?: ReadonlyArray<{ role: string; scopeKey: string }>;
  expiresInHours?: number;
}): Promise<{ id: string; token: string }> {
  const { token, tokenHash } = newLinkToken();
  const id = newId();
  await pg().query(
    `INSERT INTO invitations (id, "emailLower", "tokenHash", "expiresAt", "createdById") VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval, $5)`,
    [id, input.email.toLowerCase(), tokenHash, String(input.expiresInHours ?? 168), input.createdById],
  );
  for (const role of input.roles ?? []) {
    await pg().query(`INSERT INTO invitation_roles ("invitationId", role, "scopeKey") VALUES ($1, $2, $3)`, [id, role.role, role.scopeKey]);
  }
  return { id, token };
}

/** Delete invitations by the address they are for (their role rows cascade). */
export async function deleteInvitationsByEmail(emails: readonly string[]): Promise<number> {
  if (emails.length === 0) return 0;
  const res = await pg().query(`DELETE FROM invitations WHERE "emailLower" = ANY($1::text[]) RETURNING id`, [emails.map((email) => email.toLowerCase())]);
  return res.rows.length;
}

/** A live password-reset token (1 hour, or `expiresInHours`) for a user. Returns the token to put in the link; it goes with the user (cascade). */
export async function createResetTokenRow(userId: string, options: { expiresInHours?: number } = {}): Promise<{ id: string; token: string }> {
  const { token, tokenHash } = newLinkToken();
  const id = newId();
  await pg().query(
    `INSERT INTO auth_tokens (id, "userId", kind, "tokenHash", "expiresAt") VALUES ($1, $2, 'RESET'::"AuthTokenKind", $3, now() + ($4 || ' hours')::interval)`,
    [id, userId, tokenHash, String(options.expiresInHours ?? 1)],
  );
  return { id, token };
}

/**
 * A role for a user, as the app stores it (`scopeKey` and the id columns agree): at the tenant's scope, or at one domain's (`domainId`). Goes with the user
 * (cascade). A global administrator is the seeded admin; a spec that needs a user with a LOWER role gives it here.
 */
export async function grantRoleRow(userId: string, role: string, scope: { tenantId: string; domainId?: string }): Promise<void> {
  const scopeKey = scope.domainId ? `D:${scope.domainId}` : `T:${scope.tenantId}`;
  await pg().query(
    `INSERT INTO user_roles (id, "userId", role, "scopeKey", "tenantId", "domainId") VALUES ($1, $2, $3, $4, $5, $6)`,
    [newId(), userId, role, scopeKey, scope.tenantId, scope.domainId ?? null],
  );
}

/** The role rows (`user_roles`) of a user: [{ role, domainId }]. */
export async function rolesOfUser(userId: string): Promise<Array<{ role: string; domainId: string | null }>> {
  const { rows } = await pg().query(`SELECT role, "domainId" FROM user_roles WHERE "userId" = $1 ORDER BY role`, [userId]);
  return rows.map((row) => ({ role: row.role as string, domainId: (row.domainId as string | null) ?? null }));
}

export interface NotificationSeed {
  type?: "APPROVAL_REQUEST" | "APPROVAL_DECISION" | "CHANGE_COMPLETE" | "DRIFT_ALERT" | "ANNOTATION_TAG" | "ANNOTATION_REPLY" | "COMPLIANCE_GAP";
  title: string;
  body?: string;
  read?: boolean;
  /** The route slugs of the entity it is about, as the app's own notification rows carry them (a JSON string in `entityId`). */
  entityRef?: { entityId: string; entitySlug: string; domainSlug: string | null; productSlug: string | null };
  /** Minutes ago; the newest row is listed first, so a spec that checks a page boundary gives each row its own minute. */
  minutesAgo?: number;
}

/** Notifications of one user (rows of `notifications`). They go with the user (cascade) or with `deleteNotificationsByUser`. */
export async function createNotifications(userId: string, seeds: readonly NotificationSeed[]): Promise<string[]> {
  const ids: string[] = [];
  for (const seed of seeds) {
    const id = newId();
    ids.push(id);
    await pg().query(
      `INSERT INTO notifications (id, "userId", type, title, body, "entityId", read, "createdAt")
       VALUES ($1, $2, $3::"NotificationType", $4, $5, $6, $7, now() - ($8 || ' minutes')::interval)`,
      [id, userId, seed.type ?? "CHANGE_COMPLETE", seed.title, seed.body ?? "", seed.entityRef ? JSON.stringify(seed.entityRef) : null, seed.read ?? false, String(seed.minutesAgo ?? 0)],
    );
  }
  return ids;
}

export async function deleteNotificationsByUser(userId: string): Promise<void> {
  await pg().query(`DELETE FROM notifications WHERE "userId" = $1`, [userId]);
}

/** The read flags of a user's notifications, by title. */
export async function notificationReadFlags(userId: string): Promise<Record<string, boolean>> {
  const { rows } = await pg().query(`SELECT title, read FROM notifications WHERE "userId" = $1`, [userId]);
  return Object.fromEntries(rows.map((row) => [row.title as string, row.read as boolean]));
}

/** The id of a user by e-mail. */
export async function userIdByEmail(email: string): Promise<string> {
  const { rows } = await pg().query(`SELECT id FROM users WHERE email = $1`, [email]);
  const id = rows[0]?.id as string | undefined;
  if (!id) throw new Error(`no user ${email}`);
  return id;
}

/**
 * A governance request as the app writes it (`governance.service.createRequest`: no page or action of the product creates one yet, so
 * the specs write the row). `entityName` is what the dashboard shows; make it unique. Remove with `deleteGovernanceRequestsByEntity`.
 */
export async function createGovernanceRequest(input: {
  /** The entity the request is about: the dashboard lists the requests of the entities of the tenant being viewed. */
  entityId: string;
  entityName: string;
  status?: "PENDING" | "APPROVED" | "REJECTED" | "AUTO_APPROVED";
  changeType?: string;
  severity?: string;
  summary?: string;
  requestedBy?: string;
  versionId?: string;
}): Promise<{ id: string }> {
  const id = newId();
  const severity = input.severity ?? "high";
  // Every part of an ImpactReport (src/types/schemas/governance.ts): the detail panel draws all of them.
  const impactReport = {
    summary: input.summary ?? `${input.entityName} drops a required field`,
    changeClassification: { changeType: input.changeType ?? "breaking", severity, reasons: ["Removed required field"], perTarget: [] },
    perTarget: [
      { target: "bigquery", compatible: false, migrationRequired: true, migrationComplexity: "moderate", details: "column dropped" },
      { target: "avro", compatible: true, migrationRequired: false, migrationComplexity: "trivial", details: "field optional in the schema" },
    ],
    affectedConsumers: [{ entityName: `${input.entityName}Consumer`, fieldName: "ref_id", relationship: "reference", ownerEmail: "owner@example.com" }],
    migrationArtifactsSummary: { bigquery: "ALTER TABLE DROP COLUMN", avro: "new schema version", openapi: "no change" },
  };
  await pg().query(
    `INSERT INTO governance_requests (id, "entityId", "entityName", "versionId", "changeType", severity, status, "impactReport", "requestedBy", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7::"GovernanceStatus", $8::jsonb, $9, now())`,
    [id, input.entityId, input.entityName, input.versionId ?? "3", input.changeType ?? "breaking", severity, input.status ?? "PENDING", JSON.stringify(impactReport), input.requestedBy ?? "e2e-requester"],
  );
  return { id };
}

export async function deleteGovernanceRequestsByEntity(entityNames: readonly string[]): Promise<void> {
  if (entityNames.length === 0) return;
  // The approvals go with their request (cascade).
  await pg().query(`DELETE FROM governance_requests WHERE "entityName" = ANY($1::text[])`, [[...entityNames]]);
}

/** The status of a governance request and the decisions recorded for it. */
export async function governanceOutcome(requestId: string): Promise<{ status: string; decisions: Array<{ decision: string; comment: string | null }> }> {
  const request = await pg().query(`SELECT status FROM governance_requests WHERE id = $1`, [requestId]);
  const decisions = await pg().query(`SELECT decision, comment FROM governance_approvals WHERE "requestId" = $1 ORDER BY "decidedAt"`, [requestId]);
  return {
    status: request.rows[0]?.status as string,
    decisions: decisions.rows.map((row) => ({ decision: row.decision as string, comment: (row.comment as string | null) ?? null })),
  };
}

/** A second tenant with a domain in it: what the tenant switcher switches to. Remove with `deleteTenantWithDomain`. */
export async function createSecondTenant(): Promise<{ tenantId: string; tenantName: string; domainId: string; domainName: string }> {
  const s = suffix();
  const ids = { tenantId: newId(), domainId: newId() };
  const tenantName = `e2e-tenant-${s}`;
  const domainName = `e2e-tenant-dom-${s}`;
  const db = pg();
  try {
    await db.query(`INSERT INTO tenants (id, name, slug, "isActive", "updatedAt") VALUES ($1, $2, $3, true, now())`, [ids.tenantId, tenantName, tenantName]);
    await db.query(`INSERT INTO domains (id, name, slug, "tenantId", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [ids.domainId, domainName, domainName, ids.tenantId]);
  } catch (error) {
    await deleteTenantWithDomain({ tenantId: ids.tenantId });
    throw error;
  }
  return { ...ids, tenantName, domainName };
}

/** The tenant row goes with its domains (cascade). Safe to call twice. */
export async function deleteTenantWithDomain(tenant: { tenantId: string } | undefined): Promise<void> {
  if (!tenant) return;
  await pg().query(`DELETE FROM tenants WHERE id = $1`, [tenant.tenantId]);
}

/** Another field on an entity, with the classification and policy the compliance pages read. Goes with the entity. */
export async function createFieldRow(
  entityId: string,
  input: {
    name: string;
    type?: string;
    classification?: string | null;
    policy?: { retention?: string; anonymization?: string; encryption?: string };
    /** More decorators, as the app stores them (a reference field: `{ referencedEntityId, referencedEntityName }`). */
    decorators?: Record<string, unknown>;
    sortOrder?: number;
  },
): Promise<{ id: string }> {
  const id = newId();
  const decorators = { ...(input.policy ? { policy: input.policy } : {}), ...(input.decorators ?? {}) };
  await pg().query(
    `INSERT INTO fields (id, "entityId", name, slug, type, nullable, "isKey", "sortOrder", classification, decorators, "updatedAt")
     VALUES ($1, $2, $3, $4, $5, true, false, $6, $7, $8::jsonb, now())`,
    [id, entityId, input.name, input.name.toLowerCase(), input.type ?? "string", input.sortOrder ?? 1, input.classification ?? null, JSON.stringify(decorators)],
  );
  return { id };
}

/** A reference from `fromEntityId` to `toEntity`, as a reference field the app would have written (what the lineage graph draws). */
export async function createReferenceFieldRow(fromEntityId: string, toEntity: { id: string; name: string }, name = "target_ref"): Promise<{ id: string }> {
  return createFieldRow(fromEntityId, { name, type: "reference", sortOrder: 5, decorators: { referencedEntityId: toEntity.id, referencedEntityName: toEntity.name } });
}

/** A glossary concept removed by its (unique) name; its links go with it (cascade). */
export async function deleteConceptsByName(names: readonly string[]): Promise<void> {
  if (names.length === 0) return;
  await pg().query(`DELETE FROM business_concepts WHERE name = ANY($1::text[])`, [[...names]]);
}

/** Link a field to a concept (what the glossary's `linkFieldToConcept` writes). Goes with the field or the concept. */
export async function linkFieldToConceptRow(fieldId: string, conceptName: string): Promise<void> {
  const concept = await pg().query(`SELECT id FROM business_concepts WHERE name = $1`, [conceptName]);
  const conceptId = concept.rows[0]?.id as string | undefined;
  if (!conceptId) throw new Error(`no concept ${conceptName}`);
  await pg().query(`INSERT INTO field_concept_links (id, "fieldId", "conceptId", confidence, "linkedBy") VALUES ($1, $2, $3, 0.9, 'e2e')`, [newId(), fieldId, conceptId]);
}

/** The id of the key field (`id`) the fixtures give every entity. */
export async function keyFieldId(entityId: string): Promise<string> {
  const { rows } = await pg().query(`SELECT id FROM fields WHERE "entityId" = $1 AND name = 'id'`, [entityId]);
  return rows[0].id as string;
}

/** A tenant-level entity (no domain, no product) in ANOTHER tenant, with one field. Goes with the tenant (cascade). */
export async function createEntityInTenant(tenantId: string, name: string): Promise<{ id: string; fieldId: string }> {
  const ids = { id: newId(), fieldId: newId() };
  const ownerId = await seededOwnerId();
  await pg().query(
    `INSERT INTO entities (id, name, slug, "tenantId", "domainId", "productId", "ownerId", "updatedAt") VALUES ($1, $2, $3, $4, NULL, NULL, $5, now())`,
    [ids.id, name, name.toLowerCase(), tenantId, ownerId],
  );
  await pg().query(
    `INSERT INTO fields (id, "entityId", name, slug, type, nullable, "isKey", "sortOrder", "updatedAt") VALUES ($1, $2, 'id', 'id', 'string', false, true, 0, now())`,
    [ids.fieldId, ids.id],
  );
  return ids;
}

/** Set (or clear) the classification and policy decorators of a field, as the field editor stores them. */
export async function setFieldGovernance(
  fieldId: string,
  governance: { classification?: string | null; policy?: { retention?: string; anonymization?: string; encryption?: string } },
): Promise<void> {
  await pg().query(`UPDATE fields SET classification = $2, decorators = $3::jsonb WHERE id = $1`, [
    fieldId,
    governance.classification ?? null,
    JSON.stringify(governance.policy ? { policy: governance.policy } : {}),
  ]);
}

// ---------------------------------------------------------------------------
// A tenant of the test's own (a11y.spec.ts): what a scan of a page sees is then this test's data and not whatever the other specs of a run
// have made in the default tenant at that moment (the explorer, the domain grid, the compliance results and the governance dashboard are
// scoped to the viewed tenant, which the `active_tenant` cookie names).
// ---------------------------------------------------------------------------

export interface IsolatedWorkspaceRows {
  tenantId: string;
  domain: { id: string; name: string; slug: string };
  product: { id: string; name: string; slug: string };
  entity: { id: string; name: string; slug: string };
}

/** A tenant with a domain, a product and one entity, "Customer", with a key field `id`; uniquely named. Remove with `deleteIsolatedWorkspaceRows`. */
export async function createIsolatedWorkspaceRows(): Promise<IsolatedWorkspaceRows> {
  const db = pg();
  const ownerId = await seededOwnerId();
  const s = suffix();
  const rows: IsolatedWorkspaceRows = {
    tenantId: newId(),
    domain: { id: newId(), name: `e2e-iso-dom-${s}`, slug: `e2e-iso-dom-${s}` },
    product: { id: newId(), name: `e2e-iso-prod-${s}`, slug: `e2e-iso-prod-${s}` },
    entity: { id: newId(), name: "Customer", slug: "customer" },
  };
  try {
    await db.query(`INSERT INTO tenants (id, name, slug, "isActive", "updatedAt") VALUES ($1, $2, $2, true, now())`, [rows.tenantId, `e2e-iso-tenant-${s}`]);
    await db.query(`INSERT INTO domains (id, name, slug, "tenantId", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [rows.domain.id, rows.domain.name, rows.domain.slug, rows.tenantId]);
    await db.query(`INSERT INTO products (id, name, slug, "domainId", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [rows.product.id, rows.product.name, rows.product.slug, rows.domain.id]);
    await db.query(
      `INSERT INTO entities (id, name, slug, "tenantId", "domainId", "productId", "ownerId", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
      [rows.entity.id, rows.entity.name, rows.entity.slug, rows.tenantId, rows.domain.id, rows.product.id, ownerId],
    );
    await db.query(`INSERT INTO fields (id, "entityId", name, slug, type, nullable, "isKey", "sortOrder", "updatedAt") VALUES ($1, $2, 'id', 'id', 'string', false, true, 0, now())`, [newId(), rows.entity.id]);
  } catch (error) {
    await deleteIsolatedWorkspaceRows(rows);
    throw error;
  }
  return rows;
}

/** The tenant goes with its domains, products, entities and events (cascade); the edge rows that have no foreign key go first. Safe to call twice. */
export async function deleteIsolatedWorkspaceRows(rows: IsolatedWorkspaceRows | undefined): Promise<void> {
  if (!rows) return;
  await deleteSchemaReferencesForDomain(rows.domain.id);
  await pg().query(`DELETE FROM tenants WHERE id = $1`, [rows.tenantId]);
}

// ---------------------------------------------------------------------------
// Rows for the screenshot spec (visual.spec.ts): a tenant of its own with fixed names, so a page lists the same things in every run.
// ---------------------------------------------------------------------------

export interface VisualFixtures {
  tenantId: string;
  /** Fixed: "Billing" (with the products Invoicing and Payments) and "Customers" (with Profiles). */
  domains: { billing: { id: string; slug: string }; customers: { id: string; slug: string } };
  /** Payments has no entity: the empty product. */
  products: { invoicing: { id: string; slug: string }; payments: { id: string; slug: string }; profiles: { id: string; slug: string } };
  /** Customer, in Invoicing, with six fields. */
  entity: { id: string; slug: string; url: string };
}

/**
 * A tenant, "Visual Fixtures", with the domains, products and one entity named in `VisualFixtures`: what a screenshot of the domain grid,
 * an empty product and an entity page shows is then the same in every run (the names are fixed; only the ids, which a page does not show,
 * and the timestamps, which the spec masks, are not). The viewed tenant is chosen by the `active_tenant` cookie the spec sets.
 * The tenant's name is unique: one set at a time, so the spec that uses it runs its tests in order, in one worker.
 * Remove with `deleteVisualFixtures`.
 */
export async function createVisualFixtures(): Promise<VisualFixtures> {
  const db = pg();
  const ownerId = await seededOwnerId();
  // A set left by a run that did not clean up (a database that is not throwaway) goes first.
  await db.query(`DELETE FROM tenants WHERE slug = 'visual-fixtures'`);
  const tenantId = newId();
  const domain = (slug: string) => ({ id: newId(), slug });
  const rows: VisualFixtures = {
    tenantId,
    domains: { billing: domain("billing"), customers: domain("customers") },
    products: { invoicing: domain("invoicing"), payments: domain("payments"), profiles: domain("profiles") },
    entity: { id: newId(), slug: "customer", url: "/schemas/billing/invoicing/customer" },
  };
  try {
    await db.query(`INSERT INTO tenants (id, name, slug, description, "isActive", "updatedAt") VALUES ($1, 'Visual Fixtures', 'visual-fixtures', 'Fixed data for the screenshot tests', true, now())`, [tenantId]);
    for (const [slug, name, description] of [["billing", "Billing", "Invoices and payments"], ["customers", "Customers", "Who buys"]] as const) {
      const row = slug === "billing" ? rows.domains.billing : rows.domains.customers;
      await db.query(`INSERT INTO domains (id, name, slug, description, "tenantId", "updatedAt") VALUES ($1, $2, $3, $4, $5, now())`, [row.id, name, slug, description, tenantId]);
    }
    for (const [slug, name, domainId] of [
      ["invoicing", "Invoicing", rows.domains.billing.id],
      ["payments", "Payments", rows.domains.billing.id],
      ["profiles", "Profiles", rows.domains.customers.id],
    ] as const) {
      await db.query(`INSERT INTO products (id, name, slug, "domainId", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [rows.products[slug].id, name, slug, domainId]);
    }
    await db.query(
      `INSERT INTO entities (id, name, slug, "tenantId", "domainId", "productId", "ownerId", description, "updatedAt") VALUES ($1, 'Customer', 'customer', $2, $3, $4, $5, 'Somebody who buys from us', now())`,
      [rows.entity.id, tenantId, rows.domains.billing.id, rows.products.invoicing.id, ownerId],
    );
    await db.query(`INSERT INTO fields (id, "entityId", name, slug, type, nullable, "isKey", "sortOrder", "updatedAt") VALUES ($1, $2, 'id', 'id', 'string', false, true, 0, now())`, [newId(), rows.entity.id]);
    await createFieldRow(rows.entity.id, { name: "name", type: "string", sortOrder: 1 });
    await createFieldRow(rows.entity.id, { name: "email", type: "string", classification: "PII", sortOrder: 2 });
    await createFieldRow(rows.entity.id, { name: "age", type: "integer", sortOrder: 3 });
    await createFieldRow(rows.entity.id, { name: "active", type: "boolean", sortOrder: 4 });
    await createFieldRow(rows.entity.id, { name: "balance", type: "decimal", sortOrder: 5 });
  } catch (error) {
    await deleteVisualFixtures(rows);
    throw error;
  }
  return rows;
}

/** Remove the tenant and everything of `createVisualFixtures` under it. Safe to call twice. */
export async function deleteVisualFixtures(rows: VisualFixtures | undefined): Promise<void> {
  if (!rows) return;
  const db = pg();
  await db.query(`DELETE FROM schema_references WHERE "fromId" IN (SELECT ev.id FROM entity_versions ev WHERE ev."entityId" = $1)`, [rows.entity.id]);
  await db.query(`DELETE FROM tenants WHERE id = $1`, [rows.tenantId]);
}

// ---------------------------------------------------------------------------
// Rows for the REST API spec (api-v1.spec.ts): entities in a second product, webhook endpoints and their deliveries.
// ---------------------------------------------------------------------------

/**
 * An entity (one key field `id`) in a given product of a domain: `createWorkspaceRows` only puts its entities in its own product, and the
 * ambiguity of a bare-name reference needs the same name in two. `name` is a plain identifier; it goes with the domain.
 */
export async function createEntityInProduct(domainId: string, productId: string, name: string): Promise<{ id: string; name: string; slug: string; fieldId: string }> {
  const tenantId = await activeTenantId();
  const ownerId = await seededOwnerId();
  const row = { id: newId(), name, slug: name.toLowerCase(), fieldId: newId() };
  await pg().query(
    `INSERT INTO entities (id, name, slug, "tenantId", "domainId", "productId", "ownerId", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
    [row.id, row.name, row.slug, tenantId, domainId, productId, ownerId],
  );
  await pg().query(
    `INSERT INTO fields (id, "entityId", name, slug, type, nullable, "isKey", "sortOrder", "updatedAt") VALUES ($1, $2, 'id', 'id', 'string', false, true, 0, now())`,
    [row.fieldId, row.id],
  );
  return row;
}

export interface SiblingDomainRows {
  domain: { id: string; name: string; slug: string };
  product: { id: string; name: string; slug: string };
  entity: { id: string; name: string; slug: string; url: string };
}

/**
 * A second domain in a given tenant (the sibling of an isolated workspace's domain), with a product and one entity, "Invoice", with a key field `id`;
 * uniquely named. It goes with the tenant (`deleteIsolatedWorkspaceRows` deletes the tenant, which cascades): the spec that needs a domain a
 * domain-scoped user must NOT see makes it here.
 */
export async function createSiblingDomainRows(tenantId: string): Promise<SiblingDomainRows> {
  const ownerId = await seededOwnerId();
  const s = suffix();
  const domain = { id: newId(), name: `e2e-sib-dom-${s}`, slug: `e2e-sib-dom-${s}` };
  const product = { id: newId(), name: `e2e-sib-prod-${s}`, slug: `e2e-sib-prod-${s}` };
  const entity = { id: newId(), name: "Invoice", slug: "invoice", url: `/schemas/${domain.slug}/${product.slug}/invoice` };
  await pg().query(`INSERT INTO domains (id, name, slug, "tenantId", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [domain.id, domain.name, domain.slug, tenantId]);
  await pg().query(`INSERT INTO products (id, name, slug, "domainId", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [product.id, product.name, product.slug, domain.id]);
  await pg().query(
    `INSERT INTO entities (id, name, slug, "tenantId", "domainId", "productId", "ownerId", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
    [entity.id, entity.name, entity.slug, tenantId, domain.id, product.id, ownerId],
  );
  await pg().query(`INSERT INTO fields (id, "entityId", name, slug, type, nullable, "isKey", "sortOrder", "updatedAt") VALUES ($1, $2, 'id', 'id', 'string', false, true, 0, now())`, [newId(), entity.id]);
  return { domain, product, entity };
}

/** The name of a tenant (what a scope picker lists it as). */
export async function tenantName(tenantId: string): Promise<string> {
  const { rows } = await pg().query(`SELECT name FROM tenants WHERE id = $1`, [tenantId]);
  const name = rows[0]?.name as string | undefined;
  if (!name) throw new Error(`no tenant ${tenantId}`);
  return name;
}

/**
 * A role for a user at ANY scope, as the app stores it (`scopeKey` and the id columns agree): `{ tenantId }` is the tenant's, `+ domainId` a domain's,
 * `+ productId` a product's. `grantRoleRow` is the tenant or domain case of this.
 */
export async function grantScopedRoleRow(userId: string, role: string, scope: { tenantId: string; domainId?: string; productId?: string }): Promise<void> {
  const scopeKey = scope.productId ? `P:${scope.productId}` : scope.domainId ? `D:${scope.domainId}` : `T:${scope.tenantId}`;
  await pg().query(
    `INSERT INTO user_roles (id, "userId", role, "scopeKey", "tenantId", "domainId", "productId") VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [newId(), userId, role, scopeKey, scope.tenantId, scope.domainId ?? null, scope.productId ?? null],
  );
}

/** The role rows of a user as `{ role, scopeKey }`, ordered by scope key then role. */
export async function roleRowsOfUser(userId: string): Promise<Array<{ role: string; scopeKey: string }>> {
  const { rows } = await pg().query(`SELECT role, "scopeKey" FROM user_roles WHERE "userId" = $1 ORDER BY "scopeKey", role`, [userId]);
  return rows.map((row) => ({ role: row.role as string, scopeKey: row.scopeKey as string }));
}

/** The account state of a user: `{ disabled, lastLoginAt }` (null when there is no such user). */
export async function accountOf(email: string): Promise<{ id: string; disabled: boolean; lastLoginAt: Date | null; name: string | null } | null> {
  const { rows } = await pg().query(`SELECT id, "disabledAt", "lastLoginAt", name FROM users WHERE email = $1`, [email]);
  const row = rows[0];
  return row ? { id: row.id as string, disabled: row.disabledAt !== null, lastLoginAt: (row.lastLoginAt as Date | null) ?? null, name: (row.name as string | null) ?? null } : null;
}

/** Replace the decorators of a field (a reference field: `{ referencedEntityName }`, or the qualified form with `referencedEntityId`). */
export async function setFieldDecorators(fieldId: string, decorators: Record<string, unknown>): Promise<void> {
  await pg().query(`UPDATE fields SET decorators = $2::jsonb WHERE id = $1`, [fieldId, JSON.stringify(decorators)]);
}

export interface WebhookRow {
  id: string;
  url: string;
  events: string[];
  secret: string;
}

/**
 * A webhook endpoint row, created by the seeded admin. The API cannot make one (KD-024), so the specs that read, change and delete
 * endpoints write it. Remove with `deleteWebhookRows` (its deliveries go with it).
 */
export async function createWebhookRow(input: { url?: string; events?: string[]; active?: boolean } = {}): Promise<WebhookRow> {
  const row: WebhookRow = {
    id: newId(),
    url: input.url ?? `https://e2e-hook-${suffix()}.example.invalid/hook`,
    events: input.events ?? ["emission.completed"],
    secret: randomBytes(32).toString("hex"),
  };
  await pg().query(
    `INSERT INTO webhook_endpoints (id, url, events, secret, active, "createdBy", "updatedAt") VALUES ($1, $2, $3::text[], $4, $5, $6, now())`,
    [row.id, row.url, row.events, row.secret, input.active ?? true, await seededOwnerId()],
  );
  return row;
}

/** `count` delivery rows of an endpoint, each older than the one before (the first is 1 minute old): the API lists them newest first. */
export async function createWebhookDeliveryRows(endpointId: string, count: number): Promise<Array<{ id: string; event: string; statusCode: number | null }>> {
  const rows: Array<{ id: string; event: string; statusCode: number | null }> = [];
  for (let i = 0; i < count; i += 1) {
    const failed = i % 2 === 1;
    const row = { id: newId(), event: "emission.completed", statusCode: failed ? 500 : 200 };
    await pg().query(
      `INSERT INTO webhook_deliveries (id, "endpointId", event, payload, "statusCode", error, attempt, "deliveredAt")
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, now() - ($8 || ' minutes')::interval)`,
      [row.id, endpointId, row.event, JSON.stringify({ event: row.event, timestamp: "2026-01-01T00:00:00.000Z", data: { n: i } }), row.statusCode, failed ? "HTTP 500: Internal Server Error" : null, failed ? 2 : 1, String(i + 1)],
    );
    rows.push(row);
  }
  return rows;
}

/** Delete webhook endpoints by id (their deliveries cascade). Safe to call twice. */
export async function deleteWebhookRows(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await pg().query(`DELETE FROM webhook_endpoints WHERE id = ANY($1::text[])`, [[...ids]]);
}

/** Whether the endpoint row, and how many of its delivery rows, are still in the database. */
export async function webhookRowState(id: string): Promise<{ endpoint: boolean; deliveries: number }> {
  const endpoint = await pg().query(`SELECT 1 FROM webhook_endpoints WHERE id = $1`, [id]);
  const deliveries = await pg().query(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE "endpointId" = $1`, [id]);
  return { endpoint: endpoint.rows.length > 0, deliveries: deliveries.rows[0].n as number };
}

/** The webhook endpoint row as the database has it (what a test compares an API answer to), or undefined. */
export async function webhookRow(id: string): Promise<{ url: string; events: string[]; secret: string; active: boolean; createdBy: string | null } | undefined> {
  const { rows } = await pg().query(`SELECT url, events, secret, active, "createdBy" FROM webhook_endpoints WHERE id = $1`, [id]);
  return rows[0] as { url: string; events: string[]; secret: string; active: boolean; createdBy: string | null } | undefined;
}
