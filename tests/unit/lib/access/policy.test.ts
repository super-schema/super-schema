import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  can,
  covers,
  effectiveRole,
  grantAllowed,
  isActionId,
  isValidAssignment,
  parseScopeKey,
  roleAtLeast,
  scopeContains,
  scopeKey,
  type ActionId,
  type Assignment,
  type ResourceRef,
  type Scope,
} from "@/lib/access";
import { ROLE_HIERARCHY, type Role } from "@/types/schemas/rbac";

// ---------------------------------------------------------------------------
// Fixtures: one tenant tree and a second tenant. Every expectation below is written by hand from the
// spec (docs/superpowers/specs/2026-10-24-access-control-design.md, decisions 2-5), never computed by
// the code under test.
// ---------------------------------------------------------------------------

const T1 = "tenant-1";
const T2 = "tenant-2";
const D1 = "domain-1";
const D2 = "domain-2";
const P1 = "product-1";
const P2 = "product-2";

const SCOPES = {
  GLOBAL: { kind: "GLOBAL" },
  T1: { kind: "TENANT", tenantId: T1 },
  T2: { kind: "TENANT", tenantId: T2 },
  D1: { kind: "DOMAIN", tenantId: T1, domainId: D1 },
  D2: { kind: "DOMAIN", tenantId: T1, domainId: D2 },
  P1: { kind: "PRODUCT", tenantId: T1, domainId: D1, productId: P1 },
  P2: { kind: "PRODUCT", tenantId: T1, domainId: D1, productId: P2 },
  // The same domain id under another tenant: ids are unique in the database, but the policy must not rely on it.
  D1_IN_T2: { kind: "DOMAIN", tenantId: T2, domainId: D1 },
} as const satisfies Record<string, Scope>;
type ScopeName = keyof typeof SCOPES;
const SCOPE_NAMES = Object.keys(SCOPES) as ScopeName[];

const RESOURCES = {
  /** A product of domain D1 (entities and events live here). */
  PRODUCT: { tenantId: T1, domainId: D1, productId: P1 },
  /** A domain-level asset of D1 (no product). */
  DOMAIN: { tenantId: T1, domainId: D1 },
  /** A domain-level asset of the sibling domain D2. */
  SIBLING_DOMAIN: { tenantId: T1, domainId: D2 },
  /** A tenant-level (enterprise) asset: no domain, no product. */
  TENANT: { tenantId: T1 },
  /** Something of the other tenant. */
  FOREIGN: { tenantId: T2, domainId: "domain-9" },
} as const satisfies Record<string, ResourceRef>;
type ResourceName = keyof typeof RESOURCES;
const RESOURCE_NAMES = Object.keys(RESOURCES) as ResourceName[];

/** Which assignment scope covers which resource (the containment tree of decision 2), written out as a table. */
const COVERS: Record<ScopeName, Record<ResourceName, boolean>> = {
  GLOBAL: { PRODUCT: true, DOMAIN: true, SIBLING_DOMAIN: true, TENANT: true, FOREIGN: true },
  T1: { PRODUCT: true, DOMAIN: true, SIBLING_DOMAIN: true, TENANT: true, FOREIGN: false },
  T2: { PRODUCT: false, DOMAIN: false, SIBLING_DOMAIN: false, TENANT: false, FOREIGN: true },
  D1: { PRODUCT: true, DOMAIN: true, SIBLING_DOMAIN: false, TENANT: false, FOREIGN: false },
  D2: { PRODUCT: false, DOMAIN: false, SIBLING_DOMAIN: true, TENANT: false, FOREIGN: false },
  P1: { PRODUCT: true, DOMAIN: false, SIBLING_DOMAIN: false, TENANT: false, FOREIGN: false },
  P2: { PRODUCT: false, DOMAIN: false, SIBLING_DOMAIN: false, TENANT: false, FOREIGN: false },
  D1_IN_T2: { PRODUCT: false, DOMAIN: false, SIBLING_DOMAIN: false, TENANT: false, FOREIGN: false },
};

/** The tenant each assignment scope lives in (GLOBAL: none, it is the platform). */
const SCOPE_TENANT: Record<ScopeName, string | null> = { GLOBAL: null, T1, T2, D1: T1, D2: T1, P1: T1, P2: T1, D1_IN_T2: T2 };
const RESOURCE_TENANT: Record<ResourceName, string> = { PRODUCT: T1, DOMAIN: T1, SIBLING_DOMAIN: T1, TENANT: T1, FOREIGN: T2 };

const a = (role: Role, scope: ScopeName): Assignment => ({ role, scope: SCOPES[scope] });
const rank = (role: Role) => ROLE_HIERARCHY.indexOf(role);

/** Freezes a structure all the way down: a policy function that wrote to its input would throw in strict mode. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// ---------------------------------------------------------------------------
// The action table: a snapshot of every id with its minimum role and level, so a change is deliberate.
// ---------------------------------------------------------------------------

type Level = "resource" | "tenant" | "anywhere" | "global" | "self";
const EXPECTED_ACTIONS: ReadonlyArray<readonly [string, Role | null, Level]> = [
  // Reads of content: VIEWER, at the covering scope
  ["entity.read", "VIEWER", "resource"],
  ["domain.read", "VIEWER", "resource"],
  ["asset.read", "VIEWER", "resource"],
  ["event.read", "VIEWER", "resource"],
  ["trait.read", "VIEWER", "resource"],
  ["deploy.read", "VIEWER", "resource"],
  ["governance.read", "VIEWER", "resource"],
  ["usage.read", "VIEWER", "resource"],
  ["annotation.read", "VIEWER", "resource"],
  // Reference data and tenant membership: any role anywhere in the tenant
  ["glossary.read", "VIEWER", "anywhere"],
  ["reference.read", "VIEWER", "anywhere"],
  ["tenant.access", "VIEWER", "anywhere"],
  // Authoring: AUTHOR
  ["entity.write", "AUTHOR", "resource"],
  ["schema.generate", "AUTHOR", "resource"],
  ["asset.write", "AUTHOR", "resource"],
  ["import.run", "AUTHOR", "resource"],
  ["event.write", "AUTHOR", "resource"],
  ["event.pin", "AUTHOR", "resource"],
  ["trait.write", "AUTHOR", "resource"],
  ["typemapping.entity", "AUTHOR", "resource"],
  ["glossary.link", "AUTHOR", "resource"],
  ["glossary.write", "AUTHOR", "anywhere"],
  ["ai.generate", "AUTHOR", "resource"],
  ["annotation.write", "AUTHOR", "resource"],
  // Release and structure: STEWARD
  ["entity.publish", "STEWARD", "resource"],
  ["entity.lifecycle", "STEWARD", "resource"],
  ["event.publish", "STEWARD", "resource"],
  ["deploy.run", "STEWARD", "resource"],
  ["governance.decide", "STEWARD", "resource"],
  ["retention.write", "STEWARD", "resource"],
  ["product.create", "STEWARD", "resource"],
  ["product.update", "STEWARD", "resource"],
  ["domain.update", "STEWARD", "resource"],
  ["domain.create", "STEWARD", "tenant"],
  // Compliance: COMPLIANCE_OFFICER
  ["compliance.query", "COMPLIANCE_OFFICER", "resource"],
  ["compliance.gaps", "COMPLIANCE_OFFICER", "resource"],
  ["compliance.audit", "COMPLIANCE_OFFICER", "tenant"],
  ["compliance.export", "COMPLIANCE_OFFICER", "tenant"],
  // Administration: ADMIN
  ["role.assign", "ADMIN", "resource"],
  ["annotation.moderate", "ADMIN", "resource"],
  ["domain.delete", "ADMIN", "tenant"],
  ["product.delete", "ADMIN", "tenant"],
  ["user.manage", "ADMIN", "tenant"],
  ["tenant.admin", "ADMIN", "tenant"],
  ["platform.admin", "ADMIN", "global"],
  ["emitter.manage", "ADMIN", "global"],
  ["git.manage", "ADMIN", "global"],
  ["classification.manage", "ADMIN", "global"],
  ["tenant.create", "ADMIN", "global"],
  // A global override reaches every tenant (no tenant column): ADMIN at the platform, not the STEWARD of the design table (Task 5b ruling)
  ["typemapping.global", "ADMIN", "global"],
  // The principal's own data: any active principal, role or not
  ["notification.own", null, "self"],
  ["profile.own", null, "self"],
];

describe("ACTIONS (the action table, single source)", () => {
  it("matches the spec table: every id, its minimum role and its level (a change here is deliberate)", () => {
    const actual = Object.entries(ACTIONS).map(([id, spec]) => [id, spec.minRole, spec.level] as const);
    expect(actual).toEqual(EXPECTED_ACTIONS);
  });

  it("has dotted lower-case ids, each unique", () => {
    const ids = Object.keys(ACTIONS);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]+\.[a-z]+$/);
  });

  it("is internally consistent: self carries no role, global needs ADMIN (the only valid global role), the rest name a real role", () => {
    for (const [id, spec] of Object.entries(ACTIONS)) {
      if (spec.level === "self") expect(spec.minRole, id).toBeNull();
      else expect(ROLE_HIERARCHY, id).toContain(spec.minRole);
      if (spec.level === "global") expect(spec.minRole, id).toBe("ADMIN");
    }
  });

  it("is frozen: nothing can loosen a rule at runtime", () => {
    expect(Object.isFrozen(ACTIONS)).toBe(true);
    for (const spec of Object.values(ACTIONS)) expect(Object.isFrozen(spec)).toBe(true);
  });

  it("follows the spec's decision 4 group by group", () => {
    const spec = ACTIONS as Record<string, { minRole: Role | null; level: Level }>;
    // read/list/get content: VIEWER
    for (const id of ["entity.read", "domain.read", "asset.read", "event.read", "trait.read", "deploy.read", "governance.read", "usage.read"]) {
      expect(spec[id].minRole, id).toBe("VIEWER");
    }
    // create/edit/delete entities, fields, schema generation, imports, domain assets, events, traits, pins, glossary edit: AUTHOR
    for (const id of ["entity.write", "schema.generate", "import.run", "asset.write", "event.write", "trait.write", "event.pin", "glossary.write"]) {
      expect(spec[id].minRole, id).toBe("AUTHOR");
    }
    // publish, deploy, mark deployed, deprecate/retire, governance approve/reject, retention policy edit, global type-mapping override, create product, create domain: STEWARD
    // (the global type-mapping override is NOT here: the design says STEWARD, but the override table has no tenant column, so it changes every tenant's
    // mapping and the Task 5b review ruling made it a platform administrator's act: ADMIN, global level, pinned in the snapshot above)
    for (const id of ["entity.publish", "event.publish", "deploy.run", "entity.lifecycle", "governance.decide", "retention.write", "product.create", "domain.create"]) {
      expect(spec[id].minRole, id).toBe("STEWARD");
    }
    expect(spec["typemapping.global"]).toEqual({ minRole: "ADMIN", level: "global" });
    // create domain is decided at tenant scope
    expect(spec["domain.create"].level).toBe("tenant");
    // compliance Query/Gaps/Audit/export: COMPLIANCE_OFFICER
    for (const id of ["compliance.query", "compliance.gaps", "compliance.audit", "compliance.export"]) {
      expect(spec[id].minRole, id).toBe("COMPLIANCE_OFFICER");
    }
    // delete domain/product, user and role management for the tenant, tenant settings: tenant ADMIN
    for (const id of ["domain.delete", "product.delete", "user.manage", "tenant.admin"]) {
      expect(spec[id], id).toEqual({ minRole: "ADMIN", level: "tenant" });
    }
    // platform items (emitter configs, health, git configuration, classification taxonomy, tenant creation): global ADMIN
    for (const id of ["emitter.manage", "platform.admin", "git.manage", "classification.manage", "tenant.create"]) {
      expect(spec[id], id).toEqual({ minRole: "ADMIN", level: "global" });
    }
    // notifications and the user's own profile: any active principal
    for (const id of ["notification.own", "profile.own"]) expect(spec[id], id).toEqual({ minRole: null, level: "self" });
  });

  it("isActionId accepts exactly the table's own keys", () => {
    expect(isActionId("entity.read")).toBe(true);
    for (const bad of ["", "entity", "entity.unknown", "ENTITY.READ", "constructor", "__proto__", "toString", "hasOwnProperty", 5, null, undefined, {}, []]) {
      expect(isActionId(bad as unknown), String(bad)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// scope.ts
// ---------------------------------------------------------------------------

describe("scopeKey / parseScopeKey", () => {
  it("writes the key format of the spec: G, T:<id>, D:<id>, P:<id>", () => {
    expect(scopeKey(SCOPES.GLOBAL)).toBe("G");
    expect(scopeKey(SCOPES.T1)).toBe("T:tenant-1");
    expect(scopeKey(SCOPES.D1)).toBe("D:domain-1");
    expect(scopeKey(SCOPES.P1)).toBe("P:product-1");
  });

  it("parses each key back to the part it carries (a domain or product key does not name its parents)", () => {
    expect(parseScopeKey("G")).toEqual({ kind: "GLOBAL" });
    expect(parseScopeKey("T:tenant-1")).toEqual({ kind: "TENANT", tenantId: "tenant-1" });
    expect(parseScopeKey("D:domain-1")).toEqual({ kind: "DOMAIN", domainId: "domain-1" });
    expect(parseScopeKey("P:product-1")).toEqual({ kind: "PRODUCT", productId: "product-1" });
  });

  it("round-trips every scope: kind and own id survive scopeKey -> parseScopeKey", () => {
    for (const name of SCOPE_NAMES) {
      const scope = SCOPES[name];
      const parsed = parseScopeKey(scopeKey(scope));
      expect(parsed, name).toBeDefined();
      expect(parsed?.kind, name).toBe(scope.kind);
      if (scope.kind === "TENANT") expect(parsed).toMatchObject({ tenantId: scope.tenantId });
      if (scope.kind === "DOMAIN") expect(parsed).toMatchObject({ domainId: scope.domainId });
      if (scope.kind === "PRODUCT") expect(parsed).toMatchObject({ productId: scope.productId });
    }
  });

  it("refuses a malformed key (undefined) without throwing", () => {
    const bad: unknown[] = [
      "", " ", "g", "G:", "G:x", "T", "T:", "T:a:b", "X:1", "TENANT:a", " T:a", "T:a ", "T:a b", "T:a\nb", "T:a\u0000b", "D:", "P:", ":a",
      "T:" + "a".repeat(129), "T:" + "a".repeat(100_000), "__proto__", "constructor", 5, null, undefined, {}, [], ["G"], Symbol("G"),
    ];
    for (const key of bad) {
      expect(() => parseScopeKey(key as string), String(key).slice(0, 20)).not.toThrow();
      expect(parseScopeKey(key as string), String(key).slice(0, 20)).toBeUndefined();
    }
  });

  it("accepts an id of exactly 128 characters and refuses 129", () => {
    expect(parseScopeKey("T:" + "a".repeat(128))).toEqual({ kind: "TENANT", tenantId: "a".repeat(128) });
    expect(parseScopeKey("T:" + "a".repeat(129))).toBeUndefined();
  });

  it("scopeKey answers an empty string (which parseScopeKey refuses) for a malformed scope, and never throws", () => {
    const bad: unknown[] = [
      null, undefined, 5, "G", {}, { kind: "NOPE" }, { kind: "TENANT" }, { kind: "TENANT", tenantId: "" }, { kind: "TENANT", tenantId: 5 },
      { kind: "TENANT", tenantId: "a:b" }, { kind: "DOMAIN", tenantId: T1 }, { kind: "DOMAIN", domainId: D1 }, { kind: "PRODUCT", tenantId: T1, domainId: D1 },
      { kind: "TENANT", tenantId: "a".repeat(129) },
    ];
    for (const scope of bad) {
      expect(() => scopeKey(scope as Scope)).not.toThrow();
      expect(scopeKey(scope as Scope)).toBe("");
    }
  });
});

describe("covers (containment: global > tenant > domain > product > entity)", () => {
  for (const scopeName of SCOPE_NAMES) {
    for (const resourceName of RESOURCE_NAMES) {
      const expected = COVERS[scopeName][resourceName];
      it(`${scopeName} ${expected ? "covers" : "does not cover"} ${resourceName}`, () => {
        expect(covers(SCOPES[scopeName], RESOURCES[resourceName])).toBe(expected);
      });
    }
  }

  it("treats null and undefined domain / product the same (a tenant-level resource)", () => {
    expect(covers(SCOPES.D1, { tenantId: T1, domainId: null, productId: null })).toBe(false);
    expect(covers(SCOPES.T1, { tenantId: T1, domainId: null, productId: null })).toBe(true);
  });

  it("does not let a product scope cover a resource that names the product but not its domain", () => {
    expect(covers(SCOPES.P1, { tenantId: T1, productId: P1 })).toBe(false);
    expect(covers(SCOPES.P1, { tenantId: T1, domainId: D2, productId: P1 })).toBe(false);
  });

  it("refuses a malformed scope or resource without throwing", () => {
    const badScopes: unknown[] = [null, undefined, "G", 5, {}, { kind: "TENANT" }, { kind: "TENANT", tenantId: "" }, { kind: "DOMAIN", tenantId: T1 }];
    for (const scope of badScopes) expect(covers(scope as Scope, RESOURCES.PRODUCT)).toBe(false);
    const badResources: unknown[] = [null, undefined, "t", 5, {}, { tenantId: "" }, { tenantId: 5 }, { tenantId: T1, domainId: 5 }, { tenantId: T1, productId: {} }];
    for (const resource of badResources) {
      for (const name of SCOPE_NAMES) {
        expect(() => covers(SCOPES[name], resource as ResourceRef)).not.toThrow();
        expect(covers(SCOPES[name], resource as ResourceRef), `${name} ${JSON.stringify(resource)}`).toBe(false);
      }
    }
  });
});

describe("scopeContains (a scope inside another scope, for granting)", () => {
  const cases: Array<[ScopeName, ScopeName, boolean]> = [
    ["GLOBAL", "GLOBAL", true], ["GLOBAL", "T1", true], ["GLOBAL", "T2", true], ["GLOBAL", "D1", true], ["GLOBAL", "P1", true],
    ["T1", "GLOBAL", false], ["T1", "T1", true], ["T1", "T2", false], ["T1", "D1", true], ["T1", "D2", true], ["T1", "P1", true], ["T1", "D1_IN_T2", false],
    ["D1", "GLOBAL", false], ["D1", "T1", false], ["D1", "D1", true], ["D1", "D2", false], ["D1", "P1", true], ["D1", "P2", true], ["D1", "D1_IN_T2", false],
    ["D2", "P1", false],
    ["P1", "GLOBAL", false], ["P1", "T1", false], ["P1", "D1", false], ["P1", "P1", true], ["P1", "P2", false],
    ["T2", "T1", false], ["T2", "D1_IN_T2", true], ["D1_IN_T2", "D1", false],
  ];
  it.each(cases)("%s contains %s: %s", (outer, inner, expected) => {
    expect(scopeContains(SCOPES[outer], SCOPES[inner])).toBe(expected);
  });

  it("refuses malformed scopes without throwing", () => {
    for (const bad of [null, undefined, {}, "G", { kind: "TENANT" }]) {
      expect(scopeContains(bad as Scope, SCOPES.T1)).toBe(false);
      expect(scopeContains(SCOPES.GLOBAL, bad as Scope)).toBe(false);
    }
  });
});

describe("isValidAssignment (GLOBAL is only for ADMIN; any role at any other scope)", () => {
  it("allows every role at tenant, domain and product scope (COMPLIANCE_OFFICER and ADMIN too: decision 3)", () => {
    for (const role of ROLE_HIERARCHY) {
      for (const name of ["T1", "D1", "P1"] as const) expect(isValidAssignment(role, SCOPES[name]), `${role} ${name}`).toBe(true);
    }
  });

  it("allows GLOBAL only for ADMIN", () => {
    expect(isValidAssignment("ADMIN", SCOPES.GLOBAL)).toBe(true);
    for (const role of ROLE_HIERARCHY.filter((r) => r !== "ADMIN")) expect(isValidAssignment(role, SCOPES.GLOBAL), role).toBe(false);
  });

  it("rejects an unknown role and a malformed scope without throwing", () => {
    for (const role of ["SUPERUSER", "admin", "", null, undefined, 5, {}]) {
      expect(isValidAssignment(role as Role, SCOPES.T1), String(role)).toBe(false);
    }
    const badScopes: unknown[] = [
      null, undefined, "G", {}, { kind: "NOPE" }, { kind: "TENANT" }, { kind: "TENANT", tenantId: "" }, { kind: "DOMAIN", tenantId: T1 }, { kind: "DOMAIN", domainId: D1 },
      { kind: "PRODUCT", tenantId: T1, domainId: D1 }, { kind: "TENANT", tenantId: "has space" }, { kind: "TENANT", tenantId: "a:b" }, { kind: "TENANT", tenantId: "a".repeat(129) },
    ];
    for (const scope of badScopes) {
      expect(() => isValidAssignment("ADMIN", scope as Scope)).not.toThrow();
      expect(isValidAssignment("ADMIN", scope as Scope), JSON.stringify(scope)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// policy.ts
// ---------------------------------------------------------------------------

describe("roleAtLeast", () => {
  it("orders the ladder VIEWER < AUTHOR < STEWARD < COMPLIANCE_OFFICER < ADMIN and treats no role as below all", () => {
    expect(roleAtLeast("ADMIN", "VIEWER")).toBe(true);
    expect(roleAtLeast("VIEWER", "VIEWER")).toBe(true);
    expect(roleAtLeast("AUTHOR", "STEWARD")).toBe(false);
    expect(roleAtLeast("COMPLIANCE_OFFICER", "STEWARD")).toBe(true);
    expect(roleAtLeast(null, "VIEWER")).toBe(false);
    expect(roleAtLeast("SUPERUSER" as Role, "VIEWER")).toBe(false);
  });
});

describe("effectiveRole (the highest role among assignments whose scope contains the resource)", () => {
  it("is null for no assignment, whatever the resource", () => {
    for (const name of RESOURCE_NAMES) expect(effectiveRole([], RESOURCES[name]), name).toBeNull();
  });

  it("is the single covering assignment's role, per the containment table", () => {
    for (const scopeName of SCOPE_NAMES) {
      for (const resourceName of RESOURCE_NAMES) {
        const role: Role = scopeName === "GLOBAL" ? "ADMIN" : "AUTHOR";
        const expected = COVERS[scopeName][resourceName] ? role : null;
        expect(effectiveRole([a(role, scopeName)], RESOURCES[resourceName]), `${scopeName} -> ${resourceName}`).toBe(expected);
      }
    }
  });

  it("takes the maximum over the covering assignments only", () => {
    const assignments = [a("VIEWER", "T1"), a("AUTHOR", "D1"), a("STEWARD", "P1"), a("ADMIN", "D2"), a("COMPLIANCE_OFFICER", "T2")];
    expect(effectiveRole(assignments, RESOURCES.PRODUCT)).toBe("STEWARD"); // T1 viewer, D1 author, P1 steward cover; D2 admin and T2 officer do not
    expect(effectiveRole(assignments, RESOURCES.DOMAIN)).toBe("AUTHOR");
    expect(effectiveRole(assignments, RESOURCES.SIBLING_DOMAIN)).toBe("ADMIN");
    expect(effectiveRole(assignments, RESOURCES.TENANT)).toBe("VIEWER");
    expect(effectiveRole(assignments, RESOURCES.FOREIGN)).toBe("COMPLIANCE_OFFICER");
  });

  it("never lets another tenant's assignment apply (cross-tenant never applies), even for ADMIN", () => {
    expect(effectiveRole([a("ADMIN", "T2")], RESOURCES.PRODUCT)).toBeNull();
    expect(effectiveRole([a("ADMIN", "D1_IN_T2")], RESOURCES.DOMAIN)).toBeNull();
  });

  it("applies a global ADMIN everywhere", () => {
    for (const name of RESOURCE_NAMES) expect(effectiveRole([a("ADMIN", "GLOBAL")], RESOURCES[name]), name).toBe("ADMIN");
  });

  it("ignores a global assignment of any role but ADMIN (invalid: fails closed, e.g. a hand-edited row)", () => {
    for (const role of ROLE_HIERARCHY.filter((r) => r !== "ADMIN")) {
      expect(effectiveRole([{ role, scope: SCOPES.GLOBAL }], RESOURCES.PRODUCT), role).toBeNull();
    }
    // and does not let the invalid row shadow a valid lower one
    expect(effectiveRole([{ role: "STEWARD", scope: SCOPES.GLOBAL }, a("VIEWER", "T1")], RESOURCES.PRODUCT)).toBe("VIEWER");
  });

  it("ignores malformed assignments and survives non-array input, without throwing", () => {
    const junk = [null, undefined, 5, "ADMIN", {}, { role: "ADMIN" }, { scope: SCOPES.T1 }, { role: "SUPERUSER", scope: SCOPES.T1 }, { role: "ADMIN", scope: { kind: "TENANT" } }];
    expect(effectiveRole(junk as unknown as Assignment[], RESOURCES.PRODUCT)).toBeNull();
    expect(effectiveRole([...junk, a("AUTHOR", "T1")] as unknown as Assignment[], RESOURCES.PRODUCT)).toBe("AUTHOR");
    for (const bad of [null, undefined, "ADMIN", 5, {}]) {
      expect(() => effectiveRole(bad as unknown as Assignment[], RESOURCES.PRODUCT)).not.toThrow();
      expect(effectiveRole(bad as unknown as Assignment[], RESOURCES.PRODUCT)).toBeNull();
    }
  });

  it("answers null for a malformed resource", () => {
    for (const bad of [null, undefined, {}, { tenantId: "" }, "t"]) {
      expect(effectiveRole([a("ADMIN", "GLOBAL"), a("ADMIN", "T1")], bad as unknown as ResourceRef)).toBeNull();
    }
  });

  it("does not mutate its input (frozen assignments and resource)", () => {
    const assignments = deepFreeze([a("VIEWER", "T1"), a("AUTHOR", "D1")]);
    const resource = deepFreeze({ ...RESOURCES.DOMAIN });
    expect(() => effectiveRole(assignments, resource)).not.toThrow();
  });
});

describe("can (action x role x scope x resource)", () => {
  const ids = Object.keys(ACTIONS) as ActionId[];

  /** The expected answer, from the level rules of the table and the hand-written containment facts above. */
  function expected(id: ActionId, role: Role, scopeName: ScopeName, resourceName: ResourceName): boolean {
    const spec = ACTIONS[id];
    if (spec.level === "self") return true;
    const validAssignment = scopeName !== "GLOBAL" || role === "ADMIN";
    if (!validAssignment || rank(role) < rank(spec.minRole)) return false;
    switch (spec.level) {
      case "resource":
        return COVERS[scopeName][resourceName];
      case "tenant":
        // a tenant-wide decision: only a global or a TENANT-scope assignment of that very tenant counts, never a domain or product one
        return scopeName === "GLOBAL" || ((scopeName === "T1" || scopeName === "T2") && SCOPE_TENANT[scopeName] === RESOURCE_TENANT[resourceName]);
      case "anywhere":
        // a role at any depth inside the tenant, or a global one
        return scopeName === "GLOBAL" || SCOPE_TENANT[scopeName] === RESOURCE_TENANT[resourceName];
      case "global":
        return scopeName === "GLOBAL";
    }
  }

  it.each(ids)("%s: matches the level rule for every role x scope x resource", (id) => {
    const mismatches: string[] = [];
    for (const role of ROLE_HIERARCHY) {
      for (const scopeName of SCOPE_NAMES) {
        for (const resourceName of RESOURCE_NAMES) {
          const actual = can([a(role, scopeName)], id, RESOURCES[resourceName]);
          const want = expected(id, role, scopeName, resourceName);
          if (actual !== want) mismatches.push(`${role}@${scopeName} on ${resourceName}: got ${actual}, want ${want}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("with no assignment (a roleless user) denies every action except the self-level ones", () => {
    for (const id of ids) {
      for (const resourceName of RESOURCE_NAMES) {
        expect(can([], id, RESOURCES[resourceName]), `${id} ${resourceName}`).toBe(ACTIONS[id].level === "self");
      }
    }
  });

  it("answers self-level actions (notification.own, profile.own) for any principal: with no role at all, with junk, and without a resource", () => {
    // `can` cannot know a session is active or disabled: the caller (the principal loader) has already established an active principal.
    // A self-level action is therefore allowed whatever the assignments are, so a user with no role still gets their notifications and profile.
    for (const id of ["notification.own", "profile.own"] as const) {
      expect(can([], id, RESOURCES.FOREIGN)).toBe(true);
      expect(can([], id, undefined as unknown as ResourceRef)).toBe(true);
      expect(can(null as unknown as Assignment[], id, RESOURCES.TENANT)).toBe(true);
      expect(can([{ role: "SUPERUSER" }] as unknown as Assignment[], id, RESOURCES.TENANT)).toBe(true);
    }
  });

  it("denies an unknown action id, however privileged the principal", () => {
    const root = [a("ADMIN", "GLOBAL"), a("ADMIN", "T1")];
    for (const bad of ["", "entity", "entity.unknown", "ENTITY.READ", " entity.read", "entity.read ", "constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", 5, null, undefined, {}, ["entity.read"]]) {
      expect(() => can(root, bad as ActionId, RESOURCES.PRODUCT)).not.toThrow();
      expect(can(root, bad as ActionId, RESOURCES.PRODUCT), String(bad)).toBe(false);
    }
  });

  it("denies on malformed assignments or resources, and never throws", () => {
    for (const bad of [null, undefined, "ADMIN", 5, {}]) {
      expect(can(bad as unknown as Assignment[], "entity.read", RESOURCES.PRODUCT)).toBe(false);
    }
    for (const bad of [null, undefined, {}, { tenantId: "" }, "t", 5]) {
      expect(can([a("ADMIN", "GLOBAL")], "entity.read", bad as unknown as ResourceRef)).toBe(false);
      expect(can([a("ADMIN", "GLOBAL")], "platform.admin", bad as unknown as ResourceRef)).toBe(true); // a global item names no resource
    }
  });

  it("ignores an invalid global non-ADMIN row for every level", () => {
    for (const role of ROLE_HIERARCHY.filter((r) => r !== "ADMIN")) {
      const bad: Assignment[] = [{ role, scope: SCOPES.GLOBAL }];
      for (const id of Object.keys(ACTIONS) as ActionId[]) {
        if (ACTIONS[id].level !== "self") expect(can(bad, id, RESOURCES.PRODUCT), `${role} ${id}`).toBe(false);
      }
    }
  });

  it("does not mutate its input", () => {
    const assignments = deepFreeze([a("ADMIN", "T1"), a("AUTHOR", "D1")]);
    const resource = deepFreeze({ ...RESOURCES.PRODUCT });
    for (const id of ids) expect(() => can(assignments, id, resource)).not.toThrow();
  });

  it("is bounded: a very large assignment list and a huge id are answered quickly", () => {
    const many: Assignment[] = Array.from({ length: 50_000 }, (_, i) => ({ role: "VIEWER" as Role, scope: { kind: "TENANT" as const, tenantId: `other-${i}` } }));
    many.push(a("AUTHOR", "D1"));
    const start = performance.now();
    expect(can(many, "entity.write", RESOURCES.PRODUCT)).toBe(true);
    expect(can(many, "entity.publish", RESOURCES.PRODUCT)).toBe(false);
    expect(can(many, "entity.write", { tenantId: "x".repeat(1_000_000) })).toBe(false);
    expect(performance.now() - start).toBeLessThan(1500);
  });

  describe("scenarios of the plan's review focus", () => {
    it("a roleless user reads nothing and changes nothing in any tenant", () => {
      for (const id of ids.filter((x) => ACTIONS[x].level !== "self")) {
        expect(can([], id, RESOURCES.PRODUCT), id).toBe(false);
        expect(can([], id, RESOURCES.TENANT), id).toBe(false);
      }
    });

    it("an AUTHOR on domain A writes in A, not in sibling domain B, and not tenant-level entities", () => {
      const author = [a("AUTHOR", "D1")];
      expect(can(author, "entity.write", RESOURCES.DOMAIN)).toBe(true);
      expect(can(author, "entity.write", RESOURCES.PRODUCT)).toBe(true); // a product of A
      expect(can(author, "entity.write", RESOURCES.SIBLING_DOMAIN)).toBe(false);
      expect(can(author, "entity.write", RESOURCES.TENANT)).toBe(false); // a tenant-level entity is governed by tenant and global assignments only
      expect(can(author, "entity.read", RESOURCES.SIBLING_DOMAIN)).toBe(false);
      expect(can(author, "entity.publish", RESOURCES.DOMAIN)).toBe(false); // above AUTHOR
    });

    it("a domain STEWARD publishes and approves in the domain, but cannot create a domain (decided at tenant scope)", () => {
      const steward = [a("STEWARD", "D1")];
      expect(can(steward, "entity.publish", RESOURCES.PRODUCT)).toBe(true);
      expect(can(steward, "governance.decide", RESOURCES.DOMAIN)).toBe(true);
      expect(can(steward, "product.create", RESOURCES.DOMAIN)).toBe(true);
      expect(can(steward, "domain.create", RESOURCES.TENANT)).toBe(false);
      expect(can([a("STEWARD", "T1")], "domain.create", RESOURCES.TENANT)).toBe(true);
    });

    it("a tenant ADMIN of tenant A has no say in tenant B and no platform power", () => {
      const admin = [a("ADMIN", "T1")];
      expect(can(admin, "user.manage", RESOURCES.TENANT)).toBe(true);
      expect(can(admin, "user.manage", RESOURCES.FOREIGN)).toBe(false);
      expect(can(admin, "tenant.access", RESOURCES.FOREIGN)).toBe(false);
      expect(can(admin, "platform.admin", RESOURCES.TENANT)).toBe(false);
      expect(can(admin, "tenant.create", RESOURCES.TENANT)).toBe(false);
    });

    it("a domain-scoped ADMIN does not delete the domain: that is a tenant ADMIN's call", () => {
      expect(can([a("ADMIN", "D1")], "domain.delete", RESOURCES.DOMAIN)).toBe(false);
      expect(can([a("ADMIN", "T1")], "domain.delete", RESOURCES.DOMAIN)).toBe(true);
    });

    it("tenant membership (tenant.access) is any assignment inside the tenant, at any depth, or a global admin", () => {
      expect(can([a("VIEWER", "P1")], "tenant.access", { tenantId: T1 })).toBe(true);
      expect(can([a("VIEWER", "P1")], "tenant.access", { tenantId: T2 })).toBe(false);
      expect(can([a("ADMIN", "GLOBAL")], "tenant.access", { tenantId: T2 })).toBe(true);
      expect(can([], "tenant.access", { tenantId: T1 })).toBe(false);
    });

    it("the glossary is writable by an AUTHOR anywhere in the tenant, readable by a VIEWER anywhere", () => {
      expect(can([a("AUTHOR", "P1")], "glossary.write", { tenantId: T1 })).toBe(true);
      expect(can([a("VIEWER", "P1")], "glossary.write", { tenantId: T1 })).toBe(false);
      expect(can([a("VIEWER", "D2")], "glossary.read", { tenantId: T1 })).toBe(true);
      expect(can([a("AUTHOR", "T2")], "glossary.write", { tenantId: T1 })).toBe(false);
    });

    it("compliance reads need a COMPLIANCE_OFFICER (or ADMIN): a STEWARD or AUTHOR no longer qualifies", () => {
      expect(can([a("STEWARD", "T1")], "compliance.query", RESOURCES.TENANT)).toBe(false);
      expect(can([a("AUTHOR", "T1")], "compliance.audit", RESOURCES.TENANT)).toBe(false);
      expect(can([a("COMPLIANCE_OFFICER", "T1")], "compliance.audit", RESOURCES.TENANT)).toBe(true);
      expect(can([a("COMPLIANCE_OFFICER", "D1")], "compliance.query", RESOURCES.DOMAIN)).toBe(true);
      expect(can([a("COMPLIANCE_OFFICER", "D1")], "compliance.audit", RESOURCES.DOMAIN)).toBe(false); // the audit trail is a tenant-wide read
    });
  });
});

describe("grantAllowed (only an ADMIN covering the target scope grants; never above the granter's own role)", () => {
  const roles = ROLE_HIERARCHY;

  it("is tied to the table: role.assign needs ADMIN", () => {
    expect(ACTIONS["role.assign"].minRole).toBe("ADMIN");
  });

  it("a global ADMIN grants any role at any non-global scope, and ADMIN at the global scope", () => {
    const root = [a("ADMIN", "GLOBAL")];
    for (const role of roles) {
      for (const name of ["T1", "T2", "D1", "D1_IN_T2", "P1"] as const) expect(grantAllowed(root, role, SCOPES[name]), `${role} ${name}`).toBe(true);
    }
    expect(grantAllowed(root, "ADMIN", SCOPES.GLOBAL)).toBe(true);
  });

  it("refuses a global grant of any role but ADMIN, even from a global ADMIN (an invalid assignment)", () => {
    for (const role of roles.filter((r) => r !== "ADMIN")) expect(grantAllowed([a("ADMIN", "GLOBAL")], role, SCOPES.GLOBAL), role).toBe(false);
  });

  it("a tenant ADMIN grants every role up to ADMIN within the tenant (tenant, its domains, its products) and nowhere else", () => {
    const admin = [a("ADMIN", "T1")];
    for (const role of roles) {
      for (const name of ["T1", "D1", "D2", "P1", "P2"] as const) expect(grantAllowed(admin, role, SCOPES[name]), `${role} ${name}`).toBe(true);
      for (const name of ["T2", "D1_IN_T2", "GLOBAL"] as const) expect(grantAllowed(admin, role, SCOPES[name]), `${role} ${name}`).toBe(false);
    }
  });

  it("an ADMIN of tenant A cannot grant in tenant B", () => {
    expect(grantAllowed([a("ADMIN", "T1")], "VIEWER", SCOPES.T2)).toBe(false);
    expect(grantAllowed([a("ADMIN", "T1")], "VIEWER", { kind: "DOMAIN", tenantId: T2, domainId: "any" })).toBe(false);
    expect(grantAllowed([a("ADMIN", "T1")], "AUTHOR", { kind: "PRODUCT", tenantId: T2, domainId: D1, productId: P1 })).toBe(false);
  });

  it("a domain ADMIN grants inside the domain and its products, not above it, not in a sibling", () => {
    const admin = [a("ADMIN", "D1")];
    expect(grantAllowed(admin, "STEWARD", SCOPES.D1)).toBe(true);
    expect(grantAllowed(admin, "ADMIN", SCOPES.P1)).toBe(true);
    expect(grantAllowed(admin, "VIEWER", SCOPES.P2)).toBe(true);
    expect(grantAllowed(admin, "VIEWER", SCOPES.T1)).toBe(false);
    expect(grantAllowed(admin, "VIEWER", SCOPES.D2)).toBe(false);
    expect(grantAllowed(admin, "VIEWER", SCOPES.GLOBAL)).toBe(false);
    expect(grantAllowed(admin, "VIEWER", { kind: "PRODUCT", tenantId: T1, domainId: D2, productId: "p9" })).toBe(false);
  });

  it("a product ADMIN grants only in that product", () => {
    const admin = [a("ADMIN", "P1")];
    expect(grantAllowed(admin, "AUTHOR", SCOPES.P1)).toBe(true);
    expect(grantAllowed(admin, "AUTHOR", SCOPES.P2)).toBe(false);
    expect(grantAllowed(admin, "AUTHOR", SCOPES.D1)).toBe(false);
  });

  it("a domain STEWARD (or any non-ADMIN) may not grant anything, nobody grants above their own role", () => {
    for (const role of roles.filter((r) => r !== "ADMIN")) {
      for (const scope of ["T1", "D1", "P1"] as const) {
        for (const granted of roles) {
          for (const target of ["T1", "D1", "P1"] as const) {
            expect(grantAllowed([a(role, scope)], granted, SCOPES[target]), `${role}@${scope} grants ${granted}@${target}`).toBe(false);
          }
        }
      }
    }
  });

  it("only the assignments that cover the target count: an ADMIN elsewhere plus a VIEWER here is no grant", () => {
    expect(grantAllowed([a("ADMIN", "D2"), a("VIEWER", "T1")], "VIEWER", SCOPES.D1)).toBe(false);
    expect(grantAllowed([a("ADMIN", "D2"), a("ADMIN", "D1")], "VIEWER", SCOPES.D1)).toBe(true);
  });

  it("ignores an invalid global non-ADMIN granter row", () => {
    expect(grantAllowed([{ role: "AUTHOR", scope: SCOPES.GLOBAL }], "VIEWER", SCOPES.T1)).toBe(false);
  });

  it("refuses an empty granter, an unknown role, a malformed target or junk, and never throws", () => {
    expect(grantAllowed([], "VIEWER", SCOPES.T1)).toBe(false);
    const root = [a("ADMIN", "GLOBAL")];
    for (const role of ["SUPERUSER", "admin", "", null, undefined, 5]) expect(grantAllowed(root, role as Role, SCOPES.T1), String(role)).toBe(false);
    for (const target of [null, undefined, {}, "T:t", { kind: "TENANT" }, { kind: "DOMAIN", tenantId: T1 }]) {
      expect(() => grantAllowed(root, "VIEWER", target as Scope)).not.toThrow();
      expect(grantAllowed(root, "VIEWER", target as Scope), JSON.stringify(target)).toBe(false);
    }
    for (const granter of [null, undefined, "ADMIN", 5, {}]) expect(grantAllowed(granter as unknown as Assignment[], "VIEWER", SCOPES.T1)).toBe(false);
  });

  it("does not mutate its input", () => {
    const granter = deepFreeze([a("ADMIN", "T1")]);
    const target = deepFreeze({ ...SCOPES.D1 });
    expect(() => grantAllowed(granter, "AUTHOR", target)).not.toThrow();
  });
});
