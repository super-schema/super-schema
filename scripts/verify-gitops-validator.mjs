import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
const directory = mkdtempSync(join(tmpdir(), "super-schema-validator-")),
  bundle = resolve(".github/actions/gitops-validate/validate.cjs");
const results = [];
try {
  for (const root of ["", "contracts/catalog"]) {
    const repo = join(directory, root ? "folder" : "whole");
    mkdirSync(repo);
    const git = (...args) =>
      execFileSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git("init", "-b", "main");
    git("config", "user.name", "GitOps validator fixture");
    git("config", "user.email", "gitops-validator@example.invalid");
    const scope = {
      tenantId: "tenant",
      tenantSlug: "tenant",
      domainId: "domain",
      domainSlug: "identity",
      productId: "product",
      productSlug: "accounts",
    };
    const doc = (kind, id, scope, record) => ({
      apiVersion: "superschema.io/v1",
      kind,
      id,
      scope,
      owners: [],
      references: [],
      spec: { record, children: {} },
    });
    const files = [
      [
        "tenant.yaml",
        doc(
          "Tenant",
          "tenant",
          { tenantId: "tenant", tenantSlug: "tenant" },
          { id: "tenant", name: "Tenant", slug: "tenant" },
        ),
      ],
      [
        "domains/identity/domain.yaml",
        doc(
          "Domain",
          "domain",
          {
            tenantId: "tenant",
            tenantSlug: "tenant",
            domainId: "domain",
            domainSlug: "identity",
          },
          {
            id: "domain",
            tenantId: "tenant",
            name: "Identity",
            slug: "identity",
          },
        ),
      ],
      [
        "domains/identity/products/accounts/product.yaml",
        doc("Product", "product", scope, {
          id: "product",
          domainId: "domain",
          name: "Accounts",
          slug: "accounts",
        }),
      ],
      [
        "domains/identity/products/accounts/entities/account/1.0.0/entity.yaml",
        {
          ...doc("Entity", "account", scope, {
            id: "account",
            tenantId: "tenant",
            domainId: "domain",
            productId: "product",
            name: "Account",
            slug: "account",
          }),
          version: "1.0.0",
          stage: "RELEASED",
        },
      ],
    ];
    for (const [path, document] of files) {
      const absolute = join(repo, root, path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, JSON.stringify(document, null, 2) + "\n");
    }
    if (root) writeFileSync(join(repo, "entity.yaml"), "invalid: [");
    const run = (extra = [], env = {}) =>
      spawnSync(
        process.execPath,
        [bundle, "--repo", repo, "--root", root, ...extra],
        { encoding: "utf8", env: { ...process.env, ...env } },
      );
    const valid = run();
    assert.equal(valid.status, 0, valid.stderr || valid.stdout);
    git("add", ".");
    git("commit", "-m", "Canonical baseline");
    const base = git("rev-parse", "HEAD");
    const [path, document] = files.at(-1);
    document.spec.record.description = "Illegal release mutation";
    writeFileSync(
      join(repo, root, path),
      JSON.stringify(document, null, 2) + "\n",
    );
    const rejected = run(["--base-ref", base]);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /Released content is immutable/);
    const event = join(
      directory,
      root ? "folder-event.json" : "whole-event.json",
    );
    writeFileSync(
      event,
      JSON.stringify({ pull_request: { base: { sha: base } } }),
    );
    assert.equal(run([], { GITHUB_EVENT_PATH: event }).status, 1);
    results.push({
      root: root || "repository root",
      validTree: true,
      immutableReleaseRejected: true,
      eventBaseFallback: true,
    });
  }
  console.log(JSON.stringify({ passed: true, scenarios: results }, null, 2));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
