// @vitest-environment node
/**
 * The three import actions (TypeSpec, OpenAPI, JSON Schema by URL) run a converter, the TypeSpec compiler, or an outbound fetch on text or a URL
 * the caller supplies. They used to answer ANY signed-in user (a role-less or disabled one too). They now take the domain the import is for and
 * ask the policy (`import.run` over that domain; `null` is the tenant itself) BEFORE the text is read, converted, compiled or fetched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, principalModule, principalOf, roleless, signInAs, signedOut, tenantMember } from "../../helpers/access-mocks";
import { ROLE_HIERARCHY } from "@/types/schemas/rbac";
import { roleAtLeast } from "@/lib/access";

const T = "tenant-1";
const OTHER = "tenant-2";

const h = vi.hoisted(() => ({
  activeTenant: vi.fn(),
  domainFind: vi.fn(),
  compile: vi.fn(),
  convert: vi.fn(),
  urlImport: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).principalModule);
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.activeTenant }));
vi.mock("@/lib/db", () => ({ prisma: { domain: { findUnique: h.domainFind } } }));
vi.mock("@/lib/compiler/typespec-compiler", () => ({ compileTypeSpecDocument: h.compile }));
vi.mock("@typespec/openapi3", () => ({ convertOpenAPI3Document: h.convert }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/jsonschema-url-import-core", () => ({ runJsonSchemaUrlImport: h.urlImport }));

import { importTypeSpecDocumentAction } from "@/app/(dashboard)/schemas/[domainSlug]/typespec-import-actions";
import { importOpenApiDocumentAction } from "@/app/(dashboard)/schemas/[domainSlug]/openapi-import-actions";
import { importJsonSchemaFromUrlAction } from "@/app/(dashboard)/schemas/[domainSlug]/jsonschema-url-import-actions";

type Answer = { success: boolean; error?: { code: string; message: string } };
type Op = { label: string; call: (domainId: string | null) => Promise<Answer>; effects: () => Array<ReturnType<typeof vi.fn>> };

const OPS: Op[] = [
  { label: "importTypeSpecDocumentAction", call: (d) => importTypeSpecDocumentAction("model A { id: string; }", d), effects: () => [h.compile] },
  { label: "importOpenApiDocumentAction", call: (d) => importOpenApiDocumentAction("openapi: 3.0.0\ninfo: { title: t, version: '1' }\npaths: {}", d), effects: () => [h.convert, h.compile] },
  { label: "importJsonSchemaFromUrlAction", call: (d) => importJsonSchemaFromUrlAction("https://example.com/schema.json", d), effects: () => [h.urlImport] },
];

const NOT_AUTHENTICATED = { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } };
const FORBIDDEN = { success: false, error: { code: "FORBIDDEN", message: "You do not have permission to do this" } };
const reached = (op: Op) => op.effects().filter((effect) => effect.mock.calls.length > 0);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  signInAs(tenantMember("ADMIN", T));
  h.activeTenant.mockResolvedValue(T);
  h.domainFind.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id, tenantId: T }));
  h.compile.mockResolvedValue({ success: true, data: { models: [], enums: [], scalars: [], unions: [], interfaces: [], operations: [] } });
  h.convert.mockResolvedValue("model A { id: string; }");
  h.urlImport.mockResolvedValue({ success: true, data: { entities: [] } });
});

describe.each(OPS)("$label", (op) => {
  it("answers nobody signed in 'Not authenticated' and reads, converts, compiles and fetches nothing", async () => {
    signedOut();
    expect(await op.call("dom-a")).toEqual(NOT_AUTHENTICATED);
    expect(await op.call(null)).toEqual(NOT_AUTHENTICATED);
    expect(reached(op)).toHaveLength(0);
    expect(h.domainFind).not.toHaveBeenCalled();
  });

  it("a user with no role at all gets the answer of a missing domain, and nothing runs", async () => {
    signInAs(roleless());
    expect(await op.call("dom-a")).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Domain not found" } });
    expect(reached(op)).toHaveLength(0);
  });

  it("importing into a domain is an author's act (import.run): a viewer is refused, generic, and nothing runs", async () => {
    for (const role of ROLE_HIERARCHY) {
      vi.clearAllMocks();
      signInAs(tenantMember(role, T));
      h.activeTenant.mockResolvedValue(T);
      h.domainFind.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id, tenantId: T }));
      h.compile.mockResolvedValue({ success: true, data: { models: [], enums: [], scalars: [], unions: [], interfaces: [], operations: [] } });
      h.convert.mockResolvedValue("model A { id: string; }");
      h.urlImport.mockResolvedValue({ success: true, data: { entities: [] } });
      const answer = await op.call("dom-a");
      if (roleAtLeast(role, "AUTHOR")) {
        expect(answer.error?.code, role).not.toBe("FORBIDDEN");
        expect(answer.error?.code, role).not.toBe("UNAUTHORIZED");
        expect(answer.error?.code, role).not.toBe("NOT_FOUND");
        expect(reached(op).length, `${role} should have reached the importer`).toBeGreaterThan(0);
      } else {
        expect(answer, role).toEqual(FORBIDDEN);
        expect(reached(op), role).toHaveLength(0);
      }
    }
  });

  it("a domain of ANOTHER tenant answers exactly like a missing one (also for an administrator of both tenants), and nothing runs", async () => {
    signInAs(principalOf([assign.tenant("ADMIN", T), assign.tenant("ADMIN", OTHER)]));
    h.domainFind.mockResolvedValue({ id: "dom-x", tenantId: OTHER });
    const foreign = await op.call("dom-x");
    h.domainFind.mockResolvedValue(null);
    const missing = await op.call("dom-x");
    expect(foreign).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Domain not found" } });
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
    expect(reached(op)).toHaveLength(0);
  });

  it("a domain-scoped author may import into THEIR domain and not into a sibling one", async () => {
    signInAs(principalOf([assign.domain("AUTHOR", T, "dom-a")]));
    h.domainFind.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id, tenantId: T }));
    expect((await op.call("dom-a")).error?.code).not.toBe("NOT_FOUND");
    vi.clearAllMocks();
    h.domainFind.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id, tenantId: T }));
    const sibling = await op.call("dom-b");
    expect(sibling).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Domain not found" } });
    expect(reached(op)).toHaveLength(0);
  });

  it("without a domain (an Enterprise, tenant-level import) the tenant itself is the target: a tenant author may, a domain-scoped author may not", async () => {
    signInAs(tenantMember("AUTHOR", T));
    expect((await op.call(null)).error?.code).not.toBe("NOT_FOUND");
    expect(reached(op).length).toBeGreaterThan(0);
    vi.clearAllMocks();
    signInAs(principalOf([assign.domain("ADMIN", T, "dom-a")]));
    expect(await op.call(null)).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Not found" } });
    signInAs(tenantMember("VIEWER", T));
    expect(await op.call(null)).toEqual(FORBIDDEN);
    expect(reached(op)).toHaveLength(0);
  });
});

describe("who is nobody", () => {
  it("a disabled or unknown user (no principal) is refused by every import as not authenticated, before anything runs", async () => {
    principalModule.getPrincipal.mockResolvedValue(null);
    for (const op of OPS) {
      expect(await op.call("dom-a"), op.label).toEqual(NOT_AUTHENTICATED);
      expect(reached(op), op.label).toHaveLength(0);
    }
  });
});

describe("the URL import takes no outbound step before the policy has answered", () => {
  it("a refused caller never reaches the core that validates the URL, takes an import slot and fetches", async () => {
    signInAs(tenantMember("VIEWER", T));
    await importJsonSchemaFromUrlAction("https://169.254.169.254/latest/meta-data", "dom-a");
    await importJsonSchemaFromUrlAction("not even a url", "dom-a");
    expect(h.urlImport).not.toHaveBeenCalled();
  });
});
