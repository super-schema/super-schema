// @vitest-environment node
/**
 * The glossary actions used to run as a hard-coded AUTHOR for ANY session user (a role-less or disabled one included). They now ask the policy
 * first: read = VIEWER in the active tenant, write = AUTHOR in the active tenant, link/unlink = AUTHOR over the field's own place; a refusal
 * never reaches the service.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, principalOf, roleless, signInAs, signedOut, tenantMember, T1, T2 } from "../../helpers/access-mocks";

const mocks = vi.hoisted(() => ({
  activeTenant: vi.fn(),
  service: {
    createConcept: vi.fn(),
    updateConcept: vi.fn(),
    deleteConcept: vi.fn(),
    getConcepts: vi.fn(),
    searchConcepts: vi.fn(),
    linkFieldToConcept: vi.fn(),
    unlinkFieldFromConcept: vi.fn(),
    suggestConceptsForField: vi.fn(),
  },
  prisma: { field: { findUnique: vi.fn() } },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: mocks.activeTenant }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).principalModule);
vi.mock("@/services/business-concept.service", () => mocks.service);

import * as glossary from "@/app/(dashboard)/glossary/actions";

const fieldIn = (tenantId: string, domainId: string | null = null) => ({ entity: { tenantId, domainId, productId: null, product: null } });
const okResult = { success: true as const, data: { id: "c1" } };

/** Every action with the arguments that make it reach its service when allowed, and the service call to look for. */
const CALLS = [
  { name: "createConceptAction", run: () => glossary.createConceptAction({ name: "Customer" } as never), service: mocks.service.createConcept, level: "write" },
  { name: "updateConceptAction", run: () => glossary.updateConceptAction("c1", { name: "x" } as never), service: mocks.service.updateConcept, level: "write" },
  { name: "deleteConceptAction", run: () => glossary.deleteConceptAction("c1"), service: mocks.service.deleteConcept, level: "write" },
  { name: "getConceptsAction", run: () => glossary.getConceptsAction(), service: mocks.service.getConcepts, level: "read" },
  { name: "searchConceptsAction", run: () => glossary.searchConceptsAction("cust"), service: mocks.service.searchConcepts, level: "read" },
  { name: "suggestConceptsForFieldAction", run: () => glossary.suggestConceptsForFieldAction("email", "string"), service: mocks.service.suggestConceptsForField, level: "read" },
  { name: "linkFieldToConceptAction", run: () => glossary.linkFieldToConceptAction("f1", "c1"), service: mocks.service.linkFieldToConcept, level: "link" },
  { name: "unlinkFieldFromConceptAction", run: () => glossary.unlinkFieldFromConceptAction("f1", "c1"), service: mocks.service.unlinkFieldFromConcept, level: "link" },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.activeTenant.mockResolvedValue(T1);
  mocks.prisma.field.findUnique.mockResolvedValue(fieldIn(T1));
  for (const fn of Object.values(mocks.service)) fn.mockResolvedValue(okResult);
  signInAs(tenantMember("ADMIN", T1));
});

describe.each(CALLS)("$name", ({ run, service, level }) => {
  it("answers nobody signed in 'Not authenticated' and never reaches the service", async () => {
    signedOut();
    expect(await run()).toEqual({ error: "Not authenticated" });
    expect(service).not.toHaveBeenCalled();
  });

  it("refuses a user with no role at all, and the service is never reached", async () => {
    signInAs(roleless());
    mocks.activeTenant.mockRejectedValue(Object.assign(new Error("none"), { name: "NoTenantAccess", code: "NO_TENANT_ACCESS" }));
    expect(await run()).toEqual({ error: "Not found" });
    expect(service).not.toHaveBeenCalled();
  });

  it("refuses a user who holds no role in the tenant that is in view, whatever they hold elsewhere", async () => {
    signInAs(tenantMember("ADMIN", T1));
    mocks.activeTenant.mockResolvedValue(T2);
    mocks.prisma.field.findUnique.mockResolvedValue(fieldIn(T2));
    expect(await run()).toEqual({ error: "Not found" });
    expect(service).not.toHaveBeenCalled();
  });

  it("refuses a field of another tenant than the one in view, even for an administrator of both", async () => {
    if (level !== "link") return;
    signInAs(principalOf([assign.tenant("ADMIN", T1), assign.tenant("ADMIN", T2)]));
    mocks.activeTenant.mockResolvedValue(T2);
    mocks.prisma.field.findUnique.mockResolvedValue(fieldIn(T1));
    expect(await run()).toEqual({ error: "Not found" });
    expect(service).not.toHaveBeenCalled();
  });

  it(`${level === "read" ? "lets" : "does not let"} a VIEWER through`, async () => {
    signInAs(tenantMember("VIEWER", T1));
    const answer = await run();
    if (level === "read") {
      expect(answer).toMatchObject({ success: true });
      expect(service).toHaveBeenCalledTimes(1);
    } else {
      expect(answer).toEqual({ error: "You do not have permission to do this" });
      expect(service).not.toHaveBeenCalled();
    }
  });

  it("lets an AUTHOR through", async () => {
    signInAs(tenantMember("AUTHOR", T1));
    expect(await run()).toMatchObject({ success: true });
    expect(service).toHaveBeenCalledTimes(1);
  });

  it("hands the service a context that carries the principal's assignments", async () => {
    const principal = tenantMember("AUTHOR", T1, "u-7");
    signInAs(principal);
    await run();
    const ctx = service.mock.calls[0].find((arg: unknown) => typeof arg === "object" && arg !== null && "userId" in arg) as { userId: string; userRole: string; assignments: unknown };
    expect(ctx).toMatchObject({ userId: "u-7", userRole: "VIEWER", assignments: principal.assignments });
  });
});

describe("linking a field is judged over the field's own place", () => {
  it("a domain-scoped AUTHOR links a field of their domain and not one of a sibling domain", async () => {
    signInAs(principalOf([assign.domain("AUTHOR", T1, "dom-a")]));
    mocks.prisma.field.findUnique.mockResolvedValue(fieldIn(T1, "dom-a"));
    expect(await glossary.linkFieldToConceptAction("f1", "c1")).toMatchObject({ success: true });
    mocks.prisma.field.findUnique.mockResolvedValue(fieldIn(T1, "dom-b"));
    expect(await glossary.linkFieldToConceptAction("f1", "c1")).toEqual({ error: "Not found" });
    expect(mocks.service.linkFieldToConcept).toHaveBeenCalledTimes(1);
  });

  it("a field that does not exist is the same answer as a field of a sibling domain", async () => {
    signInAs(principalOf([assign.domain("AUTHOR", T1, "dom-a")]));
    mocks.prisma.field.findUnique.mockResolvedValueOnce(fieldIn(T1, "dom-b"));
    const unseen = await glossary.unlinkFieldFromConceptAction("f1", "c1");
    mocks.prisma.field.findUnique.mockResolvedValueOnce(null);
    expect(await glossary.unlinkFieldFromConceptAction("f1", "c1")).toEqual(unseen);
  });
});
