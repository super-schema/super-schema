import "dotenv/config"; // before any import that reaches @/lib/db, which reads DB_PROVIDER when first evaluated
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { cleanupDomains, connectTestDb, createProductScope, TENANT, testContext } from "../services/events/helpers";
import { createForeignTenant } from "../services/events/foreign-tenant";

/**
 * GET /api/v1/event-specs/:id against the real database and the real emission service. Only the two request-scoped inputs
 * are replaced: the v1 auth result (so the context carries this suite's Prisma client) and the active tenant (reads a cookie).
 * Spec / version rows are written directly — no publish audit rows (immutable) are created.
 */
const h = vi.hoisted(() => ({ ctx: undefined as unknown, tenantId: "" }));
vi.mock("@/app/api/v1/middleware", () => ({ authenticateRequest: async () => ({ authenticated: true, context: h.ctx }) }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: async () => h.tenantId }));

import { GET } from "@/app/api/v1/event-specs/[id]/route";

let prisma: PrismaClient;
let ctx: ServiceContext;
let own: Awaited<ReturnType<typeof createProductScope>>;
let foreign: Awaited<ReturnType<typeof createForeignTenant>>;

let published: { id: string; name: string };
let unpublished: { id: string };
let broken: { id: string };
let foreignSpec: { id: string };

const call = (id: string, query = "") => GET(new Request(`http://localhost/api/v1/event-specs/${id}${query}`), { params: Promise.resolve({ id }) });

function storedDocument(title: string, version: string) {
  return { asyncapi: "3.0.0", info: { title, version }, servers: {}, channels: {}, operations: {}, components: {} };
}

async function createSpecWithVersions(scope: { tenantId: string; domainId: string; productId: string }, name: string, versions: Array<{ major: number; minor: number }>) {
  const spec = await prisma.eventSpec.create({
    data: { name, ...scope, document: { info: { title: name }, servers: [], operations: [] } },
  });
  let last: string | undefined;
  for (const [i, v] of versions.entries()) {
    const label = `${v.major}.${v.minor}`;
    const row = await prisma.eventSpecVersion.create({
      data: {
        eventSpecId: spec.id, ...v, sequence: i + 1, changeKind: i === 0 ? "INITIAL" : "MAJOR", publishedById: ctx.userId,
        document: storedDocument(`${name} ${label}`, label),
        sourceDocument: { info: { title: name }, servers: [], operations: [] },
        frozenChannels: [], frozenTraits: [], messageVersionIds: [], compatReport: { reasons: [], diagnostics: [] },
      },
    });
    last = row.id;
  }
  if (last) await prisma.eventSpec.update({ where: { id: spec.id }, data: { latestVersionId: last, hasUnpublishedChanges: false } });
  return spec;
}

beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
  h.ctx = ctx;
  h.tenantId = TENANT;
  own = await createProductScope(prisma, ctx, "esr");
  const scope = { tenantId: TENANT, domainId: own.domain.id, productId: own.product.id };

  // A name full of characters that must not reach the Content-Disposition header verbatim.
  published = await createSpecWithVersions(scope, `Checkout "Service" (EU) ${own.s}`, [{ major: 1, minor: 0 }, { major: 2, minor: 0 }]);
  unpublished = await createSpecWithVersions(scope, `never-published-${own.s}`, []);
  broken = await prisma.eventSpec.create({
    data: {
      name: `broken-${own.s}`, ...scope,
      document: { info: { title: "x" }, servers: [], operations: [{ key: "op", action: "send", channelId: "gone", messageVersionIds: [], traitIds: [] }] },
    },
  });

  foreign = await createForeignTenant(prisma, ctx);
  foreignSpec = await createSpecWithVersions(
    { tenantId: foreign.tenant.id, domainId: foreign.domain.id, productId: foreign.product.id }, `foreign-spec-${foreign.tenant.slug}`, [{ major: 1, minor: 0 }]
  );
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

describe.sequential("GET /api/v1/event-specs/:id (real DB, real emission service)", () => {
  it("defaults to the latest published version, as YAML, from the stored document", async () => {
    const res = await call(published.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/yaml; charset=utf-8");
    expect(res.headers.get("x-event-spec-version")).toBe("2.0");
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="Checkout-Service-EU-${own.s}-2.0.asyncapi.yaml"`);
    const body = await res.text();
    expect(body.startsWith("asyncapi: 3.0.0\ninfo:\n")).toBe(true); // canonical key order despite jsonb's shortest-first
    expect(body).toContain(`(EU) ${own.s} 2.0`); // the 2.0 document, not 1.0
    expect(body).not.toContain(`(EU) ${own.s} 1.0`);
  });

  it("serves an older published version as JSON", async () => {
    const res = await call(published.id, "?version=1.0&format=json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("x-event-spec-version")).toBe("1.0");
    const doc = JSON.parse(await res.text());
    expect(doc.info).toEqual({ title: `Checkout "Service" (EU) ${own.s} 1.0`, version: "1.0" });
  });

  it("404s an unknown version, 400s a malformed one", async () => {
    expect((await call(published.id, "?version=3.0")).status).toBe(404);
    expect((await call(published.id, "?version=0.9")).status).toBe(404);
    expect((await call(published.id, "?version=99999999999.0")).status).toBe(404);
    expect((await call(published.id, "?version=latest")).status).toBe(400);
    expect((await call(published.id, "?format=xml")).status).toBe(400);
  });

  it("404s a spec that was never published unless version=draft, and emits its draft", async () => {
    const res = await call(unpublished.id);
    expect(res.status).toBe(404);
    expect((await res.json()).error.suggestedFix).toMatch(/version=draft/);

    const draft = await call(unpublished.id, "?version=draft");
    expect(draft.status).toBe(200);
    expect(draft.headers.get("x-event-spec-version")).toBe("draft");
    const body = await draft.text();
    expect(body).toContain("asyncapi: 3.0.0");
    expect(body).toMatch(/version: draft/);
  }, 120_000);

  it("reports an unresolvable draft as a 400 with sanitised diagnostics and no document", async () => {
    const res = await call(broken.id, "?version=draft");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.details.diagnostics).toEqual([
      { severity: "error", code: "UNRESOLVED_REFERENCE", message: 'Draft reference: Channel "gone" not found', pointer: "/operations/0/channelId" },
    ]);
  }, 120_000);

  describe("tenant scoping", () => {
    it("answers another tenant's spec exactly like a nonexistent id, for every version selector", async () => {
      for (const query of ["", "?version=1.0", "?version=1.0&format=json", "?version=draft"]) {
        const other = await call(foreignSpec.id, query);
        const nothing = await call("no-such-spec-id", query);
        expect(other.status, query).toBe(404);
        expect(nothing.status, query).toBe(404);
        expect(await other.json()).toEqual(await nothing.json());
      }
    });

    it("serves that same spec once the caller's tenant is the owning one (so the 404 above is the tenant filter)", async () => {
      h.tenantId = foreign.tenant.id;
      try {
        const res = await call(foreignSpec.id, "?format=json");
        expect(res.status).toBe(200);
        expect(JSON.parse(await res.text()).info.version).toBe("1.0");
        expect((await call(published.id)).status).toBe(404); // and the default-tenant spec is now the foreign one
      } finally {
        h.tenantId = TENANT;
      }
    });
  });
});
