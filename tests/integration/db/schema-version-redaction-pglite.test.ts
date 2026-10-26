// @vitest-environment node
/**
 * KD-046 against a real database (PGlite with every migration): the stored generated schemas of an entity carry the files of every entity of the closure
 * they were made from. A version made by a wider role (a tenant administrator) must not hand the files of an entity a LATER READER may not read to that
 * reader, on any surface: the Schemas tab action, the entity service (the v1 `GET /schemas/:id` answer), the change log. The real guard, the real principal
 * loader, the real places of the entities; the session and the active tenant are stand-ins.
 *
 * World: tenant T; domain A (the root's) and domain B; the root and a sibling are in A, the secret entity in B, a tenant-level entity has no domain; one
 * referenced entity was deleted after the version was made. Readers: a tenant administrator, a platform administrator, a steward of domain A, a viewer of A and B,
 * a viewer of B only, an author of A, and a user with no role.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "../../helpers/pglite-db";

const holder = vi.hoisted(() => ({ db: undefined as undefined | TestDb, userId: { current: null as null | string }, tenantId: { current: "" } }));
vi.mock("@/lib/db", async () => {
  holder.db = await (await import("../../helpers/pglite-db")).createPgliteDb();
  return { prisma: holder.db.prisma };
});
vi.mock("@/lib/auth", () => ({ auth: async () => (holder.userId.current ? { user: { id: holder.userId.current, email: "x@example.test" }, expires: "2999-01-01" } : null) }));
vi.mock("@/lib/active-tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/active-tenant")>()),
  getActiveTenantId: async () => holder.tenantId.current,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { getSchemaVersionsAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";
import { getEntityById, getEntities } from "@/services/entity.service";
import { getChangeHistory } from "@/services/change-history.service";
import { contextOf } from "@/lib/action-context";
import { loadPrincipalById } from "@/lib/access/principal";
import { bundleEmittedFiles } from "@/lib/typespec-official/closure-emit";
import type { SchemaVersion, SchemaVersionsMap } from "@/types/schema-version";

const db = () => holder.db!.prisma;
let n = 0;
const fresh = (label: string) => `${label}-${++n}`;

afterAll(async () => {
  await holder.db?.close();
});

type World = Awaited<ReturnType<typeof makeWorld>>;
let world: World;
let stored: SchemaVersionsMap;

type F = { path: string; content: string; target: string; entityId?: string };
const closureVersion = (files: F[], members: Array<{ id: string; name: string }>, target: string, versionNumber = 1): SchemaVersion => ({
  version: versionNumber,
  status: "draft",
  output: bundleEmittedFiles(files),
  generatedAt: "2026-01-01T00:00:00.000Z",
  entityVersion: 1,
  files: files as SchemaVersion["files"],
  resolution: {
    mode: "draft",
    preview: true,
    entities: members.map((m) => ({ ref: { entityId: m.id, domain: "d", product: "p", entity: m.name }, source: "draft" as const })),
    notes: members.map((m) => `${m.name}: noted`),
  },
});

async function makeWorld() {
  const owner = await db().user.create({ data: { email: `${fresh("owner")}@example.test` } });
  const tenant = await db().tenant.create({ data: { name: fresh("Tenant"), slug: fresh("tenant") } });
  const domainA = await db().domain.create({ data: { tenantId: tenant.id, name: "Payments", slug: fresh("a") } });
  const domainB = await db().domain.create({ data: { tenantId: tenant.id, name: "Billing", slug: fresh("b") } });
  const productA = await db().product.create({ data: { domainId: domainA.id, name: "Checkout", slug: fresh("pa") } });
  const productB = await db().product.create({ data: { domainId: domainB.id, name: "Ledger", slug: fresh("pb") } });
  const entity = (name: string, domainId: string | null, productId: string | null) =>
    db().entity.create({ data: { name, slug: fresh(name.toLowerCase()), tenantId: tenant.id, domainId, productId, ownerId: owner.id } });
  const root = await entity("Order", domainA.id, productA.id);
  const sibling = await entity("Customer", domainA.id, productA.id);
  const secret = await entity("SecretLedger", domainB.id, productB.id);
  const tenantLevel = await entity("EnterpriseThing", null, null);
  const gone = await entity("Vanished", domainB.id, productB.id);
  await db().entity.delete({ where: { id: gone.id } });

  const members = [
    { id: root.id, name: root.name },
    { id: sibling.id, name: sibling.name },
    { id: secret.id, name: secret.name },
    { id: tenantLevel.id, name: tenantLevel.name },
    { id: gone.id, name: gone.name },
  ];
  const jsonFiles: F[] = [
    { path: "Order.json", content: '{"title":"Order","properties":{"c":{"$ref":"Customer.json"}}}', target: "json-schema", entityId: root.id },
    { path: "Customer.json", content: '{"title":"Customer"}', target: "json-schema", entityId: sibling.id },
    { path: "SecretLedger.json", content: '{"title":"SecretLedger","properties":{"iban":{}}}', target: "json-schema", entityId: secret.id },
    { path: "EnterpriseThing.json", content: '{"title":"EnterpriseThing","properties":{"taxId":{}}}', target: "json-schema", entityId: tenantLevel.id },
    { path: "Vanished.json", content: '{"title":"Vanished","properties":{"gone":{}}}', target: "json-schema", entityId: gone.id },
  ];
  const openapiFiles: F[] = [
    { path: "openapi.Order.yaml", content: "components:\n  schemas:\n    Order: {}\n    SecretLedger:\n      iban: {}", target: "openapi3", entityId: root.id },
    { path: "openapi.SecretLedger.yaml", content: "SecretLedger: {}", target: "openapi3", entityId: secret.id },
  ];
  const protoFiles: F[] = [{ path: "order.proto", content: "message Order {}\nmessage SecretLedger { string iban = 1; }", target: "protobuf", entityId: root.id }];
  stored = {
    "json-schema": [closureVersion(jsonFiles, members, "json-schema", 2), closureVersion([jsonFiles[0]], [members[0]], "json-schema", 1)],
    openapi3: [closureVersion(openapiFiles, [members[0], members[2]], "openapi3")],
    protobuf: [closureVersion(protoFiles, [members[0], members[2]], "protobuf")],
    bigquery: [{ version: 1, status: "draft", output: "CREATE TABLE orders (id INT64);", generatedAt: "x", entityVersion: 1 }],
  };
  await db().entity.update({ where: { id: root.id }, data: { metadata: { tags: ["a"], schemaVersions: stored } as never } });

  const user = async (label: string, grants: Array<{ role: string; key: string; tenantId?: string; domainId?: string }>) => {
    const u = await db().user.create({ data: { email: `${fresh(label)}@example.test` } });
    for (const g of grants) await db().userRole.create({ data: { userId: u.id, role: g.role, scopeKey: g.key, tenantId: g.tenantId ?? null, domainId: g.domainId ?? null, productId: null } });
    return u;
  };
  const T = tenant.id;
  const users = {
    tenantAdmin: await user("tadmin", [{ role: "ADMIN", key: `T:${T}`, tenantId: T }]),
    globalAdmin: await user("gadmin", [{ role: "ADMIN", key: "G" }]),
    tenantViewer: await user("tviewer", [{ role: "VIEWER", key: `T:${T}`, tenantId: T }]),
    stewardA: await user("stewarda", [{ role: "STEWARD", key: `D:${domainA.id}`, tenantId: T, domainId: domainA.id }]),
    authorA: await user("authora", [{ role: "AUTHOR", key: `D:${domainA.id}`, tenantId: T, domainId: domainA.id }]),
    viewerAB: await user("viewerab", [
      { role: "VIEWER", key: `D:${domainA.id}`, tenantId: T, domainId: domainA.id },
      { role: "VIEWER", key: `D:${domainB.id}`, tenantId: T, domainId: domainB.id },
    ]),
    viewerB: await user("viewerb", [{ role: "VIEWER", key: `D:${domainB.id}`, tenantId: T, domainId: domainB.id }]),
    roleless: await user("roleless", []),
  };
  return { owner, tenant, domainA, domainB, root, sibling, secret, tenantLevel, gone, users };
}

beforeAll(async () => {
  world = await makeWorld();
  holder.tenantId.current = world.tenant.id;
}, 120_000);

beforeEach(() => {
  holder.userId.current = null;
  holder.tenantId.current = world.tenant.id;
});

const as = (user: { id: string }) => {
  holder.userId.current = user.id;
};
type Answer = { success?: true; schemaVersions?: SchemaVersionsMap; error?: string; code?: string };
const versionsFor = async (user: { id: string }): Promise<SchemaVersionsMap> => {
  as(user);
  const answer = (await getSchemaVersionsAction(world.root.id)) as Answer;
  expect(answer.error, JSON.stringify(answer)).toBeUndefined();
  return answer.schemaVersions as SchemaVersionsMap;
};
const filesOf = (v: SchemaVersion) => (v.files ?? []).map((f) => f.path);

describe("getSchemaVersionsAction (the Schemas tab)", () => {
  it("a tenant administrator and a platform administrator read the stored versions whole (a deleted entity's file is a tenant-level one: theirs to read)", async () => {
    expect(await versionsFor(world.users.tenantAdmin)).toEqual(stored);
    expect(await versionsFor(world.users.globalAdmin)).toEqual(stored);
    expect(await versionsFor(world.users.tenantViewer)).toEqual(stored);
  });

  it("a steward of the root's domain reads the root's and the sibling's files and nothing of the other domain, the tenant level or the deleted entity", async () => {
    const out = await versionsFor(world.users.stewardA);
    const latest = out["json-schema"][0];
    expect(filesOf(latest)).toEqual(["Order.json", "Customer.json"]);
    expect(latest.output).toBe(bundleEmittedFiles((stored["json-schema"][0].files ?? []).filter((f) => f.path === "Customer.json" || f.path === "Order.json")));
    for (const secret of ["SecretLedger", "iban", "EnterpriseThing", "taxId", "Vanished", "gone"]) {
      expect(JSON.stringify(out), secret).not.toContain(`"${secret}`);
    }
    expect(latest.redacted).toEqual({ hiddenFiles: 3, hiddenEntities: 3 });
    expect(latest.resolution?.entities.map((e) => e.ref.entityId)).toEqual([world.root.id, world.sibling.id]);
    // the older version holds the root only: it is shown as stored
    expect(out["json-schema"][1]).toEqual(stored["json-schema"][1]);
    // a target that is only the entity's own is untouched
    expect(out.bigquery).toEqual(stored.bigquery);
  });

  it("an author of the domain gets the same as the steward (read is the lowest rung)", async () => {
    expect(await versionsFor(world.users.authorA)).toEqual(await versionsFor(world.users.stewardA));
  });

  it("OpenAPI and Protobuf versions whose closure holds an entity the reader may not read show no file at all (the root's own file carries the other entity's definition)", async () => {
    const out = await versionsFor(world.users.stewardA);
    for (const target of ["openapi3", "protobuf"]) {
      expect(out[target][0].files, target).toEqual([]);
      expect(out[target][0].output, target).toBe("");
      expect(out[target][0].redacted?.hiddenEntities, target).toBe(1);
    }
    expect(JSON.stringify(out)).not.toContain("iban");
  });

  it("a reader who may read the other domain too but not the tenant level sees the secret entity's file and not the tenant-level or the deleted one", async () => {
    const out = await versionsFor(world.users.viewerAB);
    expect(filesOf(out["json-schema"][0])).toEqual(["Order.json", "Customer.json", "SecretLedger.json"]);
    expect(out["json-schema"][0].redacted).toEqual({ hiddenFiles: 2, hiddenEntities: 2 });
    // every member of the OpenAPI closure is readable to them
    expect(out.openapi3).toEqual(stored.openapi3);
    expect(out.protobuf).toEqual(stored.protobuf);
  });

  it("a user with no role over the root does not get here at all (the refusal is the not-found of a missing entity)", async () => {
    for (const user of [world.users.roleless, world.users.viewerB]) {
      as(user);
      expect(await getSchemaVersionsAction(world.root.id)).toEqual({ error: "Entity not found", code: "NOT_FOUND" });
    }
  });

  it("redaction never changes what is stored (the writers go on from the whole list)", async () => {
    await versionsFor(world.users.stewardA);
    const row = await db().entity.findUniqueOrThrow({ where: { id: world.root.id } });
    expect((row.metadata as { schemaVersions: unknown }).schemaVersions).toEqual(JSON.parse(JSON.stringify(stored)));
  });
});

describe("the entity service (the v1 `GET /api/v1/schemas/:id` answer)", () => {
  const ctxFor = async (user: { id: string }) => {
    const principal = await loadPrincipalById(user.id);
    return { ...contextOf(principal!), tenantId: world.tenant.id };
  };

  it("gives the same redacted metadata as the action, and the rest of the entity as it was", async () => {
    const result = await getEntityById(world.root.id, await ctxFor(world.users.stewardA));
    expect(result.success).toBe(true);
    if (!result.success) return;
    const metadata = result.data.metadata as unknown as { tags: string[]; schemaVersions: SchemaVersionsMap };
    expect(metadata.tags).toEqual(["a"]);
    expect(metadata.schemaVersions).toEqual(await versionsFor(world.users.stewardA));
    expect(result.data.name).toBe("Order");
    expect(JSON.stringify(result.data)).not.toContain("iban");
    expect(JSON.stringify(result.data)).not.toContain("taxId");
  });

  it("a tenant administrator gets the stored versions whole", async () => {
    const result = await getEntityById(world.root.id, await ctxFor(world.users.tenantAdmin));
    expect(result.success && (result.data.metadata as { schemaVersions: unknown }).schemaVersions).toEqual(stored);
  });

  it("a reader with no role over the entity gets the one not-found, and a list never carries the versions at all", async () => {
    const refused = await getEntityById(world.root.id, await ctxFor(world.users.roleless));
    expect(refused.success).toBe(false);
    const list = await getEntities({}, await ctxFor(world.users.tenantAdmin));
    expect(list.success).toBe(true);
    if (list.success) {
      expect(list.data.length).toBeGreaterThan(0);
      for (const entity of list.data) expect(JSON.stringify(entity.metadata ?? null)).not.toContain("schemaVersions");
    }
  });
});

describe("the change log", () => {
  it("returns an entry's before and after state without the stored versions the row held", async () => {
    await db().auditLog.create({
      data: {
        action: "UPDATE",
        entityType: "Entity",
        entityId: world.root.id,
        userId: world.owner.id,
        tenantId: world.tenant.id,
        beforeState: { id: world.root.id, name: "Order", metadata: { tags: [], schemaVersions: stored } } as never,
        afterState: { metadata: { schemaVersions: stored, tags: ["a"] } } as never,
      },
    });
    const result = await getChangeHistory(world.root.id, { userId: world.users.stewardA.id, userRole: "VIEWER", prisma: db() } as never);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const audit = result.data.entries.filter((e) => e.entryType === "audit");
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain("schemaVersions");
    expect(JSON.stringify(audit)).not.toContain("iban");
    expect(JSON.stringify(audit)).toContain('"tags"');
  });
});
