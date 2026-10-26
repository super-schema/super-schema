import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { publishEntity } from "@/services/entity-version.service";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

export const TENANT = "tenant_default";

export function connectTestDb(): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
}

export async function testContext(prisma: PrismaClient): Promise<ServiceContext> {
  const user = await prisma.user.findFirstOrThrow();
  return { userId: user.id, userRole: "AUTHOR", assignments: [{ role: "ADMIN", scope: { kind: "GLOBAL" } }], prisma };
}

export function unwrap<T>(r: Result<T>): T {
  if (!r.success) throw new Error(`${r.error.code}: ${r.error.message} ${JSON.stringify(r.error.details ?? {})}`);
  return r.data;
}

export function stamp(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export interface TestField {
  name: string;
  type: string;
  /**
   * For reference fields: the referenced entity (also written into the TypeSpec source by name).
   * `nameOnly` stores just `referencedEntityName` — what every real creation path does — so the target must be
   * resolved against the entity's line (publish and the draft renderer both do).
   */
  ref?: { id: string; name: string; nameOnly?: boolean };
}

/** A fresh domain + product with entity helpers; names carry a unique stamp so line-unique names never collide. */
export async function createProductScope(prisma: PrismaClient, ctx: ServiceContext, label = "evt") {
  const s = stamp();
  const domain = await prisma.domain.create({ data: { name: `${label}-${s}`, slug: `${label}-${s}`, tenantId: TENANT } });
  const product = await prisma.product.create({ data: { domainId: domain.id, name: `${label} ${s}`, slug: `${label}-p-${s}` } });

  async function entity(name: string, fields: TestField[] = [{ name: "id", type: "string" }]) {
    const body = fields.map((f) => `  ${f.name}: ${f.ref ? f.ref.name : f.type};`).join("\n");
    return prisma.entity.create({
      data: {
        name, slug: `${name.toLowerCase()}-${s}`, tenantId: TENANT, domainId: domain.id, productId: product.id,
        ownerId: ctx.userId, typespecSource: `model ${name} {\n${body}\n}\n`,
        fields: {
          create: fields.map((f, i) => ({
            name: f.name, slug: f.name, type: f.ref ? "reference" : f.type, nullable: false, sortOrder: i, fieldNumber: i + 1,
            decorators: f.ref
              ? f.ref.nameOnly
                ? { referencedEntityName: f.ref.name }
                : { referencedEntityId: f.ref.id, referencedEntityName: f.ref.name }
              : {},
          })),
        },
      },
    });
  }

  async function publishedEntity(name: string, fields?: TestField[]) {
    const e = await entity(name, fields);
    const version = unwrap(await publishEntity(e.id, {}, ctx));
    return { entity: e, version };
  }

  return { s, domain, product, entity, publishedEntity };
}

type Db = PrismaClient | Prisma.TransactionClient;

let legacyVersionColumns: Promise<boolean> | undefined;

/**
 * True while the connected database still has the columns migration 20261020_drop_legacy_event_catalog drops from
 * `event_spec_versions` (`frozenChannels` is NOT NULL there, `messageVersionIds` nullable). The generated client no longer
 * knows them, so on such a database a plain `eventSpecVersion.create` would violate the NOT NULL: the tests must run before
 * the migration is applied (shared dev database) and after it (fresh database, PGlite).
 */
function hasLegacyVersionColumns(db: Db): Promise<boolean> {
  legacyVersionColumns ??= db
    .$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'event_spec_versions' AND column_name = 'frozenChannels'`
    .then((rows) => rows[0].n > 0);
  return legacyVersionColumns;
}

const asJson = (value: unknown, fallback: unknown): string => JSON.stringify(value === undefined || value === Prisma.DbNull || value === Prisma.JsonNull ? fallback : value);

/**
 * Create a published event version row, whatever the database's migration state (see `hasLegacyVersionColumns`). Takes the
 * generated client's create input, so the same call works unchanged once the legacy columns are gone.
 */
export async function createEventSpecVersion(db: Db, data: Prisma.EventSpecVersionUncheckedCreateInput) {
  if (!(await hasLegacyVersionColumns(db))) return db.eventSpecVersion.create({ data });
  const id = data.id ?? randomUUID();
  const changeSummary = data.changeSummary ?? null;
  const governanceRequestId = data.governanceRequestId ?? null;
  const resolvedSpec = data.resolvedSpec === undefined || data.resolvedSpec === Prisma.DbNull || data.resolvedSpec === Prisma.JsonNull ? null : asJson(data.resolvedSpec, null);
  await db.$executeRaw`
    INSERT INTO "event_spec_versions"
      ("id", "eventSpecId", "major", "minor", "sequence", "document", "sourceDocument", "frozenChannels", "frozenTraits", "resolvedSpec",
       "changeKind", "compatReport", "changeSummary", "publishedById", "governanceRequestId")
    VALUES
      (${id}, ${data.eventSpecId}, ${data.major}, ${data.minor}, ${data.sequence}, ${asJson(data.document, {})}::jsonb,
       ${asJson(data.sourceDocument, {})}::jsonb, '[]'::jsonb, ${asJson(data.frozenTraits, [])}::jsonb, ${resolvedSpec}::jsonb,
       ${data.changeKind}::"EntityVersionChangeKind", ${asJson(data.compatReport, {})}::jsonb, ${changeSummary}, ${data.publishedById}, ${governanceRequestId})`;
  return db.eventSpecVersion.findUniqueOrThrow({ where: { id } });
}

/** Remove edge rows (no FKs) for every record under the domains, then cascade-delete the domains (D3). Works before and after the legacy catalog tables are dropped. */
export async function cleanupDomains(prisma: PrismaClient, domainIds: Array<string | undefined>): Promise<void> {
  const ids = domainIds.filter((d): d is string => !!d);
  if (ids.length === 0) return;
  const inDomains = { domainId: { in: ids } };
  const [ev, s, sv, t] = await Promise.all([
    prisma.entityVersion.findMany({ where: { entity: inDomains }, select: { id: true } }),
    prisma.eventSpec.findMany({ where: inDomains, select: { id: true } }),
    prisma.eventSpecVersion.findMany({ where: { eventSpec: inDomains }, select: { id: true } }),
    prisma.trait.findMany({ where: inDomains, select: { id: true } }),
  ]);
  const idsOf = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
  await prisma.schemaReference.deleteMany({
    where: {
      OR: [
        { fromKind: "ENTITY_VERSION", fromId: { in: idsOf(ev) } },
        { fromKind: "EVENT_SPEC", fromId: { in: idsOf(s) } },
        { fromKind: "EVENT_SPEC_VERSION", fromId: { in: idsOf(sv) } },
        { fromKind: "TRAIT", fromId: { in: idsOf(t) } },
      ],
    },
  });
  // audit_log rows written by withAudit are immutable by design (trigger) and stay.
  await prisma.domain.deleteMany({ where: { id: { in: ids } } });
}

/**
 * A channel / message entry as a published version's `resolvedSpec` really stores it (`ResolvedChannel` / `ResolvedMessage`, reduced
 * to the fields the readers use). A hand-built fixture with fewer fields (`{ id: "M" }`) is NOT referenceable: the picker, save
 * validation and the snapshot all reject it (`isReferenceableItem`), so fixtures build their items with these.
 */
export const resolvedChannel = (id: string, extra: Record<string, unknown> = {}) => ({
  name: id, productSlug: "src", address: `${id}.v1`, protocol: "kafka", profile: { format: "avro" }, ...extra, id,
});
export const resolvedMessage = (id: string, extra: Record<string, unknown> = {}) => ({
  name: id, productSlug: "src", traitRefs: [], payloads: [{ format: "avro", schema: { type: "record", name: id, fields: [] } }], ...extra, id,
});

/** Tenant-level traits live outside any domain; tests delete the ones they create. */
export async function cleanupTenantTraits(prisma: PrismaClient, traitIds: string[]): Promise<void> {
  if (traitIds.length === 0) return;
  await prisma.schemaReference.deleteMany({ where: { fromKind: "TRAIT", fromId: { in: traitIds } } });
  await prisma.trait.deleteMany({ where: { id: { in: traitIds } } });
}
