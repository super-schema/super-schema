import "dotenv/config"; // before any import that reaches @/lib/db, which reads DB_PROVIDER when first evaluated
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { emptyEventDocument } from "@/lib/events/document/types";
import { cleanupDomains, connectTestDb, createEventSpecVersion, createProductScope, TENANT, testContext } from "../services/events/helpers";
import { createForeignTenant } from "../services/events/foreign-tenant";

/**
 * GET /api/v1/event-specs/:id against the real database and the real emission service, for self-contained events (document v2).
 * Only the request-scoped inputs are replaced: who is calling (the API key's service principal, a platform administrator acting in this
 * suite's tenant: `withApiAuth` needs no session for it) and the session library. Event / version rows are written directly — no publish
 * audit rows (immutable) are created.
 */
const h = vi.hoisted(() => ({ ctx: undefined as unknown, tenantId: "" }));
vi.mock("@/app/api/v1/middleware", () => ({
  authenticateRequest: async () => ({
    authenticated: true,
    source: "api-key",
    tenantId: h.tenantId,
    principal: { userId: "api-key-user", email: "api-key@service.invalid", assignments: [{ role: "ADMIN", scope: { kind: "GLOBAL" } }], isGlobalAdmin: true },
  }),
}));
vi.mock("@/lib/auth", () => ({ auth: async () => null }));

import { GET } from "@/app/api/v1/event-specs/[id]/route";

let prisma: PrismaClient;
let ctx: ServiceContext;
let own: Awaited<ReturnType<typeof createProductScope>>;
let foreign: Awaited<ReturnType<typeof createForeignTenant>>;

let published: { id: string; name: string };
let unpublished: { id: string };
let broken: { id: string };
let corrupt: { id: string; name: string };
let foreignEvent: { id: string };

const call = (id: string, query = "") => GET(new Request(`http://localhost/api/v1/event-specs/${id}${query}`), { params: Promise.resolve({ id }) });

function storedDocument(title: string, version: string) {
  return { asyncapi: "3.0.0", info: { title, version }, servers: {}, channels: {}, operations: {}, components: {} };
}

async function createEventWithVersions(scope: { tenantId: string; domainId: string; productId: string }, name: string, versions: Array<{ major: number; minor: number }>) {
  const source = emptyEventDocument(name) as unknown as Prisma.InputJsonValue;
  const event = await prisma.eventSpec.create({ data: { name, ...scope, document: source } });
  let last: string | undefined;
  for (const [i, v] of versions.entries()) {
    const label = `${v.major}.${v.minor}`;
    const row = await createEventSpecVersion(prisma, {
      eventSpecId: event.id, ...v, sequence: i + 1, changeKind: i === 0 ? "INITIAL" : "MAJOR", publishedById: ctx.userId,
      document: storedDocument(`${name} ${label}`, label), sourceDocument: source, frozenTraits: [], resolvedSpec: { documentVersion: 2 },
      compatReport: { reasons: [], diagnostics: [] },
    });
    last = row.id;
  }
  if (last) await prisma.eventSpec.update({ where: { id: event.id }, data: { latestVersionId: last, hasUnpublishedChanges: false } });
  return event;
}

beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
  h.ctx = ctx;
  h.tenantId = TENANT;
  own = await createProductScope(prisma, ctx, "esr");
  const scope = { tenantId: TENANT, domainId: own.domain.id, productId: own.product.id };

  // A name full of characters that must not reach the Content-Disposition header verbatim.
  published = await createEventWithVersions(scope, `Checkout "Service" (EU) ${own.s}`, [{ major: 1, minor: 0 }, { major: 2, minor: 0 }]);
  unpublished = await createEventWithVersions(scope, `never-published-${own.s}`, []);
  // A message pinned to an entity that does not exist: the draft parses, but its payload cannot be rendered.
  broken = await prisma.eventSpec.create({
    data: {
      name: `broken-${own.s}`, ...scope,
      document: {
        ...emptyEventDocument("x"), messages: [{ key: "lost", payload: { entityId: `gone-${own.s}`, entityVersionId: null }, traitKeys: [] }],
      } as unknown as Prisma.InputJsonValue,
    },
  });
  // A stored draft that is not a valid event document at all (a channel key nothing defines).
  corrupt = await prisma.eventSpec.create({
    data: {
      name: `corrupt-${own.s}`, ...scope,
      document: { ...emptyEventDocument("x"), operations: [{ key: "op", action: "send", channelKey: "gone", messageKeys: [], traitKeys: [] }] } as unknown as Prisma.InputJsonValue,
    },
  });

  foreign = await createForeignTenant(prisma, ctx);
  foreignEvent = await createEventWithVersions(
    { tenantId: foreign.tenant.id, domainId: foreign.domain.id, productId: foreign.product.id }, `foreign-event-${foreign.tenant.slug}`, [{ major: 1, minor: 0 }]
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

describe.sequential("GET /api/v1/event-specs/:id (real DB, real emission service, self-contained events)", () => {
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

  it("404s an event that was never published unless version=draft, and emits its draft", async () => {
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

  it("emits the saved draft of a published event too (the draft is not the stored version)", async () => {
    const draft = await call(published.id, "?version=draft&format=json");
    expect(draft.status).toBe(200);
    expect(JSON.parse(await draft.text()).info).toMatchObject({ version: "draft" });
  }, 120_000);

  it("reports an unresolvable draft as a 400 with sanitised diagnostics and no document", async () => {
    const res = await call(broken.id, "?version=draft");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.details.diagnostics.length).toBeGreaterThan(0);
    for (const d of body.error.details.diagnostics) expect(Object.keys(d).sort()).toEqual(["code", "message", "pointer", "severity"]);
    expect(body.error.details.diagnostics.some((d: { severity: string }) => d.severity === "error")).toBe(true);
    expect(JSON.stringify(body.error.details.diagnostics)).toContain("/messages/0/payload");
  }, 120_000);

  it("answers a stored draft that is no valid event document with a generic 500, never its content", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await call(corrupt.id, "?version=draft");
      expect(res.status).toBe(500);
      const text = JSON.stringify(await res.json());
      expect(text).not.toContain(corrupt.name);
      expect(text).not.toContain("channelKey");
    } finally {
      consoleError.mockRestore();
    }
  });

  describe("tenant scoping", () => {
    it("answers another tenant's event exactly like a nonexistent id, for every version selector", async () => {
      for (const query of ["", "?version=1.0", "?version=1.0&format=json", "?version=draft"]) {
        const other = await call(foreignEvent.id, query);
        const nothing = await call("no-such-event-id", query);
        expect(other.status, query).toBe(404);
        expect(nothing.status, query).toBe(404);
        expect(await other.json()).toEqual(await nothing.json());
      }
    });

    it("serves that same event once the caller's tenant is the owning one (so the 404 above is the tenant filter)", async () => {
      h.tenantId = foreign.tenant.id;
      try {
        const res = await call(foreignEvent.id, "?format=json");
        expect(res.status).toBe(200);
        expect(JSON.parse(await res.text()).info.version).toBe("1.0");
        expect((await call(published.id)).status).toBe(404); // and the default-tenant event is now the foreign one
      } finally {
        h.tenantId = TENANT;
      }
    });
  });
});
