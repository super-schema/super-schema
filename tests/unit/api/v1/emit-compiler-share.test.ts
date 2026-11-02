// @vitest-environment node
/**
 * The compiler's limits as the REST API answers them (src/lib/emission/emission-admission.ts, src/app/api/v1/error-handler.ts):
 *  - a run the compiler refused because its queue is full (EMITTER_BUSY) makes `emit` and `validate` answer 503 with `Retry-After`, never a 200
 *    with `valid: false` (a CI gate would fail a schema for the server's load);
 *  - a principal over its share of the compiler (RUNS_PER_PRINCIPAL runs in flight) is answered 429 at once, and builds nothing; another principal
 *    is admitted meanwhile, so one caller cannot starve the others.
 * Through the real guard and the real emission service; the session, the database and the emitters are stand-ins, as in emit-reference-access.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, sessionOf, userRow } from "../../../helpers/access-mocks";
import type { Assignment } from "@/lib/access";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  activeTenant: vi.fn(),
  emitClosure: vi.fn(),
  emitStandalone: vi.fn(),
  prisma: {
    user: { findUnique: vi.fn() },
    entity: { findMany: vi.fn(), findUnique: vi.fn() },
    field: { findMany: vi.fn() },
    entityVersion: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/active-tenant", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/active-tenant")>()), getActiveTenantId: h.activeTenant }));
vi.mock("@/app/api/v1/rate-limit", () => ({ checkPrincipalRateLimit: () => null, checkFailedAuthRateLimit: () => null }));
vi.mock("@/lib/typespec-official/closure-emit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/typespec-official/closure-emit")>()),
  emitClosure: h.emitClosure,
}));
vi.mock("@/lib/typespec-official/emitter.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/typespec-official/emitter.service")>()),
  emitOfficialTypeSpecTargetFromData: h.emitStandalone,
}));

import { POST as emitSchema } from "@/app/api/v1/schemas/[id]/emit/route";
import { POST as validateSchema } from "@/app/api/v1/schemas/[id]/validate/route";
import { getSchemaTargetCatalog } from "@/lib/schema-targets/catalog";
import { RUNS_PER_PRINCIPAL } from "@/lib/emission/emission-admission";

const T = "t1";
const withId = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (path: string) => new Request(`http://localhost/api/v1${path}`, { method: "POST" });
const bodyOf = async (response: Response) => JSON.parse(await response.text());

function signIn(userId: string, assignments: Assignment[]) {
  h.auth.mockResolvedValue(sessionOf(userId));
  h.prisma.user.findUnique.mockResolvedValue(userRow(assignments, { id: userId }));
}

/** "invoice" references "line": a two-entity closure, emitted by every closure target. */
const ROWS = [
  { id: "invoice", name: "Invoice", references: "line" },
  { id: "line", name: "InvoiceLine", references: undefined },
];
const entityRow = (r: (typeof ROWS)[number]) => ({
  id: r.id, tenantId: T, name: r.name, description: "", status: "DRAFT", version: 1, metadata: null, latestVersionId: null,
  domainId: "d-sales", productId: "p-orders", domain: { id: "d-sales", name: "sales", slug: "sales" },
  product: { name: "orders", domainId: "d-sales" }, fields: fieldsOf(r), createdAt: new Date(), updatedAt: new Date(),
});
function fieldsOf(r: (typeof ROWS)[number]) {
  return r.references
    ? [{
        id: `${r.id}-f`, entityId: r.id, name: "lineRef", type: "reference", precision: null, scale: null, nullable: true, isKey: false, fieldNumber: null,
        description: "", classification: null, aliases: [], sortOrder: 0,
        decorators: { referencedEntityId: r.references, referencedEntityName: "InvoiceLine" },
      }]
    : [];
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.API_KEY;
  h.activeTenant.mockResolvedValue(T);
  h.prisma.entity.findMany.mockImplementation(async () => ROWS.map(entityRow));
  h.prisma.entity.findUnique.mockImplementation(async ({ where, select }: { where: { id: string }; select?: { metadata?: boolean } }) => {
    const row = ROWS.find((r) => r.id === where.id);
    if (select?.metadata) return row ? { metadata: null } : null;
    return row ? entityRow(row) : null;
  });
  h.prisma.field.findMany.mockImplementation(async ({ where }: { where: { entityId: string } }) => fieldsOf(ROWS.find((r) => r.id === where.entityId) ?? ROWS[0]));
  h.prisma.entityVersion.findUnique.mockResolvedValue(null);
  h.emitClosure.mockImplementation(async (_closure: unknown, key: string) => ({
    success: true,
    data: { files: [{ path: `${key}.out`, content: key, target: key, entityId: "x" }], warnings: [], entityFiles: {} },
  }));
  h.emitStandalone.mockResolvedValue({ output: "DDL", validationStatus: "VALID", warnings: [], errors: [] });
  signIn("user-1", [assign.tenant("ADMIN", T)]);
});
const enabled = getSchemaTargetCatalog().filter((t) => t.enabledInSchemaTab);
const closureTargets = enabled.filter((t) => t.closureEmission).length;

const CALLS: Array<[string, (id: string) => Promise<Response>]> = [
  ["emit", (id) => emitSchema(post(`/schemas/${id}/emit`), withId(id))],
  ["validate", (id) => validateSchema(post(`/schemas/${id}/validate`), withId(id))],
];

describe("POST /schemas/:id/emit when the client goes away", () => {
  it("hands the caller's signal to every compiler run, and gives the share back when the run settles, before anything else ends", async () => {
    // Stands in for the emitter's contract: a run whose signal aborts answers EMITTER_CANCELLED at once (the real one kills a running process
    // and starts nothing that is still queued). Nothing else ends these runs, so only the abort can settle the request.
    h.emitClosure.mockImplementation(
      (_closure: unknown, _key: string, run: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          run.signal?.addEventListener("abort", () => resolve({ success: false, error: { code: "EMITTER_CANCELLED", message: "cancelled" } }), { once: true });
        }),
    );
    const caller = new AbortController();
    const response = emitSchema(new Request("http://localhost/api/v1/schemas/invoice/emit", { method: "POST", signal: caller.signal }), withId("invoice"));
    await vi.waitFor(() => expect(h.emitClosure).toHaveBeenCalledTimes(closureTargets));
    const signals = h.emitClosure.mock.calls.map((call) => (call[2] as { signal?: AbortSignal }).signal);
    expect(signals.every((signal) => signal !== undefined && !signal.aborted)).toBe(true);

    caller.abort();
    const settled = await response;
    expect(settled.status).not.toBe(429);
    expect(signals.every((signal) => signal?.aborted)).toBe(true);

    // The share is back: the same caller is admitted to a full emission again.
    h.emitClosure.mockImplementation(async (_closure: unknown, key: string) => ({
      success: true,
      data: { files: [{ path: `${key}.out`, content: key, target: key, entityId: "x" }], warnings: [], entityFiles: {} },
    }));
    const again = await emitSchema(post("/schemas/invoice/emit"), withId("invoice"));
    expect(again.status).toBe(200);
  });
});

describe.each(CALLS)("POST /schemas/:id/%s", (_name, call) => {
  it("answers 503 with Retry-After when the compiler refused a run as busy: never a 200 that says the schema is invalid", async () => {
    h.emitClosure.mockResolvedValue({ success: false, error: { code: "EMITTER_BUSY", message: "The TypeSpec compiler is busy." } });
    const response = await call("invoice");
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toMatch(/^\d+$/);
    const body = await bodyOf(response);
    expect(body).toMatchObject({ success: false, error: { code: "EMITTER_BUSY" } });
    expect(JSON.stringify(body)).not.toMatch(/"valid":false|"pass":false|invalid/i);
  });

  it("refuses a call over the caller's share at once: 429, nothing built, and another caller is admitted", async () => {
    const fill = Math.floor(RUNS_PER_PRINCIPAL / enabled.length);
    expect(fill).toBeGreaterThanOrEqual(1);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    h.emitClosure.mockImplementation(async (_closure: unknown, key: string) => {
      await gate;
      return { success: true, data: { files: [{ path: `${key}.out`, content: key, target: key, entityId: "x" }], warnings: [], entityFiles: {} } };
    });
    try {
      // The caller's calls in flight hold its share: each waits at the compiler (here, the gate).
      const inFlight: Promise<Response>[] = [];
      for (let i = 0; i < fill; i += 1) {
        inFlight.push(call("invoice"));
        await vi.waitFor(() => expect(h.emitClosure.mock.calls.length).toBe((i + 1) * closureTargets));
      }
      const builtBefore = h.emitClosure.mock.calls.length;

      const refused = await call("invoice");
      expect(refused.status).toBe(429);
      expect(await bodyOf(refused)).toMatchObject({ success: false, error: { code: "RATE_LIMITED" } });
      expect(h.emitClosure.mock.calls.length).toBe(builtBefore);

      // Another caller is not refused by it.
      signIn("user-2", [assign.tenant("ADMIN", T)]);
      const other = call("invoice");
      await vi.waitFor(() => expect(h.emitClosure.mock.calls.length).toBe(builtBefore + closureTargets));
      open();
      expect((await other).status).toBe(200);
      for (const response of await Promise.all(inFlight)) expect(response.status).toBe(200);
    } finally {
      open();
    }
  });

  it("gives the share back when the emission settles: the same caller is admitted again", async () => {
    const response = await call("invoice");
    expect(response.status).toBe(200);
    const again = await call("invoice");
    expect(again.status).toBe(200);
  });
});
