import "dotenv/config"; // first: @/lib/db reads DB_PROVIDER when first evaluated
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { cleanupDomains, connectTestDb, createProductScope, TENANT, testContext } from "./helpers";
import { createForeignTenant } from "./foreign-tenant";

/**
 * The emit actions the Event Spec page calls, against the real database and the real emission service. Only the request-scoped
 * inputs are replaced: the session, the user mapping, the role lookup and the active tenant (reads a cookie).
 * Spec / version rows are written directly — no publish audit rows (immutable) are created.
 */
const h = vi.hoisted(() => ({ userId: "", tenantId: "" }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: h.userId } }) }));
vi.mock("@/lib/current-user", () => ({ resolveCurrentUserId: async () => h.userId }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: async () => h.tenantId }));
vi.mock("@/services/rbac.service", () => ({ getEffectiveRole: async () => ({ success: true, data: "VIEWER" }) }));

import { emitEventSpecDraftAction, getEventSpecVersionDocumentAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-emit-actions";

let prisma: PrismaClient;
let ctx: ServiceContext;
let own: Awaited<ReturnType<typeof createProductScope>>;
let foreign: Awaited<ReturnType<typeof createForeignTenant>>;
let siblingProductId: string;
let mine: { id: string };
let sibling: { id: string };
let foreignSpec: { id: string };

const NOT_FOUND = { success: false, error: "Event spec not found", code: "NOT_FOUND" };

async function createSpec(at: { tenantId: string; domainId: string; productId: string }, name: string) {
  const spec = await prisma.eventSpec.create({ data: { name, ...at, document: { info: { title: name }, servers: [], operations: [] } } });
  const version = await prisma.eventSpecVersion.create({
    data: {
      eventSpecId: spec.id, major: 1, minor: 0, sequence: 1, changeKind: "INITIAL", publishedById: ctx.userId,
      document: { asyncapi: "3.0.0", info: { title: name, version: "1.0" }, servers: {}, channels: {}, operations: {}, components: {} },
      sourceDocument: { info: { title: name }, servers: [], operations: [] },
      frozenChannels: [], frozenTraits: [], messageVersionIds: [], compatReport: { reasons: [], diagnostics: [] },
    },
  });
  await prisma.eventSpec.update({ where: { id: spec.id }, data: { latestVersionId: version.id, hasUnpublishedChanges: false } });
  return spec;
}

beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
  h.userId = ctx.userId;
  h.tenantId = TENANT;
  try {
    own = await createProductScope(prisma, ctx, "ema");
    const at = { tenantId: TENANT, domainId: own.domain.id, productId: own.product.id };
    mine = await createSpec(at, `emit-mine-${own.s}`);
    const siblingProduct = await prisma.product.create({ data: { domainId: own.domain.id, name: `sib ${own.s}`, slug: `ema-sib-${own.s}` } });
    siblingProductId = siblingProduct.id;
    sibling = await createSpec({ ...at, productId: siblingProduct.id }, `emit-sibling-${own.s}`);
    foreign = await createForeignTenant(prisma, ctx);
    foreignSpec = await createSpec({ tenantId: foreign.tenant.id, domainId: foreign.domain.id, productId: foreign.product.id }, `emit-foreign-${own.s}`);
  } catch (e) {
    await foreign?.cleanup().catch(() => undefined);
    await cleanupDomains(prisma, [own?.domain.id]);
    await prisma.$disconnect();
    throw e;
  }
}, 60_000);

afterAll(async () => {
  try {
    await foreign?.cleanup();
  } finally {
    try {
      await cleanupDomains(prisma, [own?.domain.id]);
    } finally {
      await prisma.$disconnect();
    }
  }
});

describe("event spec emit actions — scoping against the real database", () => {
  it("emit the draft of the product's own spec and a stored version of it", async () => {
    const draft = await emitEventSpecDraftAction(mine.id, own.product.id);
    expect(draft).toMatchObject({ success: true, data: { specId: mine.id, version: "draft", published: false } });
    const version = await getEventSpecVersionDocumentAction(mine.id, "1.0");
    expect(version).toMatchObject({ success: true, data: { specId: mine.id, version: "1.0", published: true } });
  }, 60_000);

  it("another product of the tenant: its published version is readable, its draft is not", async () => {
    expect(await getEventSpecVersionDocumentAction(sibling.id, "1.0")).toMatchObject({ success: true, data: { specId: sibling.id, published: true } });
    // The caller's product does not own the spec.
    expect(await emitEventSpecDraftAction(sibling.id, own.product.id)).toEqual(NOT_FOUND);
    // Even naming the owner's product id from outside is only honoured for the owner (that IS the owner's page).
    expect(await emitEventSpecDraftAction(sibling.id, siblingProductId)).toMatchObject({ success: true });
  }, 60_000);

  it("a spec of another tenant and an unknown id are the same fixed NOT_FOUND — drafts and versions, whatever product id is claimed", async () => {
    const answers = [
      await emitEventSpecDraftAction(foreignSpec.id, own.product.id),
      await emitEventSpecDraftAction(foreignSpec.id, foreign.product.id), // forging the foreign tenant's own product id changes nothing
      await emitEventSpecDraftAction("does-not-exist", own.product.id),
      await getEventSpecVersionDocumentAction(foreignSpec.id, "1.0"),
      await getEventSpecVersionDocumentAction("does-not-exist", "1.0"),
    ];
    for (const a of answers) expect(a).toEqual(NOT_FOUND);
    expect(JSON.stringify(answers)).not.toContain(foreignSpec.id);
  });

  it("rejects an out-of-range or malformed version label the same way for every spec, before any read", async () => {
    for (const label of ["99999999999.0", "1.99999999999", `${"9".repeat(400)}.0`, "abc", "1"]) {
      const answers = await Promise.all([mine.id, sibling.id, foreignSpec.id, "does-not-exist"].map((id) => getEventSpecVersionDocumentAction(id, label)));
      for (const a of answers) expect(a).toEqual({ success: false, error: "The version must be MAJOR.MINOR, e.g. 2.1", code: "VALIDATION_ERROR" });
    }
  });

  it("reads nothing for a draft call without a product id (no widening to the whole tenant)", async () => {
    expect(await emitEventSpecDraftAction(mine.id, undefined as unknown as string)).toEqual(NOT_FOUND);
    expect(await emitEventSpecDraftAction(mine.id, "")).toEqual(NOT_FOUND);
  });
});
