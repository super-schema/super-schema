import { describe, expect, it } from "vitest";
import { assign, roleRowOf } from "../../../helpers/access-mocks";
import { assignmentFromRow, assignmentsFromRows } from "@/lib/access/assignments";
import { contextRole, effectiveRole, globalRole } from "@/lib/access";

describe("assignmentFromRow (a stored user_roles row -> an assignment, from its columns)", () => {
  it.each([
    ["global", assign.global()],
    ["tenant", assign.tenant("VIEWER", "t1")],
    ["domain", assign.domain("AUTHOR", "t1", "d1")],
    ["product", assign.product("STEWARD", "t1", "d1", "p1")],
  ])("builds the %s scope from the columns, the key agreeing", (_name, assignment) => {
    expect(assignmentFromRow(roleRowOf(assignment))).toEqual(assignment);
  });

  it("treats absent id columns as null (a row selected without them)", () => {
    expect(assignmentFromRow({ role: "ADMIN", scopeKey: "G" })).toEqual(assign.global());
  });

  it.each([
    ["an unknown role", { ...roleRowOf(assign.tenant("VIEWER", "t1")), role: "ROOT" }],
    ["GLOBAL for a role other than ADMIN", roleRowOf(assign.global("AUTHOR"))],
    ["a key that is not a scope key", { role: "ADMIN", scopeKey: "X:1", tenantId: "t1", domainId: null, productId: null }],
    ["an empty key", { role: "ADMIN", scopeKey: "", tenantId: null, domainId: null, productId: null }],
    ["a tenant key whose column names another tenant", { role: "VIEWER", scopeKey: "T:t1", tenantId: "t2", domainId: null, productId: null }],
    ["a tenant key with a stray domain column", { role: "VIEWER", scopeKey: "T:t1", tenantId: "t1", domainId: "d1", productId: null }],
    ["a domain key whose column names another domain", { role: "VIEWER", scopeKey: "D:d1", tenantId: "t1", domainId: "d2", productId: null }],
    ["a domain key without its tenant", { role: "VIEWER", scopeKey: "D:d1", tenantId: null, domainId: "d1", productId: null }],
    ["a product key without its domain", { role: "VIEWER", scopeKey: "P:p1", tenantId: "t1", domainId: null, productId: "p1" }],
    ["a global key with a tenant column", { role: "ADMIN", scopeKey: "G", tenantId: "t1", domainId: null, productId: null }],
    ["a non-string role", { role: 5, scopeKey: "G" }],
    ["null", null],
    ["a string", "ADMIN"],
  ])("refuses %s", (_name, row) => {
    expect(assignmentFromRow(row as never)).toBeNull();
  });

  it("assignmentsFromRows keeps the valid rows in order and drops the rest, never throwing on a non-array", () => {
    const rows = [roleRowOf(assign.tenant("VIEWER", "t1")), { role: "ROOT", scopeKey: "G" }, roleRowOf(assign.global())];
    expect(assignmentsFromRows(rows)).toEqual([assign.tenant("VIEWER", "t1"), assign.global()]);
    for (const bad of [null, undefined, "x", 5, {}]) expect(assignmentsFromRows(bad as never)).toEqual([]);
  });
});

describe("globalRole / contextRole (the role a legacy service still reads from ctx.userRole)", () => {
  const mixed = [assign.tenant("AUTHOR", "t1"), assign.domain("STEWARD", "t1", "d1"), assign.global()];

  it("globalRole is the best role held at GLOBAL scope only, else null", () => {
    expect(globalRole(mixed)).toBe("ADMIN");
    expect(globalRole([assign.tenant("ADMIN", "t1")])).toBeNull();
    expect(globalRole([])).toBeNull();
    expect(globalRole(null as never)).toBeNull();
  });

  it("contextRole over a resource is the effective role there, and falls to the lowest rung when none applies (fails closed)", () => {
    const resource = { tenantId: "t1", domainId: "d1" };
    expect(contextRole([assign.tenant("AUTHOR", "t1"), assign.domain("STEWARD", "t1", "d1")], resource)).toBe("STEWARD");
    expect(contextRole([assign.tenant("AUTHOR", "t1")], resource)).toBe(effectiveRole([assign.tenant("AUTHOR", "t1")], resource));
    expect(contextRole([assign.tenant("AUTHOR", "t2")], resource)).toBe("VIEWER");
    expect(contextRole([], resource)).toBe("VIEWER");
  });

  it("contextRole with no resource is the global role, else the lowest rung", () => {
    expect(contextRole(mixed)).toBe("ADMIN");
    expect(contextRole([assign.tenant("ADMIN", "t1")])).toBe("VIEWER");
  });
});
