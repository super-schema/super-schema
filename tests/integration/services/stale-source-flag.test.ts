import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { flagStaleTypeSpecSources } from "@/services/stale-source-flag.service";
import type { Result } from "@/types/result";

let prisma: PrismaClient;
let ownerId: string;
const TENANT = "tenant_default";

beforeAll(async () => {
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  ownerId = (await prisma.user.findFirstOrThrow()).id;
});
afterAll(async () => prisma.$disconnect());

function unwrap<T>(r: Result<T>): T {
  if (!r.success) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data;
}

describe("flagStaleTypeSpecSources", () => {
  it("flags only entities whose stored source disagrees with the field rows; dry run writes nothing; idempotent", async () => {
    const s = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const domain = await prisma.domain.create({ data: { name: `ss-${s}`, slug: `ss-${s}`, tenantId: TENANT } });
    try {
      const product = await prisma.product.create({ data: { domainId: domain.id, name: "P", slug: `p-${s}` } });
      const entity = (name: string, fields: Array<[string, string]>, metadata: object = {}) =>
        prisma.entity.create({
          data: {
            name, slug: `${name.toLowerCase()}-${s}`, tenantId: TENANT, domainId: domain.id, productId: product.id, ownerId,
            typespecSource: `model ${name} {\n  id: string;\n}\n`, metadata,
            fields: { create: fields.map(([n, type], i) => ({ name: n, slug: n, type, sortOrder: i, decorators: {} })) },
          },
        });
      const fresh = await entity("Fresh", [["id", "string"]]);
      const drifted = await entity("Drifted", [["id", "string"], ["email", "string"]]);
      const marked = await entity("Marked", [["id", "int64"]], { sourceStale: true, owner: "x" });
      const ids = [fresh.id, drifted.id, marked.id];
      const metaOf = async (id: string) => (await prisma.entity.findUniqueOrThrow({ where: { id } })).metadata;

      const dry = unwrap(await flagStaleTypeSpecSources(prisma, { dryRun: true, entityIds: ids }));
      expect(dry).toMatchObject({ checked: 3, consistent: 1, flagged: 1, alreadyStale: 1, changed: 0, errored: 0 });
      expect(dry.outcomes.find((o) => o.entityId === drifted.id)).toMatchObject({
        status: "WOULD_FLAG", reasons: ['field "email" missing from source'],
      });
      expect(await metaOf(drifted.id)).toEqual({});

      const real = unwrap(await flagStaleTypeSpecSources(prisma, { dryRun: false, entityIds: ids }));
      expect(real).toMatchObject({ consistent: 1, flagged: 1, alreadyStale: 1 });
      expect(real.outcomes.find((o) => o.entityId === drifted.id)?.status).toBe("FLAGGED");
      expect(await metaOf(drifted.id)).toEqual({ sourceStale: true });
      expect(await metaOf(fresh.id)).toEqual({});
      expect(await metaOf(marked.id)).toEqual({ sourceStale: true, owner: "x" });
      // Draft flags are untouched: only the source is marked stale.
      expect((await prisma.entity.findUniqueOrThrow({ where: { id: drifted.id } })).hasUnpublishedChanges).toBe(drifted.hasUnpublishedChanges);

      const again = unwrap(await flagStaleTypeSpecSources(prisma, { dryRun: false, entityIds: ids }));
      expect(again).toMatchObject({ consistent: 1, flagged: 0, alreadyStale: 2 });
    } finally {
      await prisma.domain.deleteMany({ where: { id: domain.id } });
    }
  });
});
