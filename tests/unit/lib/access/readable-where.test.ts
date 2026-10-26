// @vitest-environment node
/**
 * `readableWhere` (src/lib/access/visibility.ts): the `where` fragment that restricts a tenant-wide query to the rows the caller may read for an
 * action: nothing added for a tenant or platform role, the rows under the domains and products their narrower roles cover otherwise (an empty
 * `in` matches no row, so a caller with nothing reading nothing is a restriction too, never "everything").
 */
import { describe, expect, it } from "vitest";
import { readableWhere } from "@/lib/access";
import { assign } from "../../../helpers/access-mocks";

describe("readableWhere", () => {
  it("a tenant or platform role adds nothing: every row of the tenant", () => {
    expect(readableWhere([assign.tenant("VIEWER", "t1")], "entity.read", "t1")).toEqual({});
    expect(readableWhere([assign.global()], "entity.read", "t1")).toEqual({});
  });

  it("a domain role and a product role restrict to the rows under their domain / product (both columns, an OR)", () => {
    expect(readableWhere([assign.domain("VIEWER", "t1", "d1"), assign.product("AUTHOR", "t1", "d2", "p9")], "entity.read", "t1")).toEqual({
      OR: [{ domainId: { in: ["d1"] } }, { productId: { in: ["p9"] } }],
    });
  });

  it("a role that is too low for the action contributes nothing, and a caller that reaches nothing gets the restriction that matches no row", () => {
    expect(readableWhere([assign.domain("VIEWER", "t1", "d1")], "entity.write", "t1")).toEqual({ OR: [{ domainId: { in: [] } }, { productId: { in: [] } }] });
    expect(readableWhere([], "entity.read", "t1")).toEqual({ OR: [{ domainId: { in: [] } }, { productId: { in: [] } }] });
  });

  it("another tenant's roles contribute nothing here", () => {
    expect(readableWhere([assign.tenant("ADMIN", "t2"), assign.domain("ADMIN", "t2", "dX")], "entity.read", "t1")).toEqual({ OR: [{ domainId: { in: [] } }, { productId: { in: [] } }] });
  });

  it("is a fresh object each call (a caller may add keys to it)", () => {
    const a = readableWhere([assign.tenant("VIEWER", "t1")], "entity.read", "t1");
    const b = readableWhere([assign.tenant("VIEWER", "t1")], "entity.read", "t1");
    expect(a).not.toBe(b);
  });
});
