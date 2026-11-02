import "dotenv/config"; // first: @/lib/db (pulled in by the renderer's imports) reads DB_PROVIDER at import time
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { markEntityDraftChanged } from "@/lib/entity-versioning/draft-state";
import { loadProgram } from "@/services/events/artifact-renderer";
import { cleanupDomains, connectTestDb, createProductScope, TENANT, testContext } from "./helpers";

/**
 * Final review B-I4: a draft render (`loadProgram` with a draft subject, behind the draft preview and `?version=draft`) used the
 * stored `typespecSource` as-is even when `metadata.sourceStale` said the field rows had moved on; publish regenerates.
 */
let prisma: PrismaClient;
let domainId: string | undefined;
beforeAll(async () => {
  prisma = connectTestDb();
});
afterAll(async () => {
  await cleanupDomains(prisma, [domainId]);
  await prisma.$disconnect();
});

describe("draft artifact source (B-I4)", { concurrent: false }, () => {
  it("renders the NEW field of a stale-flagged entity, the stored source of a fresh one, and follows later edits (drafts are never cached)", async () => {
    const ctx = await testContext(prisma);
    const sc = await createProductScope(prisma, ctx, "stale");
    domainId = sc.domain.id;
    // typespecSource says `id: string`; the field rows are then replaced by `code`, flagged exactly as every non-Source-tab edit does.
    const order = await sc.entity("Order", [{ name: "id", type: "string" }]);
    const subject = { kind: "draft" as const, entityId: order.id, tenantId: TENANT };
    const sourceOf = async () => {
      const program = await loadProgram(prisma, subject);
      if (!program.success) throw new Error(`${program.error.code}: ${program.error.message}`);
      return program.data.root;
    };

    const fresh = await sourceOf();
    expect(fresh.source).toMatch(/\bid: string;/);

    await prisma.field.deleteMany({ where: { entityId: order.id } });
    await prisma.field.create({ data: { entityId: order.id, name: "code", slug: "code", type: "string", nullable: false, sortOrder: 0, fieldNumber: 1, decorators: {} } });
    await markEntityDraftChanged(prisma, order.id);
    expect((await prisma.entity.findUniqueOrThrow({ where: { id: order.id } })).metadata).toMatchObject({ sourceStale: true });

    const stale = await sourceOf();
    expect(stale.source).toMatch(/\bcode: string;/);
    expect(stale.source).not.toMatch(/\bid: string;/);
    expect(stale.rootModel).toBe("Order");
    expect(stale.fields).toEqual([{ name: "code", fieldNumber: 1 }]);

    // The stored source itself is untouched (rendering never writes), and clearing the flag brings it back as the canonical text.
    expect((await prisma.entity.findUniqueOrThrow({ where: { id: order.id } })).typespecSource).toMatch(/\bid: string;/);
    await prisma.$executeRawUnsafe(`UPDATE "entities" SET "metadata" = "metadata" - 'sourceStale' WHERE "id" = $1`, order.id);
    expect((await sourceOf()).source).toMatch(/\bid: string;/);
  }, 60_000);
});
