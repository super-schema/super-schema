import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";

const envName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
const emptyOrUrl = z.union([z.literal(""), z.string().url()]);
const githubOrigin = z
  .string()
  .url()
  .refine((value) => {
    try {
      const u = new URL(value);
      return (
        u.protocol === "https:" &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        u.pathname === "/"
      );
    } catch {
      return false;
    }
  })
  .transform((value) => new URL(value).origin);
const branch = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (s) =>
      !/[\x00-\x20~^:?*\[\\]/.test(s) &&
      !s.includes("..") &&
      !s.includes("@{") &&
      !s.startsWith("-") &&
      !s.startsWith("/") &&
      !s.endsWith("/") &&
      !s.endsWith(".") &&
      s
        .split("/")
        .every((p) => p && !p.startsWith(".") && !p.endsWith(".lock")),
  );
const root = z
  .string()
  .max(400)
  .refine(
    (s) =>
      !s.startsWith("/") &&
      !s.endsWith("/") &&
      !/[\\\x00-\x1f\x7f]/.test(s) &&
      s.split("/").every((p) => p !== "." && p !== ".." && (p || s === "")),
  );
const owner = z.string().regex(/^@[a-zA-Z0-9-]+(?:\/[a-zA-Z0-9_.-]+)?$/);
export const DEFAULT_GITOPS_STAGES = [
  "development",
  "staging",
  "qa",
  "production",
].map((name) => ({ name, branch: `gitops/${name}`, path: "environments" }));
const stages = z
  .array(
    z
      .object({
        name: z.string().trim().min(1).max(100),
        branch,
        path: root.default("environments"),
      })
      .strict(),
  )
  .min(1)
  .max(50)
  .refine(
    (a) =>
      new Set(a.map((s) => s.name)).size === a.length &&
      new Set(a.map((s) => s.branch)).size === a.length,
  );
const target = z
  .object({
    target: z.string().min(1),
    repositoryUrl: z.string().url(),
    installationId: z.string().regex(/^\d+$/),
    branch,
    pathTemplate: z
      .string()
      .min(1)
      .default("artifacts/{product}/{object}/{version}/{target}"),
    enabled: z.boolean().default(true),
  })
  .strict();
const workflow = z
  .object({
    owners: z.array(owner).max(100).default([]),
    stages: stages.default(() => DEFAULT_GITOPS_STAGES.map((s) => ({ ...s }))),
    targets: z.array(target).max(100).default([]),
  })
  .strict();

/** Node-only deployment configuration. Canonical content and secrets are never in this file. */
export const GitOpsConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    application: z
      .object({
        url: z.string().url().default("http://localhost:3000"),
        contentStorage: z.enum(["database", "git"]).default("database"),
      })
      .strict()
      .prefault({}),
    database: z
      .object({
        provider: z.enum(["pglite", "postgresql"]).default("pglite"),
        dataDirectory: z.string().min(1).default("./data/pglite"),
        connectionStringEnv: envName.default("DATABASE_URL"),
      })
      .strict()
      .prefault({}),
    security: z
      .object({ encryptionKeyEnv: envName.default("SECRETS_ENCRYPTION_KEY") })
      .strict()
      .prefault({}),
    github: z
      .object({
        baseUrl: githubOrigin.default("https://github.com"),
        allowedHosts: z
          .array(z.string().regex(/^[a-zA-Z0-9.-]+$/))
          .min(1)
          .default(["github.com"]),
        app: z
          .object({
            name: z.string().min(1).max(34).default("super-schema-gitops"),
            appId: z.string().regex(/^\d*$/).default(""),
            clientId: z.string().max(200).default(""),
            privateKeyEnv: envName.default("GITOPS_GITHUB_PRIVATE_KEY"),
            privateKeyFile: z.string().default(""),
            clientSecretEnv: envName.default("GITOPS_GITHUB_CLIENT_SECRET"),
            webhookSecretEnv: envName.default("GITOPS_GITHUB_WEBHOOK_SECRET"),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
    repository: z
      .object({
        url: emptyOrUrl.default(""),
        installationId: z.string().regex(/^\d*$/).default(""),
        sourceBranch: branch.default("gitops/development"),
        root: root.default("superschema"),
        enabled: z.boolean().default(true),
      })
      .strict()
      .prefault({}),
    scope: z
      .object({
        tenantId: z.string().default(""),
        contentStorage: z.enum(["database", "git"]).optional(),
        productIds: z.array(z.string().min(1)).default([]),
        operatorEmail: z.union([z.literal(""), z.string().email()]).default(""),
      })
      .strict()
      .prefault({}),
    workflow: workflow.prefault({}),
    products: z
      .array(
        z
          .object({
            productId: z.string().min(1),
            owners: z.array(owner).max(100).optional(),
            stages: stages.optional(),
            targets: z.array(target).max(100).optional(),
            repositoryUrl: z.string().url().optional(),
            installationId: z.string().regex(/^\d+$/).optional(),
            branch: branch.optional(),
            basePath: root.optional(),
          })
          .strict(),
      )
      .default([]),
    worker: z
      .object({
        url: emptyOrUrl.default(""),
        tokenEnv: envName.default("GITOPS_WORKER_TOKEN"),
        intervalMs: z.number().int().min(250).max(300000).default(5000),
        pollIntervalMs: z
          .number()
          .int()
          .min(1000)
          .max(86400000)
          .default(300000),
        batchSize: z.number().int().min(1).max(20).default(5),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.workflow.stages[0].branch !== config.repository.sourceBranch)
      ctx.addIssue({
        code: "custom",
        path: ["workflow", "stages"],
        message: "The first stage must use the repository source branch",
      });
    if (
      new Set(config.products.map((p) => p.productId)).size !==
      config.products.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["products"],
        message: "Product overrides must be unique",
      });
    let url;
    try {
      url = new URL(config.application.url);
    } catch {
      return;
    }
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        ))
    )
      ctx.addIssue({
        code: "custom",
        path: ["application", "url"],
        message: "Use an HTTPS origin or local HTTP origin",
      });
    if (config.worker.url) {
      try {
        const u = new URL(config.worker.url);
        if (
          u.pathname !== "/api/gitops/process" ||
          u.username ||
          u.password ||
          u.search ||
          u.hash ||
          (u.protocol !== "https:" &&
            !(
              u.protocol === "http:" &&
              ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
            ))
        )
          throw new Error();
      } catch {
        ctx.addIssue({
          code: "custom",
          path: ["worker", "url"],
          message: "Use the exact worker endpoint over HTTPS or local HTTP",
        });
      }
    }
  });

export class GitOpsConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "GitOpsConfigurationError";
  }
}

/** @param {{configPath?:string, env?:Record<string,string|undefined>, cwd?:string, required?:boolean}} [options] */
export function loadGitOpsConfig(options = {}) {
  const env = options.env ?? process.env;
  // Empty disables automatic discovery (for isolated tests/builds). An explicit
  // validation/apply command may still read a named file.
  if (
    options.configPath === undefined &&
    !options.required &&
    env.GITOPS_CONFIG_FILE === ""
  )
    return null;
  const explicit = options.configPath ?? (env.GITOPS_CONFIG_FILE || undefined);
  const filePath = resolve(
    options.cwd ?? process.cwd(),
    explicit ?? "gitops.config.yaml",
  );
  if (!existsSync(filePath)) {
    if (explicit || options.required)
      throw new GitOpsConfigurationError(
        "GitOps configuration file does not exist",
      );
    return null;
  }
  let raw;
  try {
    if (!statSync(filePath).isFile() || statSync(filePath).size > 128 * 1024)
      throw new Error();
    const parsed = parseDocument(readFileSync(filePath, "utf8"), {
      uniqueKeys: true,
      strict: true,
    });
    if (parsed.errors.length) throw new Error();
    raw = parsed.toJS({ maxAliasCount: 0 });
  } catch {
    throw new GitOpsConfigurationError(
      "GitOps configuration must be valid YAML with unique keys, no aliases, and at most 128 KiB",
    );
  }
  const parsed = GitOpsConfigSchema.safeParse(raw);
  if (!parsed.success)
    throw new GitOpsConfigurationError(
      `Invalid GitOps configuration: ${parsed.error.issues.map((i) => `${i.path.join(".") || "config"} (${i.code})`).join(", ")}`,
    );
  return { config: parsed.data, filePath, directory: dirname(filePath) };
}

/** @param {z.infer<typeof GitOpsConfigSchema>} config */
export function requiredGitOpsSetupFields(config) {
  return [
    !config.repository.url && "repository.url",
    !config.repository.installationId && "repository.installationId",
    !config.scope.tenantId && "scope.tenantId",
    !config.scope.operatorEmail && "scope.operatorEmail",
  ].filter(Boolean);
}

/** Existing process/.env values win. File-relative database paths are resolved without touching the database.
 * @param {NonNullable<ReturnType<typeof loadGitOpsConfig>>} loaded
 * @param {Record<string,string|undefined>} [env]
 */
export function applyGitOpsEnvironment(loaded, env = process.env) {
  const { config: c, directory } = loaded;
  const set = (key, value) => {
    if (env[key] === undefined && value !== undefined) env[key] = String(value);
  };
  set("AUTH_URL", env.NEXTAUTH_URL ?? c.application.url);
  set("CONTENT_STORAGE", c.application.contentStorage);
  set("DB_PROVIDER", c.database.provider);
  set("PGLITE_DATA_DIR", resolve(directory, c.database.dataDirectory));
  set("DATABASE_URL", env[c.database.connectionStringEnv]);
  set("SECRETS_ENCRYPTION_KEY", env[c.security.encryptionKeyEnv]);
  set("DEPLOYMENT_GIT_HOSTS", c.github.allowedHosts.join(","));
  set("GITOPS_WORKER_TOKEN", env[c.worker.tokenEnv]);
  set(
    "GITOPS_WORKER_URL",
    c.worker.url || new URL("/api/gitops/process", env.AUTH_URL).href,
  );
  set("GITOPS_WORKER_INTERVAL_MS", c.worker.intervalMs);
  set("GITOPS_BINDING_POLL_INTERVAL_MS", c.worker.pollIntervalMs);
  set("GITOPS_WORKER_BATCH_SIZE", c.worker.batchSize);
  getGitOpsWorkerSettings(env);
}

const initialized = new WeakSet();
/** @param {Record<string,string|undefined>} [env] */
export function initializeGitOpsEnvironment(env = process.env) {
  if (initialized.has(env)) return;
  const loaded = loadGitOpsConfig({ env });
  if (loaded) applyGitOpsEnvironment(loaded, env);
  initialized.add(env);
}

/** @param {Record<string,string|undefined>} [env] */
export function getGitOpsWorkerSettings(env = process.env) {
  const number = (name, fallback, min, max) => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    if (
      !/^\d+$/.test(raw) ||
      !Number.isSafeInteger(Number(raw)) ||
      Number(raw) < min ||
      Number(raw) > max
    )
      throw new GitOpsConfigurationError(`Invalid ${name}`);
    return Number(raw);
  };
  return {
    intervalMs: number("GITOPS_WORKER_INTERVAL_MS", 5000, 250, 300000),
    pollIntervalMs: number(
      "GITOPS_BINDING_POLL_INTERVAL_MS",
      300000,
      1000,
      86400000,
    ),
    batchSize: number("GITOPS_WORKER_BATCH_SIZE", 5, 1, 20),
  };
}

/** Resolve only when an operator explicitly applies App configuration; never return these through the workspace.
 * @param {NonNullable<ReturnType<typeof loadGitOpsConfig>>} loaded
 * @param {Record<string,string|undefined>} [env]
 */
export function resolveGitOpsApp(loaded, env = process.env) {
  const c = loaded.config.github.app;
  if (!c.appId && !c.clientId) return null; // Reuse the App already saved through the UI.
  if (!c.appId || !c.clientId)
    throw new GitOpsConfigurationError(
      "Set both github.app.appId and github.app.clientId",
    );
  const secret = (name) => {
    if (!env[name])
      throw new GitOpsConfigurationError(
        `Set the secret environment variable ${name}`,
      );
    return env[name];
  };
  let privateKey;
  if (c.privateKeyFile) {
    try {
      const file = resolve(loaded.directory, c.privateKeyFile);
      if (statSync(file).size > 32000) throw new Error();
      privateKey = readFileSync(file, "utf8");
    } catch {
      throw new GitOpsConfigurationError(
        "github.app.privateKeyFile could not be read or exceeds 32 KiB",
      );
    }
  } else privateKey = secret(c.privateKeyEnv);
  return {
    appId: c.appId,
    clientId: c.clientId,
    baseUrl: loaded.config.github.baseUrl,
    privateKey,
    clientSecret: secret(c.clientSecretEnv),
    webhookSecret: secret(c.webhookSecretEnv),
  };
}
