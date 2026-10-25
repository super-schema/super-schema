-- Access control and user management (docs/superpowers/specs/2026-10-24-access-control-design.md, decisions 6-8, 12, 13).
--
-- What it adds:
--   * users.disabledAt, users.lastLoginAt, and a UNIQUE index on lower(email) (users_email_lower_key). Existing e-mails are trimmed and
--     lower-cased first; the exact-case unique index of Prisma's `@unique` (users_email_key) stays.
--   * user_roles.scopeKey (G | T:<tenantId> | D:<domainId> | P:<productId>) and user_roles.grantedById; the unique key becomes
--     (userId, role, scopeKey) instead of the old (userId, role, tenantId, domainId, productId), whose NULL columns made two identical
--     global ADMIN rows legal. Two CHECKs: the key's shape, and the key agreeing with tenantId/domainId/productId (so the cascading
--     foreign keys still remove an assignment with its tenant/domain/product).
--   * invitations + invitation_roles, auth_tokens (+ enum AuthTokenKind), auth_events.
--   * audit_log.tenantId (closes KD-016), backfilled where the entry's target tells the tenant.
--
-- BACKFILL RULES (user_roles; the old app wrote only domainId, so most old rows have tenantId = NULL):
--   1. The FINEST scope a row names decides its key: productId set -> P:<productId>; else domainId set -> D:<domainId>; else tenantId set
--      -> T:<tenantId>; else G. (The old code ignored tenantId and productId, so a row with only a tenantId acted as a global one; it is
--      now the tenant-scoped assignment its column says. Nothing in the app ever wrote such a row.)
--   2. domainId is filled from the product's domain for product rows, and tenantId from the domain's tenant for domain and product rows,
--      always from the domain/product row itself (it decides its own tenant), so the columns and the key agree.
--   3. GLOBAL is the platform administrator's scope only (decision 3), and the policy engine ignores a global row of any other role.
--      An old "system-level" row of another role (the old rule made COMPLIANCE_OFFICER system-level) would therefore grant nothing, so
--      it is converted: one T:<tenantId> row per existing tenant (the access it gave, in every tenant that exists now), unless the user
--      already holds that role in that tenant; then the global row is removed. Global ADMIN rows are kept.
--
-- WHAT IT REFUSES (a clear message listing the rows; the whole file is one transaction, so a refusal changes nothing; it never merges or
-- deletes users or role rows for you):
--   * two users whose e-mails are the same after trimming and lower-casing;
--   * two role rows of one user with the same role that map to the same scope (the old NULL-distinct hole, or one scope written with and
--     without its tenantId).
--
-- audit_log: rows are immutable (trigger audit_log_immutable). The tenantId backfill is the one sanctioned change to existing rows: this
-- file lifts that trigger for the backfill statements and restores it before it ends; no other column of any audit row is touched.
-- audit_log.tenantId is NOT a foreign key on purpose (a tenant delete must neither fail on, nor cascade into, immutable rows).
--
-- No extension is created (md5() is core PostgreSQL; the rows of rule 3 get a deterministic id from it). Plain SQL, no BEGIN / COMMIT.
-- Rollback: rollback.sql next to this file (documented in docs/database.md; never run automatically).

-- ── 0. guards: refuse before touching anything ──────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  found text;
BEGIN
  SELECT string_agg(format(E'\n  - %s: %s', k."key", k."ids"), '' ORDER BY k."key")
    INTO found
    FROM (
      SELECT lower(btrim("email")) AS "key", string_agg(format('%s (%s)', "id", "email"), ', ' ORDER BY "id") AS "ids"
        FROM "users"
       GROUP BY lower(btrim("email"))
      HAVING count(*) > 1
    ) k;

  IF found IS NOT NULL THEN
    RAISE EXCEPTION E'Cannot enforce case-insensitive e-mail uniqueness: these e-mails are the same once trimmed and lower-cased (user id and stored e-mail):%\nResolve each group by hand (change or remove all but one account of each, keeping the one people sign in with), then re-run `npm run db:deploy` (on PostgreSQL, Prisma first needs `npx prisma migrate resolve --rolled-back 20261025230000_access_control`); this migration never merges or deletes users.', found
      USING ERRCODE = 'P0001';
  END IF;
END $$;

DO $$
DECLARE
  found text;
BEGIN
  SELECT string_agg(format(E'\n  - user %s, role %s, scope %s: rows %s', d."userId", d."role", d."scopeKey", d."ids"), '' ORDER BY d."userId", d."role", d."scopeKey")
    INTO found
    FROM (
      SELECT k."userId", k."role", k."scopeKey", string_agg(k."id", ', ' ORDER BY k."id") AS "ids"
        FROM (
          SELECT ur."id", ur."userId", ur."role",
                 CASE
                   WHEN ur."productId" IS NOT NULL THEN 'P:' || ur."productId"
                   WHEN ur."domainId" IS NOT NULL THEN 'D:' || ur."domainId"
                   WHEN ur."tenantId" IS NOT NULL THEN 'T:' || ur."tenantId"
                   ELSE 'G'
                 END AS "scopeKey"
            FROM "user_roles" ur
        ) k
       GROUP BY k."userId", k."role", k."scopeKey"
      HAVING count(*) > 1
    ) d;

  IF found IS NOT NULL THEN
    RAISE EXCEPTION E'Cannot make user_roles unique per (user, role, scope): these role rows say the same thing more than once:%\nDelete all but one row of each group (for example DELETE FROM user_roles WHERE id IN (...)), then re-run `npm run db:deploy` (on PostgreSQL, Prisma first needs `npx prisma migrate resolve --rolled-back 20261025230000_access_control`); this migration never deletes role rows.', found
      USING ERRCODE = 'P0001';
  END IF;
END $$;

-- ── 1. users ───────────────────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "users" ADD COLUMN "disabledAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "lastLoginAt" TIMESTAMP(3);

-- The guard above proved this cannot collide.
UPDATE "users" SET "email" = lower(btrim("email")) WHERE "email" <> lower(btrim("email"));

CREATE UNIQUE INDEX "users_email_lower_key" ON "users" (lower("email"));

-- ── 2. user_roles: scope key, backfill, then constrain ──────────────────────────────────────────────────────────────────
ALTER TABLE "user_roles" ADD COLUMN "scopeKey" TEXT;
ALTER TABLE "user_roles" ADD COLUMN "grantedById" TEXT;

-- (2) the parents of a product row, then of a domain row, come from the rows that own them
UPDATE "user_roles" ur
   SET "domainId" = p."domainId"
  FROM "products" p
 WHERE ur."productId" = p."id" AND ur."domainId" IS DISTINCT FROM p."domainId";

UPDATE "user_roles" ur
   SET "tenantId" = d."tenantId"
  FROM "domains" d
 WHERE ur."domainId" = d."id" AND ur."tenantId" IS DISTINCT FROM d."tenantId";

-- (1) the key from the finest scope the row names
UPDATE "user_roles"
   SET "scopeKey" = CASE
         WHEN "productId" IS NOT NULL THEN 'P:' || "productId"
         WHEN "domainId" IS NOT NULL THEN 'D:' || "domainId"
         WHEN "tenantId" IS NOT NULL THEN 'T:' || "tenantId"
         ELSE 'G'
       END;

-- (3) a global row of a role other than ADMIN becomes one tenant row per existing tenant, then goes
INSERT INTO "user_roles" ("id", "userId", "role", "scopeKey", "tenantId", "createdAt")
SELECT 'ac_' || md5(g."id" || ':' || t."id"), g."userId", g."role", 'T:' || t."id", t."id", g."createdAt"
  FROM "user_roles" g
 CROSS JOIN "tenants" t
 WHERE g."scopeKey" = 'G'
   AND g."role" <> 'ADMIN'
   AND NOT EXISTS (
     SELECT 1 FROM "user_roles" x
      WHERE x."userId" = g."userId" AND x."role" = g."role" AND x."scopeKey" = 'T:' || t."id"
   );

DELETE FROM "user_roles" WHERE "scopeKey" = 'G' AND "role" <> 'ADMIN';

ALTER TABLE "user_roles" ALTER COLUMN "scopeKey" SET NOT NULL;

-- the shape of a key: G, or a scope letter and an id with no whitespace, control character or colon (the rule of src/lib/access/scope.ts)
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_scope_key_shape_check"
  CHECK ("scopeKey" ~ '^(G|[TDP]:[^[:space:][:cntrl:]:]{1,128})$');

-- the key and the foreign-key columns say the same scope (only judged for a well-formed key, so a malformed one is reported by the check above)
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_scope_columns_check"
  CHECK (
    "scopeKey" !~ '^(G|[TDP]:[^[:space:][:cntrl:]:]{1,128})$'
    OR CASE left("scopeKey", 1)
         WHEN 'G' THEN "tenantId" IS NULL AND "domainId" IS NULL AND "productId" IS NULL
         WHEN 'T' THEN "tenantId" IS NOT DISTINCT FROM substr("scopeKey", 3) AND "domainId" IS NULL AND "productId" IS NULL
         WHEN 'D' THEN "domainId" IS NOT DISTINCT FROM substr("scopeKey", 3) AND "tenantId" IS NOT NULL AND "productId" IS NULL
         ELSE "productId" IS NOT DISTINCT FROM substr("scopeKey", 3) AND "domainId" IS NOT NULL AND "tenantId" IS NOT NULL
       END
  );

-- Deliberately NO check that a global row is an ADMIN row: the policy engine ignores any other global row (isValidAssignment), so one
-- grants nothing, and the legacy admin screen still assigns a "system-level" COMPLIANCE_OFFICER until it is reworked for scoped roles.

DROP INDEX "user_roles_userId_role_tenantId_domainId_productId_key";
CREATE UNIQUE INDEX "user_roles_userId_role_scopeKey_key" ON "user_roles"("userId", "role", "scopeKey");
CREATE INDEX "user_roles_scopeKey_idx" ON "user_roles"("scopeKey");

ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_grantedById_fkey"
  FOREIGN KEY ("grantedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 3. audit_log.tenantId ──────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "audit_log" ADD COLUMN "tenantId" TEXT;

-- The one sanctioned change to existing audit rows: lift the immutability trigger for the backfill, restore it right after.
ALTER TABLE "audit_log" DISABLE TRIGGER "audit_log_immutable";

-- The tenant of a row whose target still exists.
UPDATE "audit_log" a SET "tenantId" = e."tenantId"
  FROM "entities" e
 WHERE a."tenantId" IS NULL AND a."entityType" = 'Entity' AND a."entityId" = e."id";

UPDATE "audit_log" a SET "tenantId" = e."tenantId"
  FROM "fields" f JOIN "entities" e ON e."id" = f."entityId"
 WHERE a."tenantId" IS NULL AND a."entityType" = 'Field' AND a."entityId" = f."id";

UPDATE "audit_log" a SET "tenantId" = d."tenantId"
  FROM "domains" d
 WHERE a."tenantId" IS NULL AND a."entityType" = 'Domain' AND a."entityId" = d."id";

UPDATE "audit_log" a SET "tenantId" = d."tenantId"
  FROM "products" p JOIN "domains" d ON d."id" = p."domainId"
 WHERE a."tenantId" IS NULL AND a."entityType" = 'Product' AND a."entityId" = p."id";

UPDATE "audit_log" a SET "tenantId" = s."tenantId"
  FROM "event_specs" s
 WHERE a."tenantId" IS NULL AND a."entityType" = 'EventSpec' AND a."entityId" = s."id";

UPDATE "audit_log" a SET "tenantId" = t."tenantId"
  FROM "traits" t
 WHERE a."tenantId" IS NULL AND a."entityType" = 'Trait' AND a."entityId" = t."id";

-- An annotation is recorded against an entity or, when it is on a field, the field.
UPDATE "audit_log" a SET "tenantId" = e."tenantId"
  FROM "entities" e
 WHERE a."tenantId" IS NULL AND a."entityType" = 'Annotation' AND a."entityId" = e."id";

UPDATE "audit_log" a SET "tenantId" = e."tenantId"
  FROM "fields" f JOIN "entities" e ON e."id" = f."entityId"
 WHERE a."tenantId" IS NULL AND a."entityType" = 'Annotation' AND a."entityId" = f."id";

-- A row whose target was deleted: the entry's own recorded state names the tenant (only a tenant that exists counts).
UPDATE "audit_log" a SET "tenantId" = t."id"
  FROM "tenants" t
 WHERE a."tenantId" IS NULL
   AND a."entityType" IN ('Entity', 'Domain', 'EventSpec', 'Trait')
   AND t."id" = COALESCE(a."afterState" ->> 'tenantId', a."beforeState" ->> 'tenantId');

ALTER TABLE "audit_log" ENABLE TRIGGER "audit_log_immutable";

CREATE INDEX "audit_log_tenantId_timestamp_idx" ON "audit_log"("tenantId", "timestamp");

-- ── 4. invitations, tokens, events ─────────────────────────────────────────────────────────────────────────────────────
CREATE TYPE "AuthTokenKind" AS ENUM ('INVITE', 'RESET');

CREATE TABLE "invitations" (
    "id" TEXT NOT NULL,
    "emailLower" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "invitation_roles" (
    "invitationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,

    CONSTRAINT "invitation_roles_pkey" PRIMARY KEY ("invitationId","role","scopeKey"),
    CONSTRAINT "invitation_roles_scope_key_shape_check" CHECK ("scopeKey" ~ '^(G|[TDP]:[^[:space:][:cntrl:]:]{1,128})$')
);

CREATE TABLE "auth_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "kind" "AuthTokenKind" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "auth_events" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "emailHash" TEXT,
    "ipHash" TEXT,
    "outcome" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "invitations_tokenHash_key" ON "invitations"("tokenHash");
CREATE INDEX "invitations_emailLower_idx" ON "invitations"("emailLower");
CREATE INDEX "invitations_createdById_idx" ON "invitations"("createdById");

CREATE UNIQUE INDEX "auth_tokens_tokenHash_key" ON "auth_tokens"("tokenHash");
CREATE INDEX "auth_tokens_userId_kind_idx" ON "auth_tokens"("userId", "kind");
CREATE INDEX "auth_tokens_expiresAt_idx" ON "auth_tokens"("expiresAt");

CREATE INDEX "auth_events_emailHash_kind_createdAt_idx" ON "auth_events"("emailHash", "kind", "createdAt");
CREATE INDEX "auth_events_ipHash_kind_createdAt_idx" ON "auth_events"("ipHash", "kind", "createdAt");
CREATE INDEX "auth_events_createdAt_idx" ON "auth_events"("createdAt");

ALTER TABLE "invitations" ADD CONSTRAINT "invitations_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "invitation_roles" ADD CONSTRAINT "invitation_roles_invitationId_fkey"
  FOREIGN KEY ("invitationId") REFERENCES "invitations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
