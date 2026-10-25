/**
 * What the REST API specs (api-v1.spec.ts) use: three callers of the same app, each a Playwright `APIRequestContext` (no browser), and
 * the checks every JSON answer of the API has to pass.
 *
 *   - `session`  the admin's saved login (the `setup` project's storage state): what a browser's own call is. On the REST API a session
 *                is ALWAYS a viewer (src/app/api/v1/middleware.ts), the admin included;
 *   - `key`      `Authorization: Bearer <the run's API key>`: what a CI job calls with. The key is `E2E_API_KEY`, which the release runner
 *                makes up per run and starts the app with (scripts/e2e-env.mjs). A run that did not come from the runner has none: the
 *                first test that asks for `key` fails with that sentence instead of a 401 that looks like a product bug;
 *   - `anon`     no cookie, no header.
 *
 * Every context sends an `X-Forwarded-For` of its own (an address that is made up per test): the emit, validate and event-spec routes
 * allow 100 requests a minute per client address (src/app/api/v1/rate-limit.ts), and the address is read from that header, so a test
 * gets its own allowance instead of sharing one with every other spec of the run. (That the header decides is itself a finding: KD-028.)
 */
import { randomInt } from "node:crypto";
import { expect, type APIRequestContext, type APIResponse, type PlaywrightWorkerArgs } from "@playwright/test";
import { AUTH_STATE_PATH } from "./auth-state";

type Playwright = PlaywrightWorkerArgs["playwright"];

export interface Callers {
  session: APIRequestContext;
  /** Throws, naming the cause, when the run has no API key. */
  readonly key: APIRequestContext;
  anon: APIRequestContext;
  /** The made-up client address all of them send. */
  ip: string;
  /** A caller with headers of its own (a wrong key, a bad cookie), with the admin's login when `session` is true. */
  custom(headers: Record<string, string>, options?: { session?: boolean }): Promise<APIRequestContext>;
  dispose(): Promise<void>;
}

/** A private address (10.x.x.x): unique enough per test (16 million), and not the loopback address every other caller of the app has. */
export function madeUpClientAddress(): string {
  return `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
}

const NO_LOGIN = { cookies: [], origins: [] } as { cookies: []; origins: [] };

export async function newCallers(playwright: Playwright, baseURL: string | undefined): Promise<Callers> {
  if (!baseURL) throw new Error("the API specs need a baseURL (E2E_BASE_URL, which the release runner sets)");
  const ip = madeUpClientAddress();
  const open: APIRequestContext[] = [];
  const make = async (headers: Record<string, string>, storageState: string | typeof NO_LOGIN) => {
    const context = await playwright.request.newContext({ baseURL, storageState, extraHTTPHeaders: { "x-forwarded-for": ip, ...headers } });
    open.push(context);
    return context;
  };
  const session = await make({}, AUTH_STATE_PATH);
  const anon = await make({}, NO_LOGIN);
  const apiKey = process.env.E2E_API_KEY;
  const key = apiKey ? await make({ authorization: `Bearer ${apiKey}` }, NO_LOGIN) : undefined;
  return {
    session,
    anon,
    ip,
    get key(): APIRequestContext {
      if (!key) {
        throw new Error(
          "E2E_API_KEY is not set: the API-key tests need the key the app was started with. The release runner (scripts/e2e-release.mjs) makes one up per run, starts the app with it as API_KEY and hands the browser run the same value as E2E_API_KEY; a run against a server you started yourself has to set both to one value.",
        );
      }
      return key;
    },
    custom: (headers, options) => make(headers, options?.session ? AUTH_STATE_PATH : NO_LOGIN),
    async dispose() {
      await Promise.all(open.map((context) => context.dispose()));
    },
  };
}

/**
 * A caller signed in as `email`: the credentials callback of Auth.js called the way the login form calls it (the CSRF token, then the form
 * post), with no browser. The user needs a password hash in the database (`createUserWithPassword`, helpers/db.ts). It is the cheap way to
 * a second signed-in user: the register page is a Serializable transaction, and a few registrations at once make some of them answer
 * "Registration failed. Please try again.", which is not what a notification test is about.
 */
export async function signInCaller(playwright: Playwright, baseURL: string | undefined, credentials: { email: string; password: string }): Promise<APIRequestContext> {
  if (!baseURL) throw new Error("signInCaller needs a baseURL");
  const context = await playwright.request.newContext({ baseURL, storageState: NO_LOGIN, extraHTTPHeaders: { "x-forwarded-for": madeUpClientAddress() } });
  const csrf = await context.get("/api/auth/csrf");
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  const response = await context.post("/api/auth/callback/credentials", {
    form: { csrfToken, email: credentials.email, password: credentials.password, callbackUrl: baseURL, json: "true" },
    maxRedirects: 0,
  });
  const session = await (await context.get("/api/auth/session")).json();
  if (!(session as { user?: { email?: string } } | null)?.user?.email) {
    await context.dispose();
    throw new Error(`signing in as ${credentials.email} did not give a session (the callback answered ${response.status()})`);
  }
  return context;
}

/** What an error of the API carries (src/app/api/v1/error-handler.ts). */
export interface ApiErrorBody {
  success: false;
  error: { code: string; message: string; details?: Record<string, unknown>; suggestedFix?: string };
}

export interface ApiSuccessBody<T = unknown> {
  success: true;
  data: T;
  summary?: string;
}

/** Text that must never be in an answer of the API: a stack frame, a file path of the server, a Prisma or driver message, a connection string. */
export const SERVER_INTERNALS =
  /\n\s+at\s+\S|node_modules|\.(?:tsx?|mjs|cjs):\d+|PrismaClient|Invalid `prisma|prisma\.\w+\.\w+\(|SQLSTATE|violates|ECONNREFUSED|postgres(?:ql)?:\/\/|"stack"\s*:/i;

/** The answer as JSON: a body that is not JSON fails the test with the status and the start of what came back. */
export async function jsonOf<T = unknown>(response: APIResponse): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`expected a JSON body from ${response.url()} (status ${response.status()}), got: ${text.slice(0, 300)}`);
  }
}

/** An error answer: the status, a JSON content type, the envelope, the code, a message, and nothing of the server's inside. */
export async function expectApiError(response: APIResponse, status: number, code: string): Promise<ApiErrorBody["error"]> {
  const text = await response.text();
  expect(response.status(), `${response.url()}: ${text.slice(0, 300)}`).toBe(status);
  expect(response.headers()["content-type"], `${response.url()}: not JSON`).toMatch(/application\/json/);
  const body = JSON.parse(text) as ApiErrorBody;
  expect(body.success, text.slice(0, 300)).toBe(false);
  expect(body.error.code, text.slice(0, 300)).toBe(code);
  expect(typeof body.error.message).toBe("string");
  expect(body.error.message.length).toBeGreaterThan(0);
  expect(text, "an error body must not carry the server's internals").not.toMatch(SERVER_INTERNALS);
  return body.error;
}

/** A success answer: 200 (or `status`), JSON, `{ success: true, data }`. Returns the body. */
export async function expectApiSuccess<T = unknown>(response: APIResponse, status = 200): Promise<ApiSuccessBody<T>> {
  const text = await response.text();
  expect(response.status(), `${response.url()}: ${text.slice(0, 300)}`).toBe(status);
  expect(response.headers()["content-type"], `${response.url()}: not JSON`).toMatch(/application\/json/);
  const body = JSON.parse(text) as ApiSuccessBody<T>;
  expect(body.success, text.slice(0, 300)).toBe(true);
  expect(body).toHaveProperty("data");
  return body;
}

/** The sorted own keys of an object: what a test compares to say "exactly these fields, nothing more". */
export const keysOf = (value: unknown): string[] => Object.keys(value as Record<string, unknown>).sort();
