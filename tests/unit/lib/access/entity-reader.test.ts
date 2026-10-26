// @vitest-environment node
/**
 * `entityReader(assignments)`: the question the reference closure asks of every entity it is about to read (KD-045), answered by the policy
 * (`entity.read` over the entity's own place). A role that covers the entity reads it; nothing else does.
 */
import { describe, expect, it } from "vitest";
import { entityReader } from "@/lib/access";
import { assign } from "../../../helpers/access-mocks";

const T = "t1";
const place = (domainId: string | null, productId: string | null = null, tenantId = T) => ({ tenantId, domainId, productId });

describe("entityReader", () => {
  it("a domain-scoped author reads its own domain, its products and nothing else", () => {
    const read = entityReader([assign.domain("AUTHOR", T, "d1")]);
    expect(read(place("d1"))).toBe(true);
    expect(read(place("d1", "p1"))).toBe(true);
    expect(read(place("d2"))).toBe(false);
    expect(read(place("d2", "p9"))).toBe(false);
    // a tenant-level entity is covered by tenant and global roles only
    expect(read(place(null))).toBe(false);
  });

  it("a product-scoped role reads that product only", () => {
    const read = entityReader([assign.product("VIEWER", T, "d1", "p1")]);
    expect(read(place("d1", "p1"))).toBe(true);
    expect(read(place("d1", "p2"))).toBe(false);
    expect(read(place("d1"))).toBe(false);
  });

  it("a tenant role reads every entity of its tenant, tenant-level ones included, and never another tenant's", () => {
    const read = entityReader([assign.tenant("VIEWER", T)]);
    expect(read(place("d1"))).toBe(true);
    expect(read(place("d2", "p2"))).toBe(true);
    expect(read(place(null))).toBe(true);
    expect(read(place("d1", null, "t2"))).toBe(false);
  });

  it("a platform administrator reads everything", () => {
    const read = entityReader([assign.global()]);
    expect(read(place("d1"))).toBe(true);
    expect(read(place(null, null, "t2"))).toBe(true);
  });

  it("no assignment, and a missing assignment list, read nothing (never everything)", () => {
    expect(entityReader([])(place("d1"))).toBe(false);
    expect(entityReader(undefined)(place("d1"))).toBe(false);
    expect(entityReader(undefined)(place(null))).toBe(false);
  });

  it("the lowest role is enough to read: read is judged by the covering role, not by what else the role may do", () => {
    for (const role of ["VIEWER", "AUTHOR", "STEWARD", "COMPLIANCE_OFFICER", "ADMIN"] as const) {
      expect(entityReader([assign.domain(role, T, "d1")])(place("d1"))).toBe(true);
    }
  });

  it("answers false for a malformed place instead of throwing", () => {
    const read = entityReader([assign.global()]);
    expect(read({ tenantId: "", domainId: null, productId: null })).toBe(false);
    expect(read(null as never)).toBe(false);
  });
});
