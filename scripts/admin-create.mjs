// Creates ONE platform administrator (a user with the global ADMIN assignment) without seeding anything.
//
//   npm run admin:create -- --email you@example.com        (the password is asked for, twice, and not shown)
//   printf '%s\n' "$PASSWORD" | npm run admin:create -- --email you@example.com
//   BOOTSTRAP_ADMIN_EMAIL=you@example.com BOOTSTRAP_ADMIN_PASSWORD=... npm run admin:create
//
// The password is never a command-line argument (it would sit in the process list and the shell history) and is never printed. It must be
// 12 to 72 bytes. An e-mail that already has an account is REFUSED: this command makes a new account, it never promotes or changes an
// existing one. It uses the same helper as the seed (src/lib/admin-bootstrap.ts: `ensureBootstrapAdmin`), against the database the
// environment names (DB_PROVIDER, DATABASE_URL, PGLITE_DATA_DIR; a `.env` is read like the seed does). With the embedded PGlite provider
// the data directory belongs to one process: stop the dev server first.
//
// Run through tsx (it imports the TypeScript helper): the `admin:create` script of package.json. `run` is exported for the unit test, with
// every outside thing (arguments, environment, terminal, database) passed in.

import { isEntryPoint } from "./e2e-entry.mjs";
// tsx compiles the TypeScript helper to CommonJS (package.json has no "type": "module"), and an ES module cannot import the named exports of a
// CommonJS module by name: the loader does not see them, and the script would not start. Through the namespace, `default` is the CommonJS
// exports object; a real ES module has no `default` and its names are on the namespace itself.
const bootstrap = await import("../src/lib/admin-bootstrap");
const { ensureBootstrapAdmin, normalizeBootstrapEmail, validateBootstrapPassword } = bootstrap.default ?? bootstrap;

const USAGE = [
  "Usage: npm run admin:create -- --email <address>",
  "",
  "  --email <address>   the new administrator's e-mail (or BOOTSTRAP_ADMIN_EMAIL; asked for on a terminal when neither is given)",
  "  password            from BOOTSTRAP_ADMIN_PASSWORD, else the first line of standard input when it is piped, else asked for twice on a terminal",
  "                      (12 to 72 bytes; never a command-line argument)",
  "  -h, --help          this text",
  "",
  "Refuses a weak password and an e-mail that already has an account; changes nothing then.",
].join("\n");

/** Exit codes: 0 done, 1 refused or failed, 2 the command was used wrongly. */
export const EXIT = Object.freeze({ OK: 0, REFUSED: 1, USAGE: 2 });

/**
 * @param {string[]} argv the arguments after the script name
 * @returns {{ ok: true, email?: string, help: boolean } | { ok: false, message: string }}
 */
export function parseArgs(argv) {
  /** @type {string | undefined} */
  let email;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") help = true;
    else if (arg === "--email") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) return { ok: false, message: "--email needs an address." };
      email = value;
    } else if (arg.startsWith("--email=")) email = arg.slice("--email=".length);
    else if (arg === "--password" || arg.startsWith("--password=")) {
      return { ok: false, message: "The password is not accepted as an argument (it would be visible in the process list); use the prompt, standard input or BOOTSTRAP_ADMIN_PASSWORD." };
    } else return { ok: false, message: `Unknown argument "${arg}".` };
  }
  return { ok: true, email, help };
}

/**
 * @typedef {{
 *   isTTY: boolean,
 *   readLine: (prompt: string) => Promise<string>,
 *   readSecret: (prompt: string) => Promise<string>,
 *   readStdin: () => Promise<string>,
 * }} Terminal
 * @typedef {{ prisma: any, close: () => Promise<void> }} Connection
 * @typedef {{
 *   argv: string[],
 *   env: Record<string, string | undefined>,
 *   out: (line: string) => void,
 *   err: (line: string) => void,
 *   terminal: Terminal,
 *   connect: () => Promise<Connection>,
 * }} Deps
 */

/**
 * @param {Deps} deps
 * @returns {Promise<number>} the exit code
 */
export async function run({ argv, env, out, err, terminal, connect }) {
  const args = parseArgs(argv);
  if (!args.ok) {
    err(args.message);
    err(USAGE);
    return EXIT.USAGE;
  }
  if (args.help) {
    out(USAGE);
    return EXIT.OK;
  }

  // 1. The e-mail: the flag, else the environment, else a question when someone is there to answer it.
  let rawEmail = args.email ?? (env.BOOTSTRAP_ADMIN_EMAIL ? env.BOOTSTRAP_ADMIN_EMAIL : undefined);
  if (rawEmail === undefined && terminal.isTTY) rawEmail = await terminal.readLine("E-mail of the new administrator: ");
  if (rawEmail === undefined || rawEmail.trim() === "") {
    err("An e-mail is needed: pass --email <address> (or set BOOTSTRAP_ADMIN_EMAIL).");
    err(USAGE);
    return EXIT.USAGE;
  }
  const email = normalizeBootstrapEmail(rawEmail);

  // 2. The password: the environment, else standard input when piped, else asked for twice. Judged BEFORE any connection is made.
  /** @type {string | undefined} */
  let password = env.BOOTSTRAP_ADMIN_PASSWORD ? env.BOOTSTRAP_ADMIN_PASSWORD : undefined;
  if (password === undefined) {
    if (terminal.isTTY) {
      const first = await terminal.readSecret("Password (12 to 72 bytes, not shown): ");
      const again = await terminal.readSecret("Password again: ");
      if (first !== again) {
        err("The two passwords differ. Nothing was created.");
        return EXIT.REFUSED;
      }
      password = first;
    } else {
      const piped = await terminal.readStdin();
      password = piped.split(/\r?\n/, 1)[0];
    }
  }
  const policy = validateBootstrapPassword(password ?? "", email);
  if (!policy.ok) {
    err(`${policy.message} Nothing was created.`);
    return EXIT.REFUSED;
  }
  const secret = /** @type {string} */ (password);

  // 3. The database.
  let connection;
  try {
    connection = await connect();
  } catch (error) {
    err(`Could not open the database: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.REFUSED;
  }
  try {
    const existing = await connection.prisma.user.findFirst({ where: { email }, select: { id: true } });
    if (existing) {
      err(
        `An account for ${email} already exists, so nothing was created: this command never changes or promotes an existing account. ` +
          "Use another e-mail address, or give that account the administrator role from Admin, Users. " +
          "(To promote it from the command line, run the seed with BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD set to its e-mail and its own password.)",
      );
      return EXIT.REFUSED;
    }
    const result = await ensureBootstrapAdmin({ email, password: secret }, connection.prisma);
    if (result.status === "created") {
      out(`Created administrator ${email} (user id ${result.userId}) with the global ADMIN role.`);
      return EXIT.OK;
    }
    // Only reachable when someone else made the account between the look-up and the insert.
    err(
      result.status === "refused"
        ? `${result.message} Nothing was created.`
        : `An account for ${email} already exists, so nothing was created.`,
    );
    return EXIT.REFUSED;
  } catch (error) {
    err(`Could not create the administrator: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.REFUSED;
  } finally {
    await connection.close().catch(() => undefined);
  }
}

// ── the real terminal and database (not used by the unit test) ───────────────────────────────────────────────────────────

/** @returns {Promise<Terminal>} */
async function realTerminal() {
  const readline = await import("node:readline");

  /** @param {string} prompt */
  const readLine = (prompt) =>
    new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer);
      });
    });

  /** Reads a line from the terminal without echoing it (raw mode, Backspace and Ctrl-C honoured). @param {string} prompt */
  const readSecret = (prompt) =>
    new Promise((resolve, reject) => {
      process.stdout.write(prompt);
      const stdin = process.stdin;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");
      let value = "";
      /** @param {string} chunk */
      const onData = (chunk) => {
        for (const ch of chunk) {
          if (ch === "\r" || ch === "\n" || ch === "\u0004") {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.removeListener("data", onData);
            process.stdout.write("\n");
            resolve(value);
            return;
          }
          if (ch === "\u0003") {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.removeListener("data", onData);
            process.stdout.write("\n");
            reject(new Error("Interrupted."));
            return;
          }
          if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
          else value += ch;
        }
      };
      stdin.on("data", onData);
    });

  const readStdin = async () => {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    return Buffer.concat(chunks).toString("utf8");
  };

  return { isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY), readLine, readSecret, readStdin };
}

/** @returns {Promise<Connection>} a Prisma client on the database the environment names (like prisma/seed.ts). */
async function realConnect() {
  await import("dotenv/config");
  const [{ PrismaClient }, { createDbAdapter }] = await Promise.all([import("../src/generated/prisma/client"), import("../src/lib/db-adapter")]);
  const prisma = new PrismaClient({ adapter: createDbAdapter() });
  return { prisma, close: () => prisma.$disconnect() };
}

async function main() {
  const code = await run({
    argv: process.argv.slice(2),
    env: process.env,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    terminal: await realTerminal(),
    connect: realConnect,
  });
  // The embedded database keeps the process alive until it is closed; the exit code is decided already.
  process.exit(code);
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
