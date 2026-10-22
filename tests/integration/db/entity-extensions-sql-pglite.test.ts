import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { applyPgliteMigrations } from "@/lib/pglite-migrate";
import { SET_ENTITY_EXTENSIONS_SQL, CLEAR_ENTITY_EXTENSIONS_SQL } from "@/lib/entity-versioning/draft-state";

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await applyPgliteMigrations(db);
  await db.exec(`INSERT INTO "users" ("id", "email", "updatedAt") VALUES ('u1', 'u1@example.test', CURRENT_TIMESTAMP)`);
}, 60_000);
afterAll(async () => db.close());

async function entity(id: string, metadata: string | null) {
  await db.query(
    `INSERT INTO "entities" ("id", "name", "slug", "tenantId", "ownerId", "metadata", "updatedAt")
     VALUES ($1, $1, $1, 'tenant_default', 'u1', $2::jsonb, CURRENT_TIMESTAMP)`,
    [id, metadata],
  );
}
async function metadataOf(id: string): Promise<unknown> {
  return (await db.query<{ metadata: unknown }>(`SELECT "metadata" FROM "entities" WHERE "id" = $1`, [id])).rows[0].metadata;
}

describe("metadata.custom.extensions statements", () => {
  it("SET creates custom for a NULL / scalar / custom-less metadata and keeps every other key", async () => {
    await entity("x1", null);
    await db.query(SET_ENTITY_EXTENSIONS_SQL, ["x1", JSON.stringify({ "x-a": 1 })]);
    expect(await metadataOf("x1")).toEqual({ custom: { extensions: { "x-a": 1 } } });

    await entity("x2", JSON.stringify({ tags: ["t"], custom: { other: true, extensions: { old: 1 } } }));
    await db.query(SET_ENTITY_EXTENSIONS_SQL, ["x2", JSON.stringify({ "x-b": { c: [1] } })]);
    expect(await metadataOf("x2")).toEqual({ tags: ["t"], custom: { other: true, extensions: { "x-b": { c: [1] } } } });
  });

  it("SET keeps a __proto__ key", async () => {
    await entity("x3", null);
    await db.query(SET_ENTITY_EXTENSIONS_SQL, ["x3", '{"__proto__":{"p":1}}']);
    const md = (await metadataOf("x3")) as { custom: { extensions: object } };
    expect(Object.keys(md.custom.extensions)).toEqual(["__proto__"]);
  });

  it("CLEAR removes only extensions, drops an emptied custom, and is a no-op without custom", async () => {
    await entity("c1", JSON.stringify({ tags: ["t"], custom: { other: true, extensions: { a: 1 } } }));
    await db.query(CLEAR_ENTITY_EXTENSIONS_SQL, ["c1"]);
    expect(await metadataOf("c1")).toEqual({ tags: ["t"], custom: { other: true } });

    await entity("c2", JSON.stringify({ tags: ["t"], custom: { extensions: { a: 1 } } }));
    await db.query(CLEAR_ENTITY_EXTENSIONS_SQL, ["c2"]);
    expect(await metadataOf("c2")).toEqual({ tags: ["t"] });

    await entity("c3", null);
    await db.query(CLEAR_ENTITY_EXTENSIONS_SQL, ["c3"]);
    expect(await metadataOf("c3")).toBeNull();
  });
});
