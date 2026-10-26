import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { assign, principalOf, roleless, tenantMember } from "../../../helpers/access-mocks";

const h = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  checkRateLimit: vi.fn(),
  getActiveTenantId: vi.fn(),
  findFirst: vi.fn(),
  emitEventDraft: vi.fn(),
  emitEventStoredVersion: vi.fn(),
}));
vi.mock("@/app/api/v1/middleware", () => ({ authenticateRequest: h.authenticateRequest }));
vi.mock("@/app/api/v1/rate-limit", () => ({ checkRateLimit: h.checkRateLimit }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.getActiveTenantId }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { eventSpec: { findFirst: h.findFirst } } }));
vi.mock("@/services/events/event-emit.service", () => ({
  emitEventDraft: h.emitEventDraft,
  emitEventStoredVersion: h.emitEventStoredVersion,
}));

import { GET } from "@/app/api/v1/event-specs/[id]/route";

// The "database": s1 (latest version 2.0) and s-draft-only (never published) belong to the caller's tenant, s-foreign to another
// one. The mock honours the `where` it is given, so removing the route's tenant filter changes the outcome (the cross-tenant test fails).
let specName = "checkout-service";
const SPECS = [
  { id: "s1", tenantId: "t1", productId: "p1", domainId: "d1", latestVersion: { major: 2, minor: 0 } },
  { id: "s-draft-only", tenantId: "t1", productId: "p1", domainId: "d1", latestVersion: null },
  { id: "s-sibling", tenantId: "t1", productId: "p2", domainId: "d2", latestVersion: { major: 1, minor: 0 } },
  { id: "s-foreign", tenantId: "t2", productId: "p9", domainId: "d9", latestVersion: { major: 1, minor: 0 } },
];
/** What the service context of an authorized request carries: the tenant it acts in, whoever the caller is (the services are handed the very ctx). */
const CTX = expect.objectContaining({ tenantId: "t1", userId: "member-1" });
/** A session of a viewer of tenant t1 (the active tenant of a session is resolved per request: `getActiveTenantId`). */
const session = (principal = tenantMember("VIEWER", "t1")) => ({ authenticated: true, source: "session", principal, tenantId: null });
const emission = (over: Record<string, unknown> = {}) => ({
  success: true,
  data: { document: { asyncapi: "3.0.0" }, json: '{"asyncapi":"3.0.0"}\n', yaml: "asyncapi: 3.0.0\n", diagnostics: [], ...over },
});
const call = (query = "", id = "s1") => GET(new Request(`http://x/api/v1/event-specs/${id}${query}`), { params: Promise.resolve({ id }) });
const emitters = () => h.emitEventDraft.mock.calls.length + h.emitEventStoredVersion.mock.calls.length;

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  specName = "checkout-service";
  h.checkRateLimit.mockReturnValue(null);
  h.authenticateRequest.mockResolvedValue(session());
  h.getActiveTenantId.mockResolvedValue("t1");
  h.findFirst.mockImplementation(async ({ where }: { where: { id: string; tenantId?: string } }) => {
    const spec = SPECS.find((s) => s.id === where.id && (where.tenantId === undefined || s.tenantId === where.tenantId));
    return spec ? { name: specName, productId: spec.productId, domainId: spec.domainId, product: { domainId: spec.domainId }, latestVersion: spec.latestVersion } : null;
  });
  h.emitEventDraft.mockResolvedValue(emission());
  h.emitEventStoredVersion.mockResolvedValue(emission());
});

afterEach(() => errorSpy.mockRestore());

describe("GET /api/v1/event-specs/:id", () => {
  it("returns the latest published version as YAML by default", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/yaml; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="checkout-service-2.0.asyncapi.yaml"');
    expect(res.headers.get("x-event-spec-version")).toBe("2.0");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("asyncapi: 3.0.0\n");
    // the stored version is read for the event's own product, never re-rendered as a draft
    expect(h.emitEventStoredVersion).toHaveBeenCalledWith("s1", "p1", "2.0", CTX);
    expect(h.emitEventDraft).not.toHaveBeenCalled();
  });

  it("serves a requested version as JSON and the draft on version=draft", async () => {
    const res = await call("?version=1.0&format=json");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="checkout-service-1.0.asyncapi.json"');
    expect(res.headers.get("x-event-spec-version")).toBe("1.0");
    expect(await res.text()).toBe('{"asyncapi":"3.0.0"}\n');
    expect(h.emitEventStoredVersion).toHaveBeenCalledWith("s1", "p1", "1.0", CTX);

    const draft = await call("?version=draft");
    expect(draft.status).toBe(200);
    expect(draft.headers.get("x-event-spec-version")).toBe("draft");
    expect(draft.headers.get("content-disposition")).toBe('inline; filename="checkout-service-draft.asyncapi.yaml"');
    expect(h.emitEventDraft).toHaveBeenCalledTimes(1);
    expect(h.emitEventDraft).toHaveBeenCalledWith("s1", "p1", CTX);
    expect(h.emitEventStoredVersion).toHaveBeenCalledTimes(1); // the draft never goes through the stored-version path
  });

  it("still returns a draft document that assembled but carries error diagnostics (never a 500)", async () => {
    h.emitEventDraft.mockResolvedValue(emission({
      diagnostics: [{ severity: "error", code: "ASYNCAPI_PARSER_ERROR", message: "x", pointer: "/channels" }],
    }));
    const res = await call("?version=draft");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("asyncapi: 3.0.0\n");
  });

  it("maps errors: unauthenticated 401, bad format 400, never published 404, unknown version 404, unresolved draft 400", async () => {
    h.authenticateRequest.mockResolvedValueOnce({ authenticated: false });
    expect((await call()).status).toBe(401);
    expect((await call("?format=xml")).status).toBe(400);
    const never = await call("", "s-draft-only");
    expect(never.status).toBe(404);
    expect((await never.json()).error.suggestedFix).toMatch(/version=draft/);
    h.emitEventStoredVersion.mockResolvedValueOnce({ success: false, error: { code: "NOT_FOUND", message: "Version 9.0 not found" } });
    expect((await call("?version=9.0")).status).toBe(404);
    h.emitEventDraft.mockResolvedValueOnce(emission({ document: null, json: null, yaml: null, diagnostics: [{ severity: "error", code: "UNRESOLVED_REFERENCE", message: "x", pointer: "/operations/0/channelKey" }] }));
    const broken = await call("?version=draft");
    expect(broken.status).toBe(400);
    expect((await broken.json()).error.details.diagnostics).toHaveLength(1);
  });

  it("serves the draft of an event that was never published, but nothing else without a version", async () => {
    expect((await call("", "s-draft-only")).status).toBe(404);
    expect(emitters()).toBe(0);
    const draft = await call("?version=draft", "s-draft-only");
    expect(draft.status).toBe(200);
    expect(h.emitEventDraft).toHaveBeenCalledWith("s-draft-only", "p1", CTX);
  });

  it("answers rate-limited requests before authenticating", async () => {
    const limited = new Response("slow down", { status: 429 });
    h.checkRateLimit.mockReturnValueOnce(limited);
    expect(await call()).toBe(limited);
    expect(h.authenticateRequest).not.toHaveBeenCalled();
  });
});

describe("version and format parameters", () => {
  it.each(["latest", "1", "1.", ".1", "1.0.0", "v1.0", "-1.0", "1.0 ", "1.x", "Draft", "DRAFT"])("rejects version=%j with 400", async (version) => {
    const res = await call(`?version=${encodeURIComponent(version)}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    expect(emitters()).toBe(0);
  });

  it.each(["xml", "YAML", "yml", "json,yaml"])("rejects format=%j with 400", async (format) => {
    const res = await call(`?format=${encodeURIComponent(format)}`);
    expect(res.status).toBe(400);
    expect(emitters()).toBe(0);
  });

  it("an empty parameter is no parameter: ?version= is the latest published version, ?format= the default format", async () => {
    const res = await call("?version=&format=");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/yaml/);
    expect(h.emitEventStoredVersion).toHaveBeenCalled();
  });

  it("a NUL byte in a query parameter is a 400 VALIDATION_ERROR before anything is looked up", async () => {
    for (const query of ["?format=%00", "?version=1.0%00", "?x=%00"]) {
      const res = await call(query);
      expect(res.status, query).toBe(400);
      expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    }
    expect(emitters()).toBe(0);
  });

  it("does not echo a rejected parameter value back to the caller", async () => {
    const res = await call("?format=%3Cscript%3Ealert(1)%3C%2Fscript%3E");
    expect(JSON.stringify(await res.json())).not.toContain("script");
  });

  it("normalises leading zeros in the label and treats unrepresentable versions as unknown (404, no service call)", async () => {
    expect((await call("?version=01.00")).status).toBe(200);
    expect(h.emitEventStoredVersion).toHaveBeenLastCalledWith("s1", "p1", "1.0", CTX);

    h.emitEventStoredVersion.mockClear();
    for (const version of ["0.1", "0.0", "99999999999.0", "1.99999999999", `1${"0".repeat(400)}.0`]) {
      const res = await call(`?version=${version}`);
      expect(res.status, version).toBe(404);
    }
    expect(emitters()).toBe(0); // the unrepresentable versions never reached a service
  });
});

describe("tenant scoping (R67: the emit service trusts the id, so the route looks the event up in the caller's tenant first)", () => {
  it("looks the event up inside the caller's tenant before emitting, and passes on the event's own product", async () => {
    await call();
    expect(h.getActiveTenantId).toHaveBeenCalledTimes(1);
    expect(h.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "s1", tenantId: "t1" } }));
    expect(h.findFirst.mock.invocationCallOrder[0]).toBeLessThan(h.emitEventStoredVersion.mock.invocationCallOrder[0]);
    expect(h.emitEventStoredVersion.mock.calls[0][1]).toBe("p1");
  });

  it("answers a foreign-tenant event exactly like a nonexistent one (identical 404, no oracle) for every version selector", async () => {
    for (const query of ["", "?version=draft", "?version=1.0", "?version=9.9&format=json"]) {
      const foreign = await call(query, "s-foreign");
      const missing = await call(query, "does-not-exist");
      expect(foreign.status, query).toBe(404);
      expect(missing.status, query).toBe(404);
      expect(await foreign.json()).toEqual(await missing.json());
      expect([...foreign.headers.entries()].sort()).toEqual([...missing.headers.entries()].sort());
    }
    // nothing downstream ran for an event the caller cannot see
    expect(emitters()).toBe(0);
  });

  it("serves the foreign event to a caller whose tenant owns it (the filter is the only difference)", async () => {
    h.authenticateRequest.mockResolvedValue(session(principalOf([assign.tenant("VIEWER", "t1"), assign.tenant("VIEWER", "t2")])));
    h.getActiveTenantId.mockResolvedValue("t2");
    expect((await call("", "s-foreign")).status).toBe(200);
    expect(h.emitEventStoredVersion).toHaveBeenCalledWith("s-foreign", "p9", "1.0", expect.objectContaining({ tenantId: "t2" }));
    expect((await call("", "s1")).status).toBe(404);
  });

  it("an event of a sibling domain, for a caller whose role covers one domain only, is the very 404 of a missing event (a role decides, not only the tenant)", async () => {
    h.authenticateRequest.mockResolvedValue(session(principalOf([assign.domain("VIEWER", "t1", "d1")])));
    expect((await call("", "s1")).status).toBe(200);
    const sibling = await call("?version=draft", "s-sibling");
    const missing = await call("?version=draft", "does-not-exist");
    expect(sibling.status).toBe(404);
    expect(await sibling.json()).toEqual(await missing.json());
    expect(h.emitEventDraft).not.toHaveBeenCalled();
  });

  it("a product-scoped caller reads the events of that product only", async () => {
    h.authenticateRequest.mockResolvedValue(session(principalOf([assign.product("VIEWER", "t1", "d1", "p1")])));
    expect((await call("", "s1")).status).toBe(200);
    expect((await call("", "s-sibling")).status).toBe(404);
  });

  it("a user with no role at all (no tenant to reach, or none in this one) is a 404 and nothing is looked up", async () => {
    h.authenticateRequest.mockResolvedValue(session(roleless()));
    expect((await call()).status).toBe(404);
    h.getActiveTenantId.mockRejectedValue(Object.assign(new Error("no tenant"), { name: "NoTenantAccess", code: "NO_TENANT_ACCESS" }));
    expect((await call()).status).toBe(404);
    expect(h.findFirst).not.toHaveBeenCalled();
    expect(emitters()).toBe(0);
  });

  it("the API key acts in ITS tenant (no session, no active tenant asked); an event of another tenant is the same 404", async () => {
    const key = principalOf([assign.tenant("VIEWER", "t1")], { userId: "api-key-user" });
    h.authenticateRequest.mockResolvedValue({ authenticated: true, source: "api-key", principal: key, tenantId: "t1" });
    expect((await call()).status).toBe(200);
    expect((await call("", "s-foreign")).status).toBe(404);
    expect(h.getActiveTenantId).not.toHaveBeenCalled();
  });

  it("does not leak the event id or its existence in the 404 body", async () => {
    const body = JSON.stringify(await (await call("", "s-foreign")).json());
    expect(body).not.toContain("s-foreign");
    expect(body).not.toContain("t2");
  });

  it("treats an event row without a product like a missing one", async () => {
    h.findFirst.mockResolvedValueOnce({ name: "orphan", productId: null, latestVersion: { major: 1, minor: 0 } });
    expect((await call()).status).toBe(404);
    expect(emitters()).toBe(0);
  });
});

describe("error bodies never forward raw service / database text", () => {
  const LEAK = 'Invalid `prisma.eventSpecVersion.findUnique()` invocation: connect ECONNREFUSED 10.0.0.5:5432 (secret-spec)';

  it.each(["INTERNAL_ERROR", "DB_ERROR", "DATA_CORRUPT", "FORBIDDEN", "SOMETHING_NEW"])("maps a %s from the service to a generic 500 and logs the original", async (code) => {
    h.emitEventDraft.mockResolvedValue({ success: false, error: { code, message: LEAK, details: { cause: LEAK }, suggestedFix: LEAK } });
    const res = await call("?version=draft");
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).not.toMatch(/prisma|ECONNREFUSED|secret-spec|10\.0\.0\.5/);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("maps a NOT_FOUND from the service (event removed mid-request, or unknown version) to a generic 404", async () => {
    h.emitEventDraft.mockResolvedValue({ success: false, error: { code: "NOT_FOUND", message: LEAK } });
    h.emitEventStoredVersion.mockResolvedValue({ success: false, error: { code: "NOT_FOUND", message: LEAK } });
    for (const query of ["?version=draft", "?version=3.0"]) {
      const res = await call(query);
      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).not.toMatch(/prisma|ECONNREFUSED|secret-spec/);
    }
  });

  it("maps a VALIDATION_ERROR from the service to a generic 400", async () => {
    h.emitEventStoredVersion.mockResolvedValue({ success: false, error: { code: "VALIDATION_ERROR", message: LEAK, details: { x: LEAK } } });
    const res = await call("?version=1.0");
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toMatch(/prisma|ECONNREFUSED|secret-spec/);
  });

  it("turns a throw from any dependency into a generic 500 (the route never throws)", async () => {
    h.findFirst.mockRejectedValueOnce(new Error(LEAK));
    const lookup = await call();
    expect(lookup.status).toBe(500);
    expect(JSON.stringify(await lookup.json())).not.toMatch(/prisma|ECONNREFUSED|secret-spec/);

    h.getActiveTenantId.mockRejectedValueOnce(new Error(LEAK));
    expect((await call()).status).toBe(500);

    h.emitEventStoredVersion.mockRejectedValueOnce(new Error(LEAK));
    const emit = await call();
    expect(emit.status).toBe(500);
    expect(JSON.stringify(await emit.json())).not.toMatch(/prisma|ECONNREFUSED|secret-spec/);

    h.emitEventDraft.mockRejectedValueOnce(new Error(LEAK));
    expect((await call("?version=draft")).status).toBe(500);
    expect(errorSpy).toHaveBeenCalledTimes(4);
  });

  it("reports an unassemblable draft with whitelisted, already-sanitised diagnostics only", async () => {
    h.emitEventDraft.mockResolvedValue(emission({
      document: null, json: null, yaml: null,
      diagnostics: [{ severity: "error", code: "UNRESOLVED_REFERENCE", message: 'Draft reference: Channel "gone" not found', pointer: "/operations/0/channelKey", stack: "at /srv/app.js:1" }],
    }));
    const res = await call("?version=draft");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details.diagnostics).toEqual([
      { severity: "error", code: "UNRESOLVED_REFERENCE", message: 'Draft reference: Channel "gone" not found', pointer: "/operations/0/channelKey" },
    ]);
  });
});

describe("Content-Disposition filename", () => {
  const disposition = async (name: string, format = "yaml") => {
    specName = name;
    const res = await call(`?format=${format}`);
    expect(res.status).toBe(200);
    return res.headers.get("content-disposition");
  };

  it("sanitises odd characters in the event name (quotes, separators, whitespace, unicode, control characters)", async () => {
    expect(await disposition('Orders "v2"; rm -rf /')).toBe('inline; filename="Orders-v2-rm-rf-2.0.asyncapi.yaml"');
    expect(await disposition("../../etc/passwd")).toBe('inline; filename="etc-passwd-2.0.asyncapi.yaml"');
    expect(await disposition("Checkout Service (EU)", "json")).toBe('inline; filename="Checkout-Service-EU-2.0.asyncapi.json"');
    expect(await disposition("Zażółć gęślą\r\nX-Evil: 1")).toBe('inline; filename="Za-g-l-X-Evil-1-2.0.asyncapi.yaml"');
  });

  it("falls back to a fixed stem when nothing usable remains and bounds the length", async () => {
    expect(await disposition("日本語")).toBe('inline; filename="event-spec-2.0.asyncapi.yaml"');
    expect(await disposition("")).toBe('inline; filename="event-spec-2.0.asyncapi.yaml"');
    expect(await disposition("...")).toBe('inline; filename="event-spec-2.0.asyncapi.yaml"');
    const long = await disposition("a".repeat(500));
    expect(long).toBe(`inline; filename="${"a".repeat(100)}-2.0.asyncapi.yaml"`);
  });
});
