import "dotenv/config";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { publishEntity, getLatestPublishedVersion } from "@/services/entity-version.service";
import { markEntityDraftChanged } from "@/lib/entity-versioning/draft-state";
import type { ServiceContext } from "@/types/service-context";

// Runs real code, but lets a test act in the gap between phase 1 (compile, no lock) and phase 2
// (the locked transaction): it fires right after the compile returns.
const hooks = vi.hoisted(() => ({ afterCompile: null as null | (() => Promise<void>) }));
vi.mock("@/lib/entity-versioning/resolve-source", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/entity-versioning/resolve-source")>();
  return {
    ...real,
    compileRegeneratedSource: async (...args: Parameters<typeof real.compileRegeneratedSource>) => {
      const res = await real.compileRegeneratedSource(...args);
      if (hooks.afterCompile) await hooks.afterCompile();
      return res;
    },
  };
});

let prisma: PrismaClient;
let ctx: ServiceContext;
const TENANT = "tenant_default";

beforeAll(async () => {
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  const user = await prisma.user.findFirstOrThrow();
  ctx = { userId: user.id, userRole: "AUTHOR", prisma };
});
afterAll(async () => {
  hooks.afterCompile = null;
  await prisma.$disconnect();
});

async function scope() {
  const s = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const domain = await prisma.domain.create({ data: { name: `race-${s}`, slug: `race-${s}`, tenantId: TENANT } });
  const product = await prisma.product.create({ data: { domainId: domain.id, name: "P", slug: `p-${s}` } });
  const entity = await prisma.entity.create({
    data: {
      name: "Racer", slug: `racer-${s}`, tenantId: TENANT, domainId: domain.id, productId: product.id,
      ownerId: ctx.userId, typespecSource: "model Racer { id: string; }",
    },
  });
  await prisma.field.create({
    data: { entityId: entity.id, name: "id", slug: "id", type: "string", nullable: false, sortOrder: 0, decorators: {} },
  });
  await markEntityDraftChanged(prisma, entity.id); // stale: the next publish regenerates and compiles
  return { domainId: domain.id, entityId: entity.id };
}

describe("publish: compile before the lock, confirm inside it", () => {
  it("aborts with a retryable error when the entity changed after the compile, and succeeds on retry", async () => {
    let domainId: string | undefined;
    try {
      const sc = await scope();
      domainId = sc.domainId;

      // The hook writes to the entity row from another connection right after the compile. If the compile
      // still ran inside the locked transaction this write would wait on FOR UPDATE and the test would hang.
      hooks.afterCompile = async () => {
        hooks.afterCompile = null;
        await prisma.field.create({
          data: { entityId: sc.entityId, name: "note", slug: "note", type: "string", nullable: true, sortOrder: 1, decorators: {} },
        });
        await markEntityDraftChanged(prisma, sc.entityId);
      };
      const aborted = await publishEntity(sc.entityId, {}, ctx);
      expect(aborted.success).toBe(false);
      if (!aborted.success) {
        expect(aborted.error.code).toBe("CONFLICT");
        expect(aborted.error.message).toBe("Entity changed during publish, try again");
      }
      expect(await prisma.entityVersion.count({ where: { entityId: sc.entityId } })).toBe(0);

      const retried = await publishEntity(sc.entityId, {}, ctx);
      expect(retried.success).toBe(true);
      const latest = await getLatestPublishedVersion(sc.entityId, ctx);
      expect(latest.success && latest.data?.resolvedSource).toContain("note");
    } finally {
      hooks.afterCompile = null;
      if (domainId) await prisma.domain.deleteMany({ where: { id: domainId } });
    }
  });

  it("does not abort for a write the source does not render (bookkeeping metadata), unlike an updatedAt check", async () => {
    let domainId: string | undefined;
    try {
      const sc = await scope();
      domainId = sc.domainId;

      hooks.afterCompile = async () => {
        hooks.afterCompile = null;
        await prisma.entity.update({
          where: { id: sc.entityId },
          data: { metadata: { sourceStale: true, schemaVersions: { avro: [] } } },
        });
      };
      const res = await publishEntity(sc.entityId, {}, ctx);
      expect(res.success).toBe(true);
    } finally {
      hooks.afterCompile = null;
      if (domainId) await prisma.domain.deleteMany({ where: { id: domainId } });
    }
  });
});
