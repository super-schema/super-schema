/**
 * scripts/admin-create.mjs (`npm run admin:create`): makes ONE global administrator through the seed's helper. Pinned: it refuses a weak
 * password (12 to 72 bytes) and an existing e-mail with a clear message, before any write; the password never appears in an argument, in
 * its output, or in an error; the three ways to give the password; the exit codes; and that it is wired in package.json.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { hashMock, compareMock } = vi.hoisted(() => ({
  hashMock: vi.fn(async (password: string) => `hashed:${password}`),
  compareMock: vi.fn(async (password: string, hashed: string) => hashed === `hashed:${password}`),
}));
vi.mock("bcryptjs", () => ({ hash: hashMock, compare: compareMock, default: { hash: hashMock, compare: compareMock } }));

import { EXIT, parseArgs, run } from "../../../scripts/admin-create.mjs";

const GOOD = "correct horse battery";

/** An in-memory database with the two tables the script and the helper touch. */
function fakeDatabase(existingEmails: string[] = []) {
  const users = existingEmails.map((email, i) => ({ id: `existing-${i}`, email, password: "hashed:somebody else's" }));
  const roles: Array<{ userId: string; role: string; scopeKey: string }> = [];
  const prisma = {
    user: {
      findFirst: vi.fn(async ({ where }: { where: { email: string } }) => users.find((u) => u.email === where.email) ?? null),
      create: vi.fn(async ({ data }: { data: { email: string; password: string } }) => {
        const row = { id: `user-${users.length + 1}`, email: data.email, password: data.password };
        users.push(row);
        return { id: row.id };
      }),
    },
    userRole: {
      findFirst: vi.fn(async ({ where }: { where: { userId: string; role: string; scopeKey: string } }) => roles.find((r) => r.userId === where.userId && r.role === where.role && r.scopeKey === where.scopeKey) ?? null),
      create: vi.fn(async ({ data }: { data: { userId: string; role: string; scopeKey: string } }) => {
        roles.push(data);
        return { id: `role-${roles.length}` };
      }),
    },
  };
  return { users, roles, prisma };
}

function harness(options: { env?: Record<string, string>; stdin?: string; isTTY?: boolean; secrets?: string[]; line?: string; existing?: string[] } = {}) {
  const db = fakeDatabase(options.existing);
  const out: string[] = [];
  const err: string[] = [];
  const secrets = [...(options.secrets ?? [])];
  const close = vi.fn(async () => undefined);
  const connect = vi.fn(async () => ({ prisma: db.prisma, close }));
  const terminal = {
    isTTY: options.isTTY ?? false,
    readLine: vi.fn(async () => options.line ?? ""),
    readSecret: vi.fn(async () => secrets.shift() ?? ""),
    readStdin: vi.fn(async () => options.stdin ?? ""),
  };
  const call = (argv: string[]) => run({ argv, env: options.env ?? {}, out: (l) => out.push(l), err: (l) => err.push(l), terminal, connect });
  return { db, out, err, close, connect, terminal, call, text: () => [...out, ...err].join("\n") };
}

beforeEach(() => vi.clearAllMocks());

describe("admin:create", () => {
  it("creates the administrator through the helper: a hashed password, the global ADMIN assignment, the e-mail normalized, and says so without the password", async () => {
    const h = harness({ env: { BOOTSTRAP_ADMIN_PASSWORD: GOOD } });

    expect(await h.call(["--email", "  New.Admin@Example.COM "])).toBe(EXIT.OK);

    expect(h.db.users).toEqual([{ id: "user-1", email: "new.admin@example.com", password: `hashed:${GOOD}` }]);
    expect(h.db.roles).toEqual([{ userId: "user-1", role: "ADMIN", scopeKey: "G" }]);
    expect(h.out).toEqual(["Created administrator new.admin@example.com (user id user-1) with the global ADMIN role."]);
    expect(h.err).toEqual([]);
    expect(h.text()).not.toContain(GOOD);
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  describe("refuses a weak password, clearly, before any connection or write", () => {
    it.each([
      ["a short one", "admin", /at least 12 bytes \(it is 5\)/],
      ["eleven bytes", "x".repeat(11), /at least 12 bytes \(it is 11\)/],
      ["more than bcrypt reads", "y".repeat(73), /at most 72 bytes \(it is 73\)/],
      ["a multibyte one over 72 bytes", "é".repeat(37), /at most 72 bytes \(it is 74\)/],
      ["none at all (an empty first line)", "", /at least 12 bytes \(it is 0\)/],
    ])("%s", async (_label, password, message) => {
      const h = harness({ stdin: `${password}\n` });

      expect(await h.call(["--email", "a@example.com"])).toBe(EXIT.REFUSED);

      expect(h.err.join("\n")).toMatch(message);
      expect(h.err.join("\n")).toMatch(/Nothing was created/);
      expect(h.connect).not.toHaveBeenCalled();
      expect(h.db.users).toEqual([]);
      expect(h.db.roles).toEqual([]);
      if (password.length > 5) expect(h.text()).not.toContain(password);
    });

    it("and the same when the weak password comes from the environment", async () => {
      const h = harness({ env: { BOOTSTRAP_ADMIN_PASSWORD: "admin" } });
      expect(await h.call(["--email", "a@example.com"])).toBe(EXIT.REFUSED);
      expect(h.err.join("\n")).toMatch(/at least 12 bytes/);
      expect(h.connect).not.toHaveBeenCalled();
    });

    it("accepts exactly 12 and exactly 72 bytes", async () => {
      for (const password of ["Qz7!mK2#vR9&wL4@".repeat(5).slice(0, 12), "Qz7!mK2#vR9&wL4@".repeat(5).slice(0, 72)]) {
        const h = harness({ stdin: `${password}\n` });
        expect(await h.call(["--email", "a@example.com"])).toBe(EXIT.OK);
      }
    });

    it("refuses a trivial password (the deny-list of every account), and a password that is the administrator's own address", async () => {
      for (const [email, password, message] of [
        ["a@example.com", "password1234", /too easy to guess/],
        ["a@example.com", "z".repeat(12), /repeated/],
        ["boss.person@example.com", "boss.person@example.com", /e-mail/],
      ] as const) {
        const h = harness({ stdin: `${password}\n` });
        expect(await h.call(["--email", email])).toBe(EXIT.REFUSED);
        expect(h.err.join("\n")).toMatch(message);
        expect(h.connect).not.toHaveBeenCalled();
      }
    });
  });

  describe("refuses an e-mail that already has an account, saying so, changing nothing", () => {
    it.each([
      ["the same address", "taken@example.com"],
      ["the same address in another letter case and with spaces", "  TAKEN@Example.com "],
    ])("%s", async (_label, email) => {
      const h = harness({ env: { BOOTSTRAP_ADMIN_PASSWORD: GOOD }, existing: ["taken@example.com"] });

      expect(await h.call(["--email", email])).toBe(EXIT.REFUSED);

      expect(h.err.join("\n")).toMatch(/An account for taken@example\.com already exists, so nothing was created/);
      expect(h.err.join("\n")).toMatch(/never changes or promotes an existing account/);
      expect(h.db.users).toHaveLength(1);
      expect(h.db.prisma.user.create).not.toHaveBeenCalled();
      expect(h.db.roles).toEqual([]);
      expect(h.text()).not.toContain(GOOD);
      expect(h.close).toHaveBeenCalledTimes(1);
    });

    it("also when somebody created the account between the look-up and the insert (the helper reports it)", async () => {
      const h = harness({ env: { BOOTSTRAP_ADMIN_PASSWORD: GOOD } });
      h.db.prisma.user.findFirst
        .mockResolvedValueOnce(null) // the script's own look-up
        .mockResolvedValueOnce(null) // the helper's look-up, before the insert that loses the race
        .mockResolvedValueOnce({ id: "winner", email: "race@example.com", password: "hashed:somebody else's" }); // the helper's look-up after it
      h.db.prisma.user.create.mockRejectedValueOnce(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));

      expect(await h.call(["--email", "race@example.com"])).toBe(EXIT.REFUSED);
      expect(h.err.join("\n")).toMatch(/nothing was created|Nothing was created/);
      expect(h.db.roles).toEqual([]);
    });
  });

  describe("where the password comes from", () => {
    it("standard input: the first line only, with the line ending removed", async () => {
      const h = harness({ stdin: `${GOOD}\r\nsecond line ignored\n` });
      expect(await h.call(["--email", "a@example.com"])).toBe(EXIT.OK);
      expect(h.db.users[0].password).toBe(`hashed:${GOOD}`);
    });

    it("the environment wins over standard input and is never read from a terminal", async () => {
      const h = harness({ env: { BOOTSTRAP_ADMIN_PASSWORD: GOOD }, stdin: "a different password!\n", isTTY: true });
      expect(await h.call(["--email", "a@example.com"])).toBe(EXIT.OK);
      expect(h.db.users[0].password).toBe(`hashed:${GOOD}`);
      expect(h.terminal.readSecret).not.toHaveBeenCalled();
      expect(h.terminal.readStdin).not.toHaveBeenCalled();
    });

    it("a terminal: asked twice, hidden, and the two must agree", async () => {
      const ok = harness({ isTTY: true, secrets: [GOOD, GOOD] });
      expect(await ok.call(["--email", "a@example.com"])).toBe(EXIT.OK);
      expect(ok.terminal.readSecret).toHaveBeenCalledTimes(2);
      expect(ok.terminal.readStdin).not.toHaveBeenCalled();

      const differ = harness({ isTTY: true, secrets: [GOOD, `${GOOD}!`] });
      expect(await differ.call(["--email", "a@example.com"])).toBe(EXIT.REFUSED);
      expect(differ.err.join("\n")).toMatch(/two passwords differ/);
      expect(differ.connect).not.toHaveBeenCalled();
      expect(differ.text()).not.toContain(GOOD);
    });
  });

  describe("where the e-mail comes from", () => {
    it("--email=value, --email value, then BOOTSTRAP_ADMIN_EMAIL, then a question on a terminal; the flag wins", async () => {
      const cases: Array<[string[], Record<string, string>, boolean, string]> = [
        [["--email=a@example.com"], {}, false, "a@example.com"],
        [["--email", "b@example.com"], {}, false, "b@example.com"],
        [[], { BOOTSTRAP_ADMIN_EMAIL: "c@example.com" }, false, "c@example.com"],
        [["--email", "d@example.com"], { BOOTSTRAP_ADMIN_EMAIL: "ignored@example.com" }, false, "d@example.com"],
        [[], {}, true, "asked@example.com"],
      ];
      for (const [argv, env, isTTY, expected] of cases) {
        const h = harness({ env: { BOOTSTRAP_ADMIN_PASSWORD: GOOD, ...env }, isTTY, line: "asked@example.com" });
        expect(await h.call(argv), expected).toBe(EXIT.OK);
        expect(h.db.users.map((u) => u.email)).toEqual([expected]);
      }
    });

    it("is a usage error, not a guess, when there is no e-mail and nobody to ask", async () => {
      const h = harness({ env: { BOOTSTRAP_ADMIN_PASSWORD: GOOD } });
      expect(await h.call([])).toBe(EXIT.USAGE);
      expect(h.err.join("\n")).toMatch(/An e-mail is needed/);
      expect(h.connect).not.toHaveBeenCalled();
    });

    it("refuses something that is not an address through the helper, creating nothing", async () => {
      const h = harness({ env: { BOOTSTRAP_ADMIN_PASSWORD: GOOD } });
      expect(await h.call(["--email", "not-an-address"])).toBe(EXIT.REFUSED);
      expect(h.err.join("\n")).toMatch(/not a usable e-mail address/);
      expect(h.db.users).toEqual([]);
    });
  });

  describe("usage", () => {
    it("--help prints the usage and exits 0 without touching anything", async () => {
      const h = harness();
      expect(await h.call(["--help"])).toBe(EXIT.OK);
      expect(h.out.join("\n")).toMatch(/Usage: npm run admin:create/);
      expect(h.connect).not.toHaveBeenCalled();
    });

    it.each([["an unknown flag", ["--nope"]], ["a stray argument", ["a@example.com"]], ["--email without a value", ["--email"]]])("%s is a usage error", async (_l, argv) => {
      const h = harness({ env: { BOOTSTRAP_ADMIN_PASSWORD: GOOD } });
      expect(await h.call(argv)).toBe(EXIT.USAGE);
      expect(h.connect).not.toHaveBeenCalled();
    });

    it("the password is not accepted as an argument (it would sit in the process list), and the answer does not repeat it", async () => {
      for (const argv of [["--password", "hunter2hunter2"], ["--password=hunter2hunter2"]]) {
        const h = harness();
        expect(await h.call(["--email", "a@example.com", ...argv])).toBe(EXIT.USAGE);
        expect(h.err.join("\n")).toMatch(/not accepted as an argument/);
        expect(h.text()).not.toContain("hunter2hunter2");
      }
    });

    it("parseArgs reads the e-mail in both spellings", () => {
      expect(parseArgs(["--email", "a@b.c"])).toEqual({ ok: true, email: "a@b.c", help: false });
      expect(parseArgs(["--email=a@b.c", "-h"])).toEqual({ ok: true, email: "a@b.c", help: true });
    });
  });

  describe("failures of the outside world", () => {
    it("a database that cannot be opened is reported, not thrown", async () => {
      const h = harness({ env: { BOOTSTRAP_ADMIN_PASSWORD: GOOD } });
      h.connect.mockRejectedValueOnce(new Error("DATABASE_URL is required"));
      expect(await h.call(["--email", "a@example.com"])).toBe(EXIT.REFUSED);
      expect(h.err.join("\n")).toMatch(/Could not open the database: DATABASE_URL is required/);
    });

    it("a write that fails is reported, the connection is closed, and the password is not in the message", async () => {
      const h = harness({ env: { BOOTSTRAP_ADMIN_PASSWORD: GOOD } });
      h.db.prisma.user.create.mockRejectedValueOnce(new Error("connection lost"));
      expect(await h.call(["--email", "a@example.com"])).toBe(EXIT.REFUSED);
      expect(h.err.join("\n")).toMatch(/Could not create the administrator: connection lost/);
      expect(h.text()).not.toContain(GOOD);
      expect(h.close).toHaveBeenCalledTimes(1);
    });
  });

  it("is wired as the `admin:create` script of package.json, through tsx (it imports the TypeScript helper)", () => {
    const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;
    expect(scripts["admin:create"]).toBe("tsx scripts/admin-create.mjs");
  });

  it("starts as the CLI through tsx: the helper is CommonJS there, so the script reads its names through the namespace (a named import did not start)", () => {
    const tsx = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const out = execFileSync(process.execPath, [tsx, "scripts/admin-create.mjs", "--help"], { encoding: "utf8", timeout: 120_000 });
    expect(out).toContain("Usage: npm run admin:create");
  }, 150_000);

  it("the seed and the script are the only importers of the bootstrap module", () => {
    expect(readFileSync("prisma/seed.ts", "utf8")).toMatch(/from "\.\.\/src\/lib\/admin-bootstrap"/);
    expect(readFileSync("scripts/admin-create.mjs", "utf8")).toMatch(/import\("\.\.\/src\/lib\/admin-bootstrap"\)/);
  });
});
