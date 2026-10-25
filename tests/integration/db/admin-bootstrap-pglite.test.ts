import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { hash } from "bcryptjs";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPGlite } from "@/lib/pglite-adapter";
import { applyPgliteMigrations } from "@/lib/pglite-migrate";
import { ensureBootstrapAdmin } from "@/lib/admin-bootstrap";

/**
 * The bootstrap administrator against a real database (PGlite, migrated with every migration including access_control, through Prisma and the
 * vendored driver adapter): the unique constraints the helper relies on actually fire, with the error shape it reads.
 */
let pglite: PGlite;
let prisma: PrismaClient;

beforeAll(async () => {
  pglite = new PGlite();
  await applyPgliteMigrations(pglite);
  prisma = new PrismaClient({ adapter: new PrismaPGlite(pglite) });
}, 120_000);
afterAll(async () => {
  await prisma?.$disconnect();
  await pglite?.close();
});
beforeEach(async () => {
  await prisma.userRole.deleteMany();
  await prisma.user.deleteMany();
});

const PASSWORD = "correct horse battery";
const globalAdmins = () => prisma.userRole.findMany({ where: { role: "ADMIN", scopeKey: "G" }, orderBy: { id: "asc" } });

describe("ensureBootstrapAdmin on PGlite", () => {
  it("creates the administrator once, with a hashed password and the global key, and is idempotent", async () => {
    const first = await ensureBootstrapAdmin({ email: "Root@Example.TEST", password: PASSWORD }, prisma);
    expect(first.status).toBe("created");
    const second = await ensureBootstrapAdmin({ email: "root@example.test", password: "a different password" }, prisma);
    expect(second.status).toBe("unchanged");

    const users = await prisma.user.findMany();
    expect(users).toHaveLength(1);
    expect(users[0].email).toBe("root@example.test");
    expect(users[0].password).toMatch(/^\$2[aby]\$12\$/);
    const roles = await globalAdmins();
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({ userId: users[0].id, role: "ADMIN", scopeKey: "G", tenantId: null, domainId: null, productId: null });
  }, 60_000);

  it("concurrent bootstraps of the same e-mail end with one user and one assignment (the unique keys decide the race)", async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => ensureBootstrapAdmin({ email: "race@example.test", password: PASSWORD }, prisma)));

    for (const result of results) expect(["created", "granted", "unchanged"]).toContain(result.status);
    expect(results.filter((r) => r.status === "created")).toHaveLength(1);
    expect(await prisma.user.count()).toBe(1);
    expect(await globalAdmins()).toHaveLength(1);
  }, 60_000);

  it("makes an existing account an administrator only with its own password, and never touches a different one", async () => {
    await prisma.user.create({ data: { email: "member@example.test", password: await hash("their own password", 4) } });

    const refused = await ensureBootstrapAdmin({ email: "member@example.test", password: PASSWORD }, prisma);
    expect(refused).toMatchObject({ status: "refused", reason: "password-mismatch" });
    expect(await globalAdmins()).toHaveLength(0);

    const granted = await ensureBootstrapAdmin({ email: "member@example.test", password: "their own password" }, prisma);
    expect(granted.status).toBe("granted");
    expect(await globalAdmins()).toHaveLength(1);
  }, 60_000);

  it("reports a case variant of an existing e-mail as a conflict instead of creating a second account", async () => {
    await prisma.user.create({ data: { email: "Mixed@Example.test", password: await hash(PASSWORD, 4) } });

    const result = await ensureBootstrapAdmin({ email: "mixed@example.test", password: PASSWORD }, prisma);

    expect(result).toMatchObject({ status: "refused", reason: "conflict" });
    expect(await prisma.user.count()).toBe(1);
    expect(await globalAdmins()).toHaveLength(0);
  }, 60_000);

  it("the database itself refuses a second global ADMIN row for a user, through Prisma (P2002)", async () => {
    const user = await prisma.user.create({ data: { email: "dup@example.test" } });
    await prisma.userRole.create({ data: { userId: user.id, role: "ADMIN", scopeKey: "G" } });

    await expect(prisma.userRole.create({ data: { userId: user.id, role: "ADMIN", scopeKey: "G" } })).rejects.toMatchObject({ code: "P2002" });
  }, 60_000);
});
