// @vitest-environment node
/**
 * What of the domain / product structure a principal may LIST (navigation): every assignment scope counts (tenant, domain, product), a
 * PRODUCT-scoped role lists its own product and the domain above it as the way there, and nothing beyond: no sibling domain, no sibling product,
 * no other tenant. These answers are for reads of the structure only; a write is still judged by `can` over the row.
 */
import { describe, expect, it } from "vitest";
import { assign } from "../../../helpers/access-mocks";
import { canListDomain, canListProduct, productScopesIn, seesWholeDomain, type Assignment } from "@/lib/access";

const T = "tenant-1";
const dom = (domainId: string, tenantId = T) => ({ tenantId, domainId });
const prod = (domainId: string, productId: string, tenantId = T) => ({ tenantId, domainId, productId });

describe("canListDomain", () => {
  it("a tenant or global role lists every domain of the tenant (global: of every tenant)", () => {
    expect(canListDomain([assign.tenant("VIEWER", T)], dom("d1"))).toBe(true);
    expect(canListDomain([assign.tenant("VIEWER", T)], dom("d1", "tenant-2"))).toBe(false);
    expect(canListDomain([assign.global()], dom("d1", "tenant-2"))).toBe(true);
  });

  it("a domain role lists its domain and not a sibling", () => {
    const a = [assign.domain("VIEWER", T, "d1")];
    expect(canListDomain(a, dom("d1"))).toBe(true);
    expect(canListDomain(a, dom("d2"))).toBe(false);
  });

  it("a PRODUCT role lists the domain of its product (the way to it) and not a sibling domain nor another tenant's domain of the same id", () => {
    const a = [assign.product("VIEWER", T, "d1", "p1")];
    expect(canListDomain(a, dom("d1"))).toBe(true);
    expect(canListDomain(a, dom("d2"))).toBe(false);
    expect(canListDomain(a, dom("d1", "tenant-2"))).toBe(false);
  });

  it("a role of no assignment, junk and malformed entries list nothing", () => {
    expect(canListDomain([], dom("d1"))).toBe(false);
    expect(canListDomain([{ role: "ADMIN", scope: { kind: "PRODUCT", tenantId: T, domainId: "d1" } } as unknown as Assignment], dom("d1"))).toBe(false);
    expect(canListDomain("nope" as never, dom("d1"))).toBe(false);
  });
});

describe("canListProduct", () => {
  it("lists the product of a product role, not its sibling; a domain or tenant role lists every product under it", () => {
    const a = [assign.product("VIEWER", T, "d1", "p1")];
    expect(canListProduct(a, prod("d1", "p1"))).toBe(true);
    expect(canListProduct(a, prod("d1", "p2"))).toBe(false);
    expect(canListProduct([assign.domain("VIEWER", T, "d1")], prod("d1", "p2"))).toBe(true);
    expect(canListProduct([assign.domain("VIEWER", T, "d1")], prod("d2", "p9"))).toBe(false);
    expect(canListProduct([assign.tenant("VIEWER", T)], prod("d3", "p9"))).toBe(true);
  });
});

describe("seesWholeDomain and productScopesIn", () => {
  it("a product role sees only parts of the domain; a domain or tenant role sees all of it", () => {
    const a = [assign.product("AUTHOR", T, "d1", "p1"), assign.product("VIEWER", T, "d1", "p2"), assign.product("VIEWER", "tenant-2", "d1", "p3")];
    expect(seesWholeDomain(a, dom("d1"))).toBe(false);
    expect(productScopesIn(a, T)).toEqual([
      { domainId: "d1", productId: "p1" },
      { domainId: "d1", productId: "p2" },
    ]);
    expect(seesWholeDomain([assign.domain("VIEWER", T, "d1")], dom("d1"))).toBe(true);
    expect(seesWholeDomain([assign.tenant("VIEWER", T)], dom("d1"))).toBe(true);
  });
});
