import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  checkRateLimit: vi.fn(),
  getActiveTenantId: vi.fn(),
  findFirst: vi.fn(),
  emitEventSpec: vi.fn(),
  getLatestEventSpecVersionLabel: vi.fn(),
}));
vi.mock("@/app/api/v1/middleware", () => ({ authenticateRequest: h.authenticateRequest }));
vi.mock("@/app/api/v1/rate-limit", () => ({ checkRateLimit: h.checkRateLimit }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.getActiveTenantId }));
vi.mock("@/services/events/event-spec-emit.service", () => ({
  emitEventSpec: h.emitEventSpec,
  getLatestEventSpecVersionLabel: h.getLatestEventSpecVersionLabel,
}));

import { GET } from "@/app/api/v1/event-specs/[id]/route";

// The "database": s1 belongs to the caller's tenant, s-foreign to another one. The mock honours the `where` it is given,
// so removing the route's tenant filter changes the outcome (the cross-tenant test fails).
const SPECS = [
  { id: "s1", tenantId: "t1" },
  { id: "s-foreign", tenantId: "t2" },
];
const CTX = { userId: "api-key-user", userRole: "ADMIN", prisma: { eventSpec: { findFirst: h.findFirst } } };
const emission = (over: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    specId: "s1", specName: "checkout-service", version: "2.0", published: true, document: { asyncapi: "3.0.0" },
    json: '{"asyncapi":"3.0.0"}\n', yaml: "asyncapi: 3.0.0\n", diagnostics: [], unpublishedMessages: [], ...over,
  },
});
const call = (query = "", id = "s1") => GET(new Request(`http://x/api/v1/event-specs/${id}${query}`), { params: Promise.resolve({ id }) });

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  h.checkRateLimit.mockReturnValue(null);
  h.authenticateRequest.mockResolvedValue({ authenticated: true, context: CTX });
  h.getActiveTenantId.mockResolvedValue("t1");
  h.findFirst.mockImplementation(async ({ where }: { where: { id: string; tenantId?: string } }) =>
    SPECS.find((s) => s.id === where.id && (where.tenantId === undefined || s.tenantId === where.tenantId)) ?? null
  );
  h.getLatestEventSpecVersionLabel.mockResolvedValue({ success: true, data: "2.0" });
});

afterEach(() => errorSpy.mockRestore());

describe("GET /api/v1/event-specs/:id", () => {
  it("returns the latest published version as YAML by default", async () => {
    h.getLatestEventSpecVersionLabel.mockResolvedValue({ success: true, data: "2.0" });
    h.emitEventSpec.mockResolvedValue(emission());
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/yaml; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="checkout-service-2.0.asyncapi.yaml"');
    expect(res.headers.get("x-event-spec-version")).toBe("2.0");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("asyncapi: 3.0.0\n");
    expect(h.emitEventSpec).toHaveBeenCalledWith("s1", { versionLabel: "2.0" }, CTX);
  });

  it("serves a requested version as JSON and the draft on version=draft", async () => {
    h.emitEventSpec.mockResolvedValue(emission({ version: "1.0" }));
    const res = await call("?version=1.0&format=json");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="checkout-service-1.0.asyncapi.json"');
    expect(await res.text()).toBe('{"asyncapi":"3.0.0"}\n');
    expect(h.emitEventSpec).toHaveBeenCalledWith("s1", { versionLabel: "1.0" }, CTX);
    expect(h.getLatestEventSpecVersionLabel).not.toHaveBeenCalled(); // an explicit version needs no "latest" lookup

    h.emitEventSpec.mockResolvedValue(emission({ version: "draft", published: false }));
    const draft = await call("?version=draft");
    expect(draft.status).toBe(200);
    expect(draft.headers.get("x-event-spec-version")).toBe("draft");
    expect(h.emitEventSpec).toHaveBeenLastCalledWith("s1", { draft: true }, CTX);
  });

  it("still returns a draft document that assembled but carries error diagnostics (never a 500)", async () => {
    h.emitEventSpec.mockResolvedValue(emission({
      version: "draft", published: false,
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
    h.getLatestEventSpecVersionLabel.mockResolvedValueOnce({ success: true, data: null });
    const never = await call();
    expect(never.status).toBe(404);
    expect((await never.json()).error.suggestedFix).toMatch(/version=draft/);
    h.emitEventSpec.mockResolvedValueOnce({ success: false, error: { code: "NOT_FOUND", message: "Version 9.0 not found" } });
    expect((await call("?version=9.0")).status).toBe(404);
    h.emitEventSpec.mockResolvedValueOnce(emission({ document: null, json: null, yaml: null, diagnostics: [{ severity: "error", code: "UNRESOLVED_REFERENCE", message: "x", pointer: "/operations/0/channelId" }] }));
    const broken = await call("?version=draft");
    expect(broken.status).toBe(400);
    expect((await broken.json()).error.details.diagnostics).toHaveLength(1);
  });

  it("answers rate-limited requests before authenticating", async () => {
    const limited = new Response("slow down", { status: 429 });
    h.checkRateLimit.mockReturnValueOnce(limited);
    expect(await call()).toBe(limited);
    expect(h.authenticateRequest).not.toHaveBeenCalled();
  });
});

describe("version and format parameters", () => {
  it.each(["latest", "1", "1.", ".1", "1.0.0", "v1.0", "-1.0", "1.0 ", "1.x", "", "Draft", "DRAFT"])("rejects version=%j with 400", async (version) => {
    const res = await call(`?version=${encodeURIComponent(version)}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    expect(h.emitEventSpec).not.toHaveBeenCalled();
  });

  it.each(["xml", "YAML", "yml", "", "json,yaml"])("rejects format=%j with 400", async (format) => {
    const res = await call(`?format=${encodeURIComponent(format)}`);
    expect(res.status).toBe(400);
    expect(h.emitEventSpec).not.toHaveBeenCalled();
  });

  it("does not echo a rejected parameter value back to the caller", async () => {
    const res = await call("?format=%3Cscript%3Ealert(1)%3C%2Fscript%3E");
    expect(JSON.stringify(await res.json())).not.toContain("script");
  });

  it("normalises leading zeros in the label and treats unrepresentable versions as unknown (404, no service call)", async () => {
    h.emitEventSpec.mockResolvedValue(emission({ version: "1.0" }));
    expect((await call("?version=01.00")).status).toBe(200);
    expect(h.emitEventSpec).toHaveBeenLastCalledWith("s1", { versionLabel: "1.0" }, CTX);

    h.emitEventSpec.mockClear();
    for (const version of ["0.1", "0.0", "99999999999.0", "1.99999999999", `1${"0".repeat(400)}.0`]) {
      const res = await call(`?version=${version}`);
      expect(res.status, version).toBe(404);
    }
    expect(h.emitEventSpec).not.toHaveBeenCalled();
  });
});

describe("tenant scoping (R67: emitEventSpec reads by id, unscoped)", () => {
  it("looks the spec up inside the caller's tenant before emitting", async () => {
    h.emitEventSpec.mockResolvedValue(emission());
    await call();
    expect(h.getActiveTenantId).toHaveBeenCalledTimes(1);
    expect(h.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "s1", tenantId: "t1" } }));
    expect(h.findFirst.mock.invocationCallOrder[0]).toBeLessThan(h.emitEventSpec.mock.invocationCallOrder[0]);
  });

  it("answers a foreign-tenant spec exactly like a nonexistent one (identical 404, no oracle) for every version selector", async () => {
    h.emitEventSpec.mockResolvedValue(emission({ specId: "s-foreign", specName: "secret-spec" }));
    for (const query of ["", "?version=draft", "?version=1.0", "?version=9.9&format=json"]) {
      const foreign = await call(query, "s-foreign");
      const missing = await call(query, "does-not-exist");
      expect(foreign.status, query).toBe(404);
      expect(missing.status, query).toBe(404);
      expect(await foreign.json()).toEqual(await missing.json());
      expect([...foreign.headers.entries()].sort()).toEqual([...missing.headers.entries()].sort());
    }
    // nothing downstream ran for a spec the caller cannot see
    expect(h.getLatestEventSpecVersionLabel).not.toHaveBeenCalled();
    expect(h.emitEventSpec).not.toHaveBeenCalled();
  });

  it("serves the foreign spec to a caller whose tenant owns it (the filter is the only difference)", async () => {
    h.getActiveTenantId.mockResolvedValue("t2");
    h.emitEventSpec.mockResolvedValue(emission({ specId: "s-foreign" }));
    expect((await call("", "s-foreign")).status).toBe(200);
    expect((await call("", "s1")).status).toBe(404);
  });

  it("does not leak the spec id or its existence in the 404 body", async () => {
    const body = JSON.stringify(await (await call("", "s-foreign")).json());
    expect(body).not.toContain("s-foreign");
    expect(body).not.toContain("t2");
  });
});

describe("error bodies never forward raw service / database text", () => {
  const LEAK = 'Invalid `prisma.eventSpecVersion.findUnique()` invocation: connect ECONNREFUSED 10.0.0.5:5432 (secret-spec)';

  it.each(["INTERNAL_ERROR", "DB_ERROR", "DATA_CORRUPT", "SOMETHING_NEW"])("maps a %s from the service to a generic 500 and logs the original", async (code) => {
    h.emitEventSpec.mockResolvedValue({ success: false, error: { code, message: LEAK, details: { cause: LEAK }, suggestedFix: LEAK } });
    const res = await call("?version=draft");
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).not.toMatch(/prisma|ECONNREFUSED|secret-spec|10\.0\.0\.5/);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("maps a NOT_FOUND from the service (spec removed mid-request, or unknown version) to a generic 404", async () => {
    h.emitEventSpec.mockResolvedValue({ success: false, error: { code: "NOT_FOUND", message: LEAK } });
    for (const query of ["?version=draft", "?version=3.0"]) {
      const res = await call(query);
      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).not.toMatch(/prisma|ECONNREFUSED|secret-spec/);
    }
  });

  it("maps a VALIDATION_ERROR from the service to a generic 400", async () => {
    h.emitEventSpec.mockResolvedValue({ success: false, error: { code: "VALIDATION_ERROR", message: LEAK, details: { x: LEAK } } });
    const res = await call("?version=1.0");
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toMatch(/prisma|ECONNREFUSED|secret-spec/);
  });

  it("maps a failed latest-version lookup the same way", async () => {
    h.getLatestEventSpecVersionLabel.mockResolvedValue({ success: false, error: { code: "DB_ERROR", message: LEAK } });
    const res = await call();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/prisma|ECONNREFUSED|secret-spec/);
  });

  it("turns a throw from any dependency into a generic 500 (the route never throws)", async () => {
    h.findFirst.mockRejectedValueOnce(new Error(LEAK));
    const lookup = await call();
    expect(lookup.status).toBe(500);
    expect(JSON.stringify(await lookup.json())).not.toMatch(/prisma|ECONNREFUSED|secret-spec/);

    h.getActiveTenantId.mockRejectedValueOnce(new Error(LEAK));
    expect((await call()).status).toBe(500);

    h.emitEventSpec.mockRejectedValueOnce(new Error(LEAK));
    const emit = await call();
    expect(emit.status).toBe(500);
    expect(JSON.stringify(await emit.json())).not.toMatch(/prisma|ECONNREFUSED|secret-spec/);
    expect(errorSpy).toHaveBeenCalledTimes(3);
  });

  it("reports an unassemblable draft with whitelisted, already-sanitised diagnostics only", async () => {
    h.emitEventSpec.mockResolvedValue(emission({
      version: "draft", published: false, document: null, json: null, yaml: null,
      diagnostics: [{ severity: "error", code: "UNRESOLVED_REFERENCE", message: 'Draft reference: Channel "gone" not found', pointer: "/operations/0/channelId", stack: "at /srv/app.js:1" }],
    }));
    const res = await call("?version=draft");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details.diagnostics).toEqual([
      { severity: "error", code: "UNRESOLVED_REFERENCE", message: 'Draft reference: Channel "gone" not found', pointer: "/operations/0/channelId" },
    ]);
  });
});

describe("Content-Disposition filename", () => {
  const disposition = async (specName: string, format = "yaml") => {
    h.emitEventSpec.mockResolvedValue(emission({ specName }));
    const res = await call(`?format=${format}`);
    expect(res.status).toBe(200);
    return res.headers.get("content-disposition");
  };

  it("sanitises odd characters in the spec name (quotes, separators, whitespace, unicode, control characters)", async () => {
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
