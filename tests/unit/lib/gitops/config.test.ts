import { afterAll, beforeAll, describe, it, expect } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import {
  GitOpsConfigSchema,
  loadGitOpsConfig,
  applyGitOpsEnvironment,
  requiredGitOpsSetupFields,
  resolveGitOpsApp,
  getGitOpsWorkerSettings,
} from "@/lib/gitops/config.mjs";

const directory = mkdtempSync(join(tmpdir(), "super-schema-gitops-config-"));
const sample = resolve("gitops.config.example.yaml");
const cli = resolve(
  `node_modules/.cache/gitops-config-test-${process.pid}.mjs`,
);
const file = (text: string) => {
  const path = join(
    directory,
    `config-${Math.random().toString(36).slice(2)}.yaml`,
  );
  writeFileSync(path, text);
  return path;
};
beforeAll(async () => {
  await build({
    entryPoints: ["scripts/gitops-config.ts"],
    outfile: cli,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    alias: { "server-only": resolve("scripts/stubs/server-only.cjs") },
    logLevel: "silent",
  });
});
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
  rmSync(cli, { force: true });
});

describe("portable GitOps configuration", () => {
  it("can disable automatic file discovery for an isolated process", () => {
    const path = join(directory, "gitops.config.yaml");
    writeFileSync(path, readFileSync(sample));
    try {
      expect(
        loadGitOpsConfig({ cwd: directory, env: { GITOPS_CONFIG_FILE: "" } }),
      ).toBeNull();
      expect(
        loadGitOpsConfig({ configPath: path, env: { GITOPS_CONFIG_FILE: "" } })
          ?.config.version,
      ).toBe(1);
    } finally {
      unlinkSync(path);
    }
  });
  it("ships a generic, valid sample with only installation-specific fields left blank", () => {
    const text = readFileSync(sample, "utf8"),
      loaded = loadGitOpsConfig({ configPath: sample })!;
    expect(text).not.toMatch(/paypal|onepay|jsenjaliya/i);
    expect(readFileSync(resolve(".env.example"), "utf8")).not.toMatch(
      /paypal|onepay|jsenjaliya/i,
    );
    expect(loaded.config).toMatchObject({
      application: { url: "http://localhost:3000", contentStorage: "database" },
      repository: {
        url: "",
        root: "superschema",
        sourceBranch: "gitops/development",
      },
      workflow: { owners: [], targets: [] },
    });
    expect(loaded.config.workflow.stages.map((s) => s.name)).toEqual([
      "development",
      "staging",
      "qa",
      "production",
    ]);
    expect(requiredGitOpsSetupFields(loaded.config)).toEqual([
      "repository.url",
      "repository.installationId",
      "scope.tenantId",
      "scope.operatorEmail",
    ]);
  });
  it("uses the same defaults when optional sections are omitted", () => {
    const defaults = GitOpsConfigSchema.parse({ version: 1 });
    expect({
      ...defaults,
      scope: { ...defaults.scope, contentStorage: "database" },
    }).toEqual(loadGitOpsConfig({ configPath: sample })!.config);
  });
  it("allows a whole-repository root, custom stages, hosts, owners and target bindings", () => {
    const config = GitOpsConfigSchema.parse({
      application: { url: "https://schemas.example.com" },
      repository: {
        url: "https://git.example.com/acme/contracts",
        sourceBranch: "develop",
        root: "",
      },
      github: {
        baseUrl: "https://git.example.com",
        allowedHosts: ["git.example.com"],
      },
      workflow: {
        owners: ["@acme/contracts"],
        stages: [
          { name: "integration", branch: "develop" },
          { name: "live", branch: "release/live" },
        ],
        targets: [
          {
            target: "json-schema",
            repositoryUrl: "https://git.example.com/acme/artifacts",
            installationId: "2",
            branch: "main",
          },
        ],
      },
      products: [
        { productId: "p1", basePath: "nested/root", owners: ["@alice"] },
      ],
      worker: { intervalMs: 1500, pollIntervalMs: 120000, batchSize: 10 },
    });
    expect(config.repository.root).toBe("");
    expect(config.workflow.stages[0].path).toBe("environments");
    expect(config.products[0].basePath).toBe("nested/root");
  });
  it.each(["../outside", "/absolute", "folder/../outside", "folder\\outside"])(
    "refuses an unsafe repository root %s",
    (root) => {
      expect(() =>
        GitOpsConfigSchema.parse({ repository: { root } }),
      ).toThrow();
    },
  );
  it.each([
    "http://remote.example.com",
    "https://example.com/path",
    "https://user:password@example.com",
  ])("refuses an invalid application origin %s", (url) => {
    expect(() =>
      loadGitOpsConfig({ configPath: file(`application:\n  url: ${url}\n`) }),
    ).toThrow("application.url");
  });
  it("validates source-stage agreement and unique environment branches", () => {
    expect(() =>
      GitOpsConfigSchema.parse({ repository: { sourceBranch: "other" } }),
    ).toThrow();
    expect(() =>
      GitOpsConfigSchema.parse({
        workflow: {
          stages: [
            { name: "development", branch: "gitops/development" },
            { name: "production", branch: "gitops/development" },
          ],
        },
      }),
    ).toThrow();
  });
  it.each([
    "https://example.com/api/other",
    "http://example.com/api/gitops/process",
    "https://example.com/api/gitops/process?token=secret",
  ])("refuses an invalid worker endpoint %s", (url) => {
    expect(() => GitOpsConfigSchema.parse({ worker: { url } })).toThrow();
  });
  it("keeps legacy startup unchanged without a file and rejects a missing explicit file", () => {
    expect(loadGitOpsConfig({ cwd: directory, env: {} })).toBeNull();
    expect(() =>
      loadGitOpsConfig({
        cwd: directory,
        env: { GITOPS_CONFIG_FILE: "missing.yaml" },
      }),
    ).toThrow("does not exist");
  });
  it("rejects unknown fields and malformed YAML without echoing secret values", () => {
    for (const text of [
      "unknown: do-not-echo-this-secret",
      "repository:\n  privateKey: do-not-echo-this-secret",
      "version: 1\nversion: 2",
      "a: &secret [do-not-echo-this-secret]\nb: *secret",
    ]) {
      let message = "";
      try {
        loadGitOpsConfig({ configPath: file(text) });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain("do-not-echo-this-secret");
    }
  });
  it("maps runtime values and secret references while preserving environment overrides", () => {
    const loaded = loadGitOpsConfig({
      configPath: file(
        "application:\n  url: https://schemas.example.com\n  contentStorage: git\ndatabase:\n  provider: postgresql\n  dataDirectory: embedded\n  connectionStringEnv: CUSTOM_DB_URL\nsecurity:\n  encryptionKeyEnv: CUSTOM_KEY\nworker:\n  tokenEnv: CUSTOM_TOKEN\n  intervalMs: 1500\n  pollIntervalMs: 45000\n  batchSize: 9\n",
      ),
    })!;
    const env: Record<string, string | undefined> = {
      CUSTOM_DB_URL: "postgresql://fixture",
      CUSTOM_KEY: "existing-key",
      CUSTOM_TOKEN: "worker-secret",
    };
    applyGitOpsEnvironment(loaded, env);
    expect(env).toMatchObject({
      AUTH_URL: "https://schemas.example.com",
      CONTENT_STORAGE: "git",
      DB_PROVIDER: "postgresql",
      DATABASE_URL: "postgresql://fixture",
      SECRETS_ENCRYPTION_KEY: "existing-key",
      GITOPS_WORKER_TOKEN: "worker-secret",
      GITOPS_WORKER_URL: "https://schemas.example.com/api/gitops/process",
      GITOPS_WORKER_BATCH_SIZE: "9",
      PGLITE_DATA_DIR: join(directory, "embedded"),
    });
    const override = {
      ...env,
      AUTH_URL: "https://override.example.com",
      DB_PROVIDER: "pglite",
      GITOPS_WORKER_URL: "https://override.example.com/api/gitops/process",
      GITOPS_WORKER_BATCH_SIZE: "2",
    };
    applyGitOpsEnvironment(loaded, override);
    expect(override.AUTH_URL).toBe("https://override.example.com");
    expect(override.DB_PROVIDER).toBe("pglite");
    expect(getGitOpsWorkerSettings(override).batchSize).toBe(2);
  });
  it("preserves the existing authentication origin and encryption fallback", () => {
    const loaded = loadGitOpsConfig({ configPath: sample })!,
      env: Record<string, string | undefined> = {
        NEXTAUTH_URL: "https://existing.example.com",
      };
    applyGitOpsEnvironment(loaded, env);
    expect(env.AUTH_URL).toBe(env.NEXTAUTH_URL);
    expect(env.SECRETS_ENCRYPTION_KEY).toBeUndefined();
  });
  it("supports App credentials by environment reference or a file-relative PEM", () => {
    const path = file(
        "github:\n  app:\n    appId: '123'\n    clientId: Iv1.example\n    privateKeyFile: test.pem\n",
      ),
      key = "fixture-private-key";
    writeFileSync(join(directory, "test.pem"), key);
    const loaded = loadGitOpsConfig({ configPath: path })!;
    expect(() => resolveGitOpsApp(loaded, {})).toThrow(
      "GITOPS_GITHUB_CLIENT_SECRET",
    );
    expect(
      resolveGitOpsApp(loaded, {
        GITOPS_GITHUB_CLIENT_SECRET: "client-secret",
        GITOPS_GITHUB_WEBHOOK_SECRET: "webhook-secret",
      })?.privateKey,
    ).toBe(key);
    expect(
      resolveGitOpsApp(loadGitOpsConfig({ configPath: sample })!, {}),
    ).toBeNull();
  });
  it("bounds worker intervals and batch sizes from environment variables", () => {
    expect(() =>
      getGitOpsWorkerSettings({ GITOPS_WORKER_BATCH_SIZE: "21" }),
    ).toThrow("GITOPS_WORKER_BATCH_SIZE");
    expect(() =>
      getGitOpsWorkerSettings({ GITOPS_BINDING_POLL_INTERVAL_MS: "bad-value" }),
    ).toThrow("GITOPS_BINDING_POLL_INTERVAL_MS");
  });
  it("validates the copied template without opening a database or exposing secrets", () => {
    const dataDir = join(directory, "must-not-open");
    const result = spawnSync(
      process.execPath,
      [cli, "validate", "--config", sample],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DB_PROVIDER: "pglite",
          PGLITE_DATA_DIR: dataDir,
          GITOPS_GITHUB_CLIENT_SECRET: "must-not-print-secret",
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Required before apply");
    expect(result.stdout).not.toContain("must-not-print-secret");
    expect(existsSync(dataDir)).toBe(false);
    const apply = spawnSync(
      process.execPath,
      [cli, "apply", "--config", sample],
      { encoding: "utf8", env: { ...process.env, PGLITE_DATA_DIR: dataDir } },
    );
    expect(apply.status).toBe(1);
    expect(apply.stderr).toContain("Complete these fields");
    expect(existsSync(dataDir)).toBe(false);
  });
});
