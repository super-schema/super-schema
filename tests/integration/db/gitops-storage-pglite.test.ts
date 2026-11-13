import {
  beforeAll,
  afterAll,
  afterEach,
  beforeEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPGlite } from "@/lib/pglite-adapter";
import { applyPgliteMigrations } from "@/lib/pglite-migrate";
import {
  blobHash,
  validateDocument,
  serializeDocument,
  canonicalPath,
} from "@/lib/gitops/canonical";
import type {
  GitProvider,
  CommitInput,
  TreeEntry,
} from "@/lib/gitops/provider";
import type { PrState } from "@/lib/gitops/contracts";
import type { ServiceContext } from "@/types/service-context";
const h = vi.hoisted(() => ({ db: null as unknown as PrismaClient }));
vi.mock("@/lib/db", () => ({
  prisma: new Proxy(
    {},
    {
      get(_t, key) {
        const v = Reflect.get(h.db, key);
        return typeof v === "function" ? v.bind(h.db) : v;
      },
    },
  ),
}));
import { projectionTransaction } from "@/lib/gitops/projection-transaction";
import { emptyEventDocument } from "@/lib/events/document/types";
import { GitContentStore } from "@/services/gitops/content-store";
import {
  synchronizeBinding,
  enqueueJob,
  processGitOpsJobs,
} from "@/services/gitops/sync";
import { promoteEnvironment } from "@/services/gitops/delivery";
import { getGitOpsWorkspace } from "@/services/gitops/workspace";
import { applyGitOpsConfiguration } from "@/services/gitops/configuration";
import { GitOpsConfigSchema } from "@/lib/gitops/config.mjs";
import { sealSecret } from "@/lib/crypto/secret-box";
import { initializeLegacyTenantStorage } from "@/lib/gitops/tenant-mode";
import {
  getTenantStorageSettings,
  onboardTenant,
  saveTenantGitProfile,
  setTenantContentStorage,
  startTenantBootstrap,
} from "@/services/tenant-storage.service";

afterEach(() => vi.unstubAllEnvs());
async function configurationApp() {
  vi.stubEnv("SECRETS_ENCRYPTION_KEY", Buffer.alloc(32, 1).toString("base64"));
  const app = {
    appId: "1",
    clientId: "fixture-client",
    baseUrl: "https://github.com",
    privateKey: sealSecret("fixture-private-key", "GitProviderApp.privateKey"),
    clientSecret: sealSecret(
      "fixture-client-secret",
      "GitProviderApp.clientSecret",
    ),
    webhookSecret: sealSecret(
      "fixture-webhook-secret-long-enough",
      "GitProviderApp.webhookSecret",
    ),
  };
  await h.db.gitProviderApp.upsert({
    where: { id: "github" },
    create: { id: "github", ...app },
    update: app,
  });
}
function configuration(overrides: Record<string, unknown> = {}) {
  return {
    directory: process.cwd(),
    filePath: "fixture.yaml",
    config: GitOpsConfigSchema.parse({
      repository: {
        url: "https://github.com/owner/repo",
        installationId: "1",
        sourceBranch: "main",
        root: "",
      },
      scope: { tenantId: "tenant", operatorEmail: "author@example.test" },
      workflow: {
        owners: ["@schema-owner"],
        stages: [
          { name: "development", branch: "main" },
          { name: "staging", branch: "staging" },
        ],
      },
      ...overrides,
    }),
  };
}
const configurationContext = (): ServiceContext => ({
  ...ctx(),
  assignments: [{ role: "ADMIN", scope: { kind: "GLOBAL" } }],
});

class Repository implements GitProvider {
  repository = {
    host: "github.com",
    owner: "owner",
    repo: "repo",
    api: "https://api.github.com",
    web: "https://github.com/owner/repo",
  };
  heads = new Map([
    ["main", "base"],
    ["staging", "base"],
    ["qa", "base"],
  ]);
  commits = new Map<string, Map<string, string>>([["base", new Map()]]);
  prs = new Map<number, { branch: string; base: string; state: PrState }>();
  calls = 0;
  async base(branch: string) {
    this.calls++;
    const sha = this.heads.get(branch);
    if (!sha) throw new Error("unknown branch");
    return sha;
  }
  async tree(sha: string): Promise<TreeEntry[]> {
    return [...this.commits.get(sha)!].map(([path, content]) => ({
      path,
      sha: blobHash(content),
      mode: "100644",
      type: "blob",
    }));
  }
  async readFiles(sha: string, select: (p: string) => boolean) {
    return [...this.commits.get(sha)!]
      .filter(([p]) => select(p))
      .map(([path, content]) => ({ path, content, sha: blobHash(content) }));
  }
  async commit(input: CommitInput) {
    if (
      input.expectedHead &&
      this.heads.get(input.branch) !== input.expectedHead
    )
      throw new Error("The PR branch changed; refresh before submitting");
    const files = new Map(
      this.commits.get(input.expectedHead ?? input.baseSha)!,
    );
    for (const f of input.files)
      if (f.content === null) files.delete(f.path);
      else files.set(f.path, f.content);
    const sha = `commit-${this.commits.size}`,
      existing = [...this.prs].find(([, v]) => v.branch === input.branch),
      number = existing?.[0] ?? this.prs.size + 1;
    this.commits.set(sha, files);
    this.heads.set(input.branch, sha);
    this.prs.set(number, {
      branch: input.branch,
      base: input.baseBranch,
      state: {
        number,
        url: `https://github.com/owner/repo/pull/${number}`,
        headSha: sha,
        baseSha: input.baseSha,
        merged: false,
        closed: false,
        mergeable: true,
        state: "IN_REVIEW",
        review: [],
        checks: {},
      },
    });
    return {
      sha,
      prNumber: number,
      prUrl: `https://github.com/owner/repo/pull/${number}`,
    };
  }
  async pullRequest(number: number) {
    return this.prs.get(number)!.state;
  }
  async close(number: number) {
    const p = this.prs.get(number)!;
    p.state = { ...p.state, closed: true, state: "CLOSED" };
  }
  merge(number: number) {
    const p = this.prs.get(number)!;
    this.heads.set(p.base, p.state.headSha);
    p.state = { ...p.state, merged: true, closed: true, state: "MERGED" };
  }
  branchEdit(number: number, path: string, content: string) {
    const p = this.prs.get(number)!;
    const files = new Map(this.commits.get(p.state.headSha)!);
    files.set(path, content);
    const sha = `external-${this.commits.size}`;
    this.commits.set(sha, files);
    this.heads.set(p.branch, sha);
    p.state = { ...p.state, headSha: sha };
  }
  handEdit(path: string, content: string) {
    const files = new Map(this.commits.get(this.heads.get("main")!)!);
    files.set(path, content);
    const sha = `manual-${this.commits.size}`;
    this.commits.set(sha, files);
    this.heads.set("main", sha);
  }
}
let pg: PGlite, repo: Repository, store: GitContentStore;
const ctx = (userId = "author", role = "ADMIN"): ServiceContext => ({
  userId,
  userRole: "VIEWER",
  tenantId: "tenant",
  prisma: h.db,
  assignments: [
    { role: role as "ADMIN", scope: { kind: "TENANT", tenantId: "tenant" } },
  ],
});
beforeAll(async () => {
  pg = new PGlite();
  expect(await applyPgliteMigrations(pg)).toContain(
    "20261112000000_gitops_storage",
  );
  h.db = new PrismaClient({ adapter: new PrismaPGlite(pg) });
}, 120000);
afterAll(async () => {
  await h.db?.$disconnect();
  await pg?.close();
});
beforeEach(async () => {
  await projectionTransaction(h.db, async (tx) => {
    for (const remove of [
      () => tx.gitOpsJob.deleteMany(),
      () => tx.indexError.deleteMany(),
      () => tx.gitCanonicalDocument.deleteMany(),
      () => tx.changeSetItem.deleteMany(),
      () => tx.changeSet.deleteMany(),
      () => tx.deliveryPullRequest.deleteMany(),
      () => tx.productGitSettings.deleteMany(),
      () => tx.tenantGitBinding.deleteMany(),
      () => tx.schemaReference.deleteMany(),
      () => tx.eventSpec.deleteMany(),
      () => tx.entity.deleteMany(),
      () => tx.product.deleteMany(),
      () => tx.domain.deleteMany(),
      () => tx.tenant.deleteMany(),
    ])
      await remove();
  });
  for (const id of ["author", "other"])
    await h.db.user.upsert({
      where: { id },
      create: { id, email: `${id}@example.test` },
      update: {},
    });
  await h.db.tenant.create({
    data: {
      id: "tenant",
      name: "Tenant",
      slug: "tenant",
      deploymentEnvironments: ["development", "staging", "qa"],
    },
  });
  await h.db.domain.create({
    data: {
      id: "domain",
      tenantId: "tenant",
      name: "Identity",
      slug: "identity",
    },
  });
  await h.db.product.create({
    data: {
      id: "product",
      domainId: "domain",
      name: "Accounts",
      slug: "accounts",
    },
  });
  await h.db.entity.create({
    data: {
      id: "account",
      name: "Account",
      slug: "account",
      tenantId: "tenant",
      domainId: "domain",
      productId: "product",
      ownerId: "author",
      description: "original",
      fields: {
        create: {
          id: "field",
          name: "id",
          slug: "id",
          type: "string",
          nullable: false,
          aliases: [],
          sortOrder: 0,
        },
      },
    },
  });
  await h.db.tenantGitBinding.create({
    data: {
      id: "binding",
      tenantId: "tenant",
      repositoryUrl: "https://github.com/owner/repo",
      installationId: "1",
      branch: "main",
      basePath: "storage/contracts",
      createdBy: "author",
      nextSyncAt: new Date(Date.now() + 3600000),
    },
  });
  await h.db.productGitSettings.create({
    data: {
      productId: "product",
      tenantId: "tenant",
      bindingId: "binding",
      stages: [
        { name: "development", branch: "main", path: "environments" },
        { name: "staging", branch: "staging", path: "environments" },
        { name: "qa", branch: "qa", path: "environments" },
      ],
    },
  });
  repo = new Repository();
  store = new GitContentStore(async () => repo);
}, 30000);
async function bootstrap() {
  await h.db.tenant.update({
    where: { id: "tenant" },
    data: { contentStorage: "git" },
  });
  const cs = await store.bootstrap("product", ctx());
  const submitted = await store.submit(cs.id, "Bootstrap", "", ctx());
  repo.merge(submitted.prNumber!);
  await synchronizeBinding("binding", async () => repo);
  return submitted;
}
async function entityDoc() {
  return h.db.gitCanonicalDocument.findFirstOrThrow({
    where: { kind: "Entity", objectId: "account", stage: "SNAPSHOT" },
  });
}

describe("GitOps on actual migrated PGlite tables", () => {
  const profile = () => ({
    binding: {
      repositoryUrl: "https://github.com/owner/repo",
      installationId: "1",
      branch: "main",
      basePath: "storage/new-tenant",
      enabled: true,
    },
    owners: ["@schema-owner"],
    stages: [
      { name: "development", branch: "main", path: "environments" },
      { name: "staging", branch: "staging", path: "environments" },
    ],
  });

  it("keeps explicit database tenants editable beside Git tenants even with the legacy Git default", async () => {
    vi.stubEnv("CONTENT_STORAGE", "git");
    await h.db.tenant.create({
      data: {
        id: "git-tenant",
        name: "Git",
        slug: "git",
        contentStorage: "git",
      },
    });
    await h.db.entity.update({
      where: { id: "account" },
      data: { description: "database content" },
    });
    await expect(
      h.db.entity.create({
        data: {
          name: "Private",
          slug: "private",
          tenantId: "git-tenant",
          ownerId: "author",
        },
      }),
    ).rejects.toThrow("GITOPS_AUTHORING_REQUIRED");
    expect(
      (await h.db.entity.findUniqueOrThrow({ where: { id: "account" } }))
        .description,
    ).toBe("database content");
    const status = await getTenantStorageSettings("tenant", ctx());
    expect(status.tenant.mode).toBe("database");
  });

  it("guards nested writes, bulk writes, raw SQL, reparenting and parent cascades for Git content", async () => {
    await h.db.tenant.update({
      where: { id: "tenant" },
      data: { contentStorage: "git" },
    });
    await expect(
      h.db.entity.update({
        where: { id: "account" },
        data: {
          fields: {
            create: {
              name: "blocked",
              slug: "blocked",
              type: "string",
              sortOrder: 1,
            },
          },
        },
      }),
    ).rejects.toThrow("GITOPS_AUTHORING_REQUIRED");
    await expect(
      h.db.field.updateMany({
        where: { entityId: "account" },
        data: { description: "blocked" },
      }),
    ).rejects.toThrow("GITOPS_AUTHORING_REQUIRED");
    await expect(
      h.db
        .$executeRaw`UPDATE "fields" SET "description"='blocked' WHERE id='field'`,
    ).rejects.toThrow("GITOPS_AUTHORING_REQUIRED");
    await h.db.tenant.create({
      data: { id: "database-tenant", name: "Private", slug: "private" },
    });
    await h.db.entity.create({
      data: {
        id: "private-entity",
        tenantId: "database-tenant",
        name: "Private",
        slug: "private",
        ownerId: "author",
      },
    });
    await expect(
      h.db.field.update({
        where: { id: "field" },
        data: { entityId: "private-entity" },
      }),
    ).rejects.toThrow("GITOPS_AUTHORING_REQUIRED");
    await expect(
      h.db.entity.update({
        where: { id: "private-entity" },
        data: { tenantId: "tenant" },
      }),
    ).rejects.toThrow("GITOPS_AUTHORING_REQUIRED");
    await expect(
      h.db.domain.delete({ where: { id: "domain" } }),
    ).rejects.toThrow("GITOPS_AUTHORING_REQUIRED");
    expect(await h.db.entity.count({ where: { id: "account" } })).toBe(1);
    await h.db.tenant.update({
      where: { id: "tenant" },
      data: { deploymentEnvironments: ["development", "production"] },
    });
  });

  it("limits projection permission to its transaction and clears it after commit and rollback", async () => {
    await h.db.tenant.update({
      where: { id: "tenant" },
      data: { contentStorage: "git" },
    });
    await projectionTransaction(h.db, (tx) =>
      tx.field.update({
        where: { id: "field" },
        data: { description: "projected" },
      }),
    );
    await expect(
      h.db.field.update({
        where: { id: "field" },
        data: { description: "leaked" },
      }),
    ).rejects.toThrow("GITOPS_AUTHORING_REQUIRED");
    await expect(
      projectionTransaction(h.db, async (tx) => {
        await tx.field.update({
          where: { id: "field" },
          data: { description: "rollback" },
        });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(
      (await h.db.field.findUniqueOrThrow({ where: { id: "field" } }))
        .description,
    ).toBe("projected");
    await expect(h.db.field.delete({ where: { id: "field" } })).rejects.toThrow(
      "GITOPS_AUTHORING_REQUIRED",
    );
  });

  it("never indexes a configured repository over a database tenant", async () => {
    await expect(store.bootstrap("product", ctx())).rejects.toThrow(
      "Choose Git storage",
    );
    await synchronizeBinding("binding", async () => repo);
    expect(repo.calls).toBe(0);
    expect(await h.db.gitCanonicalDocument.count()).toBe(0);
    expect(
      (await h.db.entity.findUniqueOrThrow({ where: { id: "account" } }))
        .description,
    ).toBe("original");
    expect(
      (
        await h.db.tenantGitBinding.findUniqueOrThrow({
          where: { id: "binding" },
        })
      ).lastSyncStatus,
    ).toBe("DATABASE_MODE");
  });

  it("allows initial Git workflow configuration and freezes it while the initial import is in progress", async () => {
    await configurationApp();
    await setTenantContentStorage("tenant", "git", 1, ctx());
    const initial = {
      ...profile(),
      binding: { ...profile().binding, basePath: "storage/contracts" },
    };
    await saveTenantGitProfile("tenant", initial, ctx(), async () => repo);
    const draft = await store.bootstrap("product", ctx());
    await expect(
      saveTenantGitProfile("tenant", initial, ctx(), async () => repo),
    ).rejects.toThrow("Merge or discard");
    await store.discard(draft.id, ctx());
    await expect(
      saveTenantGitProfile("tenant", initial, ctx(), async () => repo),
    ).resolves.toHaveProperty("bindingId");
  });

  it("inherits the tenant workflow defaults when bootstrapping a newly added product", async () => {
    await configurationApp();
    await saveTenantGitProfile(
      "tenant",
      {
        ...profile(),
        binding: { ...profile().binding, basePath: "storage/contracts" },
      },
      ctx(),
      async () => repo,
    );
    await setTenantContentStorage("tenant", "git", 1, ctx());
    const product = await h.db.product.create({
      data: { domainId: "domain", name: "New product", slug: "new-product" },
    });
    await store.bootstrap(product.id, ctx());
    const settings = await h.db.productGitSettings.findUniqueOrThrow({
      where: { productId: product.id },
    });
    expect(settings.stages).toEqual(profile().stages);
    expect(settings.workflowId).toBeTruthy();
    expect(
      (
        await h.db.deploymentWorkflow.findUniqueOrThrow({
          where: { id: settings.workflowId! },
        })
      ).name,
    ).toBe("GitOps · same repository");
  });

  it("rejects Git documents whose stable IDs belong to a private database tenant", async () => {
    await bootstrap();
    await h.db.tenant.create({
      data: { id: "private-tenant", name: "Private", slug: "private" },
    });
    const privateEntity = await h.db.entity.create({
      data: {
        id: "private-id",
        name: "Private",
        slug: "private",
        tenantId: "private-tenant",
        ownerId: "author",
        description: "private data",
      },
    });
    const malicious = validateDocument((await entityDoc()).document);
    malicious.id = "private-id";
    malicious.spec.record.id = "private-id";
    malicious.spec.record.slug = "private";
    malicious.spec.children = {};
    malicious.spec.versionRecord = { id: "forged-version-id" };
    repo.handEdit(
      canonicalPath("storage/contracts", malicious),
      serializeDocument(malicious),
    );
    await expect(
      synchronizeBinding("binding", async () => repo),
    ).rejects.toThrow("already belongs to another scope");
    expect(
      await h.db.entity.findUniqueOrThrow({ where: { id: "private-id" } }),
    ).toEqual(privateEntity);
  });

  it("materializes the legacy default once without changing explicit per-tenant choices", async () => {
    await projectionTransaction(h.db, async (tx) => {
      await tx.tenant.create({
        data: {
          id: "legacy",
          name: "Legacy",
          slug: "legacy",
          contentStorage: null,
        },
      });
    });
    vi.stubEnv("CONTENT_STORAGE", "git");
    await initializeLegacyTenantStorage(h.db);
    expect(
      (await h.db.tenant.findUniqueOrThrow({ where: { id: "legacy" } }))
        .contentStorage,
    ).toBe("git");
    expect(
      (await h.db.tenant.findUniqueOrThrow({ where: { id: "tenant" } }))
        .contentStorage,
    ).toBe("database");
    vi.stubEnv("CONTENT_STORAGE", "database");
    await initializeLegacyTenantStorage(h.db);
    expect(
      (await h.db.tenant.findUniqueOrThrow({ where: { id: "legacy" } }))
        .contentStorage,
    ).toBe("git");
  });

  it("creates a database tenant with an initial workspace, administrator membership and private traits", async () => {
    const result = await onboardTenant(
      { name: "Private schemas", storage: "database" },
      configurationContext(),
    );
    const tenant = await h.db.tenant.findUniqueOrThrow({
      where: { id: result.tenantId },
    });
    expect(tenant.contentStorage).toBe("database");
    expect(
      await h.db.product.count({ where: { domain: { tenantId: tenant.id } } }),
    ).toBe(1);
    expect(
      await h.db.userRole.count({
        where: { tenantId: tenant.id, userId: "author", role: "ADMIN" },
      }),
    ).toBe(1);
    expect(
      await h.db.trait.count({ where: { tenantId: tenant.id } }),
    ).toBeGreaterThan(0);
    expect(
      await h.db.tenantGitBinding.count({ where: { tenantId: tenant.id } }),
    ).toBe(0);
    expect(result.notice).toBeUndefined();
  });

  it("onboards Git storage, bootstraps under its folder and indexes merged entries for the UI", async () => {
    await configurationApp();
    const result = await onboardTenant(
      {
        name: "Git schemas",
        storage: "git",
        domainName: "Payments",
        productName: "Contracts",
        git: profile(),
      },
      configurationContext(),
      async () => repo,
    );
    expect(result.notice).toBeUndefined();
    const context = { ...configurationContext(), tenantId: result.tenantId };
    const before = await getTenantStorageSettings(result.tenantId, context);
    expect(before.tenant.mode).toBe("git");
    expect(before.profile.stages).toEqual(profile().stages);
    expect(before.state).toBe("bootstrap_required");
    const bootstrap = await startTenantBootstrap(
      result.tenantId,
      context,
      async () => repo,
    );
    expect(bootstrap.pullRequests).toHaveLength(1);
    const pr = bootstrap.pullRequests[0].number!;
    const files = repo.commits.get(repo.prs.get(pr)!.state.headSha)!;
    expect([...files.keys()].filter((p) => !p.startsWith(".github/"))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^storage\/new-tenant\//)]),
    );
    repo.merge(pr);
    await synchronizeBinding(before.binding!.id, async () => repo);
    const after = await getTenantStorageSettings(result.tenantId, context);
    expect(after.state).toBe("ready");
    expect(after.canReturnToDatabase).toBe(false);
    await expect(
      setTenantContentStorage(
        result.tenantId,
        "database",
        after.tenant.revision,
        context,
      ),
    ).rejects.toThrow("Git history");
    const ui = await getGitOpsWorkspace(result.tenantId, undefined, context);
    expect(ui.mode).toBe("git");
    expect(ui.documents.length).toBeGreaterThan(0);
  });

  it("does not create tenants when repository verification fails or the caller lacks platform access", async () => {
    await expect(onboardTenant({ name: "Forbidden" }, ctx())).rejects.toThrow(
      "Platform administrator",
    );
    await expect(
      onboardTenant(
        { name: "Broken", storage: "git", git: profile() },
        configurationContext(),
        async () => {
          throw new Error("denied");
        },
      ),
    ).rejects.toThrow("denied");
    expect(await h.db.tenant.count()).toBe(1);
  });

  it("rejects overlapping repository roots across tenants and allows sibling folders", async () => {
    await configurationApp();
    const other = await onboardTenant(
      { name: "Other", storage: "database" },
      configurationContext(),
    );
    const context = { ...configurationContext(), tenantId: other.tenantId };
    for (const basePath of [
      "",
      "storage",
      "storage/contracts",
      "storage/contracts/nested",
    ]) {
      await expect(
        saveTenantGitProfile(
          other.tenantId,
          { ...profile(), binding: { ...profile().binding, basePath } },
          context,
          async () => repo,
        ),
      ).rejects.toThrow("reserved by another tenant");
    }
    await expect(
      saveTenantGitProfile(
        other.tenantId,
        profile(),
        context,
        async () => repo,
      ),
    ).resolves.toHaveProperty("bindingId");
    expect(
      (await getTenantStorageSettings(other.tenantId, context)).tenant.mode,
    ).toBe("database");
  });

  it("requires tenant administrator access and an up-to-date storage revision", async () => {
    await expect(
      setTenantContentStorage("tenant", "git", 1, ctx("author", "EDITOR")),
    ).rejects.toThrow("access denied");
    await setTenantContentStorage("tenant", "git", 1, ctx());
    await expect(
      setTenantContentStorage("tenant", "database", 1, ctx()),
    ).rejects.toThrow("another tab");
    await setTenantContentStorage("tenant", "database", 2, ctx());
    expect((await getTenantStorageSettings("tenant", ctx())).tenant.mode).toBe(
      "database",
    );
  });

  it("applies a portable configuration storage choice only to its selected tenant", async () => {
    await configurationApp();
    await h.db.tenant.create({
      data: { id: "private", name: "Private", slug: "private" },
    });
    await applyGitOpsConfiguration(
      configuration({
        scope: {
          tenantId: "tenant",
          operatorEmail: "author@example.test",
          contentStorage: "git",
        },
      }),
      configurationContext(),
      async () => repo,
    );
    expect(
      (await h.db.tenant.findUniqueOrThrow({ where: { id: "tenant" } }))
        .contentStorage,
    ).toBe("git");
    expect(
      (await h.db.tenant.findUniqueOrThrow({ where: { id: "private" } }))
        .contentStorage,
    ).toBe("database");
  });

  it.each([{ basePath: "" }, { installationId: "2" }])(
    "applies and preserves a product source override %j",
    async (override) => {
      await configurationApp();
      const repository = {
        url: "https://github.com/owner/repo",
        installationId: "1",
        sourceBranch: "main",
        root: "tenant-catalog",
      };
      const loaded = configuration({
        repository,
        products: [{ productId: "product", ...override }],
      });
      await applyGitOpsConfiguration(
        loaded,
        configurationContext(),
        async () => repo,
      );
      const tenant = await h.db.tenantGitBinding.findFirstOrThrow({
          where: { tenantId: "tenant", productId: null },
        }),
        product = await h.db.tenantGitBinding.findUniqueOrThrow({
          where: { productId: "product" },
        });
      expect(tenant.basePath).toBe("tenant-catalog");
      expect(product.basePath).toBe(
        "basePath" in override ? override.basePath : "tenant-catalog",
      );
      expect(product.installationId).toBe(
        "installationId" in override ? override.installationId : "1",
      );
      expect(
        (
          await h.db.productGitSettings.findUniqueOrThrow({
            where: { productId: "product" },
          })
        ).bindingId,
      ).toBe(product.id);
      await applyGitOpsConfiguration(
        configuration({ repository }),
        configurationContext(),
        async () => repo,
      );
      const preserved = await h.db.tenantGitBinding.findUniqueOrThrow({
        where: { productId: "product" },
      });
      expect(preserved.id).toBe(product.id);
      expect(preserved.basePath).toBe(product.basePath);
      expect(preserved.installationId).toBe(product.installationId);
    },
  );
  it("applies portable repository and product workflow settings through the real services", async () => {
    await configurationApp();
    const revision = (
      await h.db.gitProviderApp.findUniqueOrThrow({ where: { id: "github" } })
    ).revision;
    const result = await applyGitOpsConfiguration(
      configuration(),
      configurationContext(),
      async () => repo,
    );
    const binding = await h.db.tenantGitBinding.findUniqueOrThrow({
        where: { id: result.bindingId },
      }),
      settings = await h.db.productGitSettings.findUniqueOrThrow({
        where: { productId: "product" },
      });
    expect(binding.basePath).toBe("");
    expect(binding.branch).toBe("main");
    expect(settings.owners).toEqual(["@schema-owner"]);
    expect(settings.stages).toMatchObject([
      { name: "development", branch: "main" },
      { name: "staging", branch: "staging" },
    ]);
    expect(settings.workflowId).toBeTruthy();
    expect(
      (await h.db.gitProviderApp.findUniqueOrThrow({ where: { id: "github" } }))
        .revision,
    ).toBe(revision);
    expect(await h.db.gitCanonicalDocument.count()).toBe(0);
    expect(repo.prs.size).toBe(0);
  });
  it("checks configured branch access before changing the App or binding", async () => {
    await configurationApp();
    vi.stubEnv("GITOPS_GITHUB_PRIVATE_KEY", "new-private-key");
    vi.stubEnv("GITOPS_GITHUB_CLIENT_SECRET", "new-client-secret");
    vi.stubEnv(
      "GITOPS_GITHUB_WEBHOOK_SECRET",
      "new-webhook-secret-long-enough",
    );
    const loaded = configuration({
      github: { app: { appId: "2", clientId: "new-client" } },
      workflow: {
        stages: [
          { name: "development", branch: "main" },
          { name: "staging", branch: "missing" },
        ],
      },
    });
    await expect(
      applyGitOpsConfiguration(
        loaded,
        configurationContext(),
        async () => repo,
      ),
    ).rejects.toThrow("unknown branch");
    expect(
      (await h.db.gitProviderApp.findUniqueOrThrow({ where: { id: "github" } }))
        .appId,
    ).toBe("1");
    expect(
      (
        await h.db.tenantGitBinding.findUniqueOrThrow({
          where: { id: "binding" },
        })
      ).basePath,
    ).toBe("storage/contracts");
  });
  it("refuses configuration imports without permission or outside the product scope", async () => {
    const before = await h.db.tenantGitBinding.findUniqueOrThrow({
      where: { id: "binding" },
    });
    await expect(
      applyGitOpsConfiguration(
        configuration(),
        ctx("author", "VIEWER"),
        async () => repo,
      ),
    ).rejects.toThrow("denied");
    await expect(
      applyGitOpsConfiguration(
        configuration({
          scope: {
            tenantId: "tenant",
            operatorEmail: "author@example.test",
            productIds: ["foreign-product"],
          },
        }),
        configurationContext(),
        async () => repo,
      ),
    ).rejects.toThrow("does not belong");
    expect(
      await h.db.tenantGitBinding.findUniqueOrThrow({
        where: { id: "binding" },
      }),
    ).toEqual(before);
  });
  it("keeps imported Git-owned workflow changes in a private draft until review", async () => {
    await configurationApp();
    await bootstrap();
    vi.stubEnv("CONTENT_STORAGE", "git");
    const loaded = configuration({
      repository: {
        url: "https://github.com/owner/repo",
        installationId: "1",
        sourceBranch: "main",
        root: "storage/contracts",
      },
    });
    const result = await applyGitOpsConfiguration(
      loaded,
      configurationContext(),
      async () => repo,
    );
    expect(result.products[0]).toHaveProperty("changeSetId");
    expect(
      (
        await h.db.productGitSettings.findUniqueOrThrow({
          where: { productId: "product" },
        })
      ).owners,
    ).toEqual([]);
    const draft = await h.db.changeSetItem.findFirstOrThrow({
      where: {
        changeSetId: (result.products[0] as { changeSetId: string })
          .changeSetId,
      },
    });
    expect(validateDocument(draft.document).owners).toEqual(["@schema-owner"]);
  });
  it("exports a bootstrap PR under the configured folder and indexes only after merge", async () => {
    await h.db.tenant.update({
      where: { id: "tenant" },
      data: { contentStorage: "git" },
    });
    const cs = await store.bootstrap("product", ctx());
    expect(await h.db.gitCanonicalDocument.count()).toBe(0);
    const result = await store.submit(cs.id, "Bootstrap", "", ctx());
    expect(
      [...repo.commits.get(result.headSha!)!.keys()].every((p) =>
        p.startsWith("storage/contracts/"),
      ),
    ).toBe(true);
    expect(await h.db.gitCanonicalDocument.count()).toBe(0);
    repo.merge(result.prNumber!);
    await synchronizeBinding("binding", async () => repo);
    expect(
      (
        await h.db.tenantGitBinding.findUniqueOrThrow({
          where: { id: "binding" },
        })
      ).indexedSha,
    ).toBe(result.headSha);
    expect(await h.db.entityVersion.count()).toBe(1);
    expect(
      (await h.db.changeSet.findUniqueOrThrow({ where: { id: cs.id } })).state,
    ).toBe("MERGED");
  });
  it("keeps private drafts outside the published projection and other authors' workspace", async () => {
    await bootstrap();
    const row = await entityDoc(),
      doc = validateDocument(row.document);
    doc.spec.record.description = "private edit";
    await store.saveDraft(
      { productId: "product", document: doc },
      undefined,
      ctx(),
    );
    expect(
      (await h.db.entity.findUniqueOrThrow({ where: { id: "account" } }))
        .description,
    ).toBe("original");
    const other = await getGitOpsWorkspace("tenant", "product", ctx("other"));
    expect(other.changeSets.some((c) => c.state === "DRAFT")).toBe(false);
    expect(JSON.stringify(other)).not.toContain("private edit");
  });
  it("projects a changed snapshot after its PR merges and updates that PR on later submissions", async () => {
    await bootstrap();
    const row = await entityDoc(),
      doc = validateDocument(row.document);
    doc.spec.record.description = "reviewed";
    let cs = await store.saveDraft(
      { productId: "product", document: doc },
      undefined,
      ctx(),
    );
    cs = await store.submit(cs.id, "Update", "", ctx());
    doc.spec.record.description = "second edit";
    await store.saveDraft(
      { productId: "product", document: doc },
      undefined,
      ctx(),
    );
    const again = await store.submit(cs.id, "Update again", "", ctx());
    expect(again.prNumber).toBe(cs.prNumber);
    expect(
      (await h.db.entity.findUniqueOrThrow({ where: { id: "account" } }))
        .description,
    ).toBe("original");
    repo.merge(again.prNumber!);
    await synchronizeBinding("binding", async () => repo);
    expect(
      (await h.db.entity.findUniqueOrThrow({ where: { id: "account" } }))
        .description,
    ).toBe("second edit");
  });
  it("refuses stale tabs and unauthorized authoring", async () => {
    await bootstrap();
    const doc = validateDocument((await entityDoc()).document);
    const cs = await store.saveDraft(
      { productId: "product", document: doc },
      undefined,
      ctx(),
    );
    await expect(
      store.saveDraft(
        { productId: "product", document: doc },
        cs.revision - 1,
        ctx(),
      ),
    ).rejects.toThrow("another tab");
    await expect(
      store.saveDraft(
        { productId: "product", document: doc },
        undefined,
        ctx("other", "VIEWER"),
      ),
    ).rejects.toThrow("denied");
  });
  it("preserves the previous projection and reports invalid hand edits", async () => {
    await bootstrap();
    const row = await entityDoc();
    repo.handEdit(row.path, "invalid: [");
    await expect(
      synchronizeBinding("binding", async () => repo),
    ).rejects.toThrow("previous projection");
    expect(await h.db.indexError.count()).toBeGreaterThan(0);
    expect(
      (await h.db.entity.findUniqueOrThrow({ where: { id: "account" } }))
        .description,
    ).toBe("original");
  });
  it("promotes a snapshot by PR and refuses later released-content mutations", async () => {
    await bootstrap();
    let cs = await store.promote("product", "account", ctx());
    cs = await store.submit(cs.id, "Release 1.0.0", "", ctx());
    repo.merge(cs.prNumber!);
    await synchronizeBinding("binding", async () => repo);
    expect((await h.db.entityVersion.findFirstOrThrow()).stage).toBe(
      "RELEASED",
    );
    const row = await h.db.gitCanonicalDocument.findFirstOrThrow({
        where: { kind: "Entity", stage: "RELEASED" },
      }),
      doc = validateDocument(row.document);
    doc.spec.record.description = "tampered";
    repo.handEdit(row.path, serializeDocument(doc));
    await expect(
      synchronizeBinding("binding", async () => repo),
    ).rejects.toThrow();
    expect(
      (await h.db.entity.findUniqueOrThrow({ where: { id: "account" } }))
        .description,
    ).toBe("original");
  });
  it("requires the previous environment to merge for the exact source commit", async () => {
    await bootstrap();
    await expect(
      promoteEnvironment("product", "qa", ctx(), async () => repo),
    ).rejects.toThrow("Merge staging");
    const staging = await promoteEnvironment(
      "product",
      "staging",
      ctx(),
      async () => repo,
    );
    expect(staging.repositoryUrl).toBe("https://github.com/owner/repo");
    expect(
      [...repo.commits.get(staging.headSha!)!.keys()].every((p) =>
        p.startsWith("storage/contracts/"),
      ),
    ).toBe(true);
    await expect(
      promoteEnvironment("product", "qa", ctx(), async () => repo),
    ).rejects.toThrow("Merge staging");
    repo.merge(staging.prNumber!);
    await synchronizeBinding("binding", async () => repo);
    const qa = await promoteEnvironment(
      "product",
      "qa",
      ctx(),
      async () => repo,
    );
    expect(qa.baseBranch).toBe("qa");
    expect(qa.sourceSha).toBe(staging.sourceSha);
  });
  it("replaces an environment snapshot with its release without leaving stale folders", async () => {
    await bootstrap();
    const staging = await promoteEnvironment(
      "product",
      "staging",
      ctx(),
      async () => repo,
    );
    repo.merge(staging.prNumber!);
    await synchronizeBinding("binding", async () => repo);
    const snapshotPath = (await entityDoc()).path;
    let release = await store.promote("product", "account", ctx());
    release = await store.submit(release.id, "Release", "", ctx());
    repo.merge(release.prNumber!);
    await synchronizeBinding("binding", async () => repo);
    const next = await promoteEnvironment(
      "product",
      "staging",
      ctx(),
      async () => repo,
    );
    const tree = repo.commits.get(next.headSha!)!;
    expect(tree.has(snapshotPath)).toBe(false);
    expect(tree.has(snapshotPath.replace("1.0.0_snapshot", "1.0.0"))).toBe(
      true,
    );
  });
  it("keeps unsent changes private after a PR was already submitted", async () => {
    await bootstrap();
    const doc = validateDocument((await entityDoc()).document);
    doc.spec.record.description = "submitted";
    let cs = await store.saveDraft(
      { productId: "product", document: doc },
      undefined,
      ctx(),
    );
    cs = await store.submit(cs.id, "Public PR", "", ctx());
    doc.spec.record.description = "private-unsent-value";
    await store.saveDraft(
      { productId: "product", document: doc },
      undefined,
      ctx(),
    );
    const other = await getGitOpsWorkspace("tenant", "product", ctx("other"));
    const visible = other.changeSets.find((c) => c.id === cs.id)!;
    expect(visible.prNumber).toBe(cs.prNumber);
    expect(visible.items).toEqual([]);
    expect(visible.leaseToken).toBeNull();
    expect(JSON.stringify(other)).not.toContain("private-unsent-value");
  });
  it("rejects hand-edited snapshots that try to reuse released version IDs", async () => {
    await bootstrap();
    let cs = await store.promote("product", "account", ctx());
    cs = await store.submit(cs.id, "Release", "", ctx());
    repo.merge(cs.prNumber!);
    await synchronizeBinding("binding", async () => repo);
    const released = await h.db.entityVersion.findFirstOrThrow(),
      doc = validateDocument(
        (
          await h.db.gitCanonicalDocument.findFirstOrThrow({
            where: { kind: "Entity", stage: "RELEASED" },
          })
        ).document,
      );
    doc.stage = "SNAPSHOT";
    doc.version = "1.0.1_snapshot";
    doc.spec.record.description = "Next revision";
    repo.handEdit(
      canonicalPath("storage/contracts", doc),
      serializeDocument(doc),
    );
    await expect(
      synchronizeBinding("binding", async () => repo),
    ).rejects.toThrow("previous projection");
    expect(
      await h.db.entityVersion.findUniqueOrThrow({
        where: { id: released.id },
      }),
    ).toEqual(released);
  });
  it("keeps product source identity stable across unrelated commits and rebuilds", async () => {
    await bootstrap();
    const before = await h.db.productGitSettings.findUniqueOrThrow({
        where: { productId: "product" },
      }),
      version = await h.db.entityVersion.findFirstOrThrow();
    repo.handEdit("README.md", "unrelated repository change");
    await synchronizeBinding("binding", async () => repo);
    expect(
      (
        await h.db.productGitSettings.findUniqueOrThrow({
          where: { productId: "product" },
        })
      ).sourceSha,
    ).toBe(before.sourceSha);
    await synchronizeBinding("binding", async () => repo, true);
    expect(await h.db.entityVersion.count()).toBe(1);
    expect((await h.db.entityVersion.findFirstOrThrow()).id).toBe(version.id);
    expect(
      (
        await h.db.productGitSettings.findUniqueOrThrow({
          where: { productId: "product" },
        })
      ).sourceSha,
    ).toBe(before.sourceSha);
  });
  it("raises a new snapshot semantically without overwriting its released version", async () => {
    await bootstrap();
    let release = await store.promote("product", "account", ctx());
    release = await store.submit(release.id, "Release", "", ctx());
    repo.merge(release.prNumber!);
    await synchronizeBinding("binding", async () => repo);
    const frozen = await h.db.entityVersion.findFirstOrThrow(),
      doc = validateDocument(
        (
          await h.db.gitCanonicalDocument.findFirstOrThrow({
            where: { kind: "Entity", stage: "RELEASED" },
          })
        ).document,
      );
    doc.stage = "SNAPSHOT";
    doc.version = "1.0.0_snapshot";
    delete doc.spec.versionRecord;
    doc.spec.children.fields.push({
      id: "new-field",
      entityId: "account",
      name: "displayName",
      slug: "display-name",
      type: "string",
      nullable: true,
      aliases: [],
      sortOrder: 1,
    });
    let cs = await store.saveDraft(
      { productId: "product", document: doc },
      undefined,
      ctx(),
    );
    const item = await h.db.changeSetItem.findFirstOrThrow({
      where: { changeSetId: cs.id },
    });
    expect(validateDocument(item.document).version).toBe("1.1.0_snapshot");
    cs = await store.submit(cs.id, "New snapshot", "", ctx());
    repo.merge(cs.prNumber!);
    await synchronizeBinding("binding", async () => repo);
    expect(await h.db.entityVersion.count()).toBe(2);
    expect(
      await h.db.entityVersion.findUniqueOrThrow({ where: { id: frozen.id } }),
    ).toEqual(frozen);
    expect(
      (
        await h.db.entityVersion.findFirstOrThrow({
          where: { stage: "SNAPSHOT" },
        })
      ).id,
    ).not.toBe(frozen.id);
  });
  it("moves released folders without changing released bytes", async () => {
    await bootstrap();
    let release = await store.promote("product", "account", ctx());
    release = await store.submit(release.id, "Release", "", ctx());
    repo.merge(release.prNumber!);
    await synchronizeBinding("binding", async () => repo);
    const frozen = await h.db.gitCanonicalDocument.findFirstOrThrow({
        where: { kind: "Entity", stage: "RELEASED" },
      }),
      doc = validateDocument(frozen.document);
    doc.stage = "SNAPSHOT";
    doc.version = "1.0.1_snapshot";
    delete doc.spec.versionRecord;
    doc.spec.record.slug = "customer-account";
    let cs = await store.saveDraft(
      { productId: "product", document: doc },
      undefined,
      ctx(),
    );
    cs = await store.submit(cs.id, "Rename account folder", "", ctx());
    const tree = repo.commits.get(cs.headSha!)!;
    expect(tree.has(frozen.path)).toBe(false);
    expect(
      tree.get(frozen.path.replace("/account/", "/customer-account/")),
    ).toBe(frozen.content);
    repo.merge(cs.prNumber!);
    await synchronizeBinding("binding", async () => repo);
    expect(await h.db.entityVersion.count()).toBe(2);
  });
  it("merges external PR edits with unsent local changes after explicit refresh", async () => {
    await bootstrap();
    const row = await entityDoc(),
      doc = validateDocument(row.document);
    doc.spec.record.description = "submitted";
    let cs = await store.saveDraft(
      { productId: "product", document: doc },
      undefined,
      ctx(),
    );
    cs = await store.submit(cs.id, "Edit", "", ctx());
    const external = structuredClone(doc);
    external.spec.record.name = "AccountExternal";
    repo.branchEdit(cs.prNumber!, row.path, serializeDocument(external));
    doc.spec.record.description = "local-unsent";
    await store.saveDraft(
      { productId: "product", document: doc },
      undefined,
      ctx(),
    );
    await expect(
      store.submit(cs.id, "Blocked stale head", "", ctx()),
    ).rejects.toThrow();
    expect(await store.refresh(cs.id, ctx())).toEqual({ conflicts: 0 });
    const item = await h.db.changeSetItem.findFirstOrThrow({
      where: { changeSetId: cs.id },
    });
    const merged = validateDocument(item.document);
    expect(merged.spec.record.name).toBe("AccountExternal");
    expect(merged.spec.record.description).toBe("local-unsent");
    const updated = await store.submit(
      cs.id,
      "Reviewed merged edit",
      "",
      ctx(),
    );
    expect(updated.prNumber).toBe(cs.prNumber);
  });
  it("reconstructs assembled AsyncAPI event history and reference edges from Git", async () => {
    await bootstrap();
    const entity = await h.db.entityVersion.findFirstOrThrow(),
      document = emptyEventDocument("AccountCreated");
    document.messages.push({
      key: "account-created",
      name: "AccountCreated",
      payload: { entityId: "account", entityVersionId: entity.id },
      representation: "json-schema",
      traitKeys: [],
    });
    const event = validateDocument({
      apiVersion: "superschema.io/v1",
      kind: "Event",
      id: "account-created",
      scope: {
        tenantId: "tenant",
        tenantSlug: "tenant",
        domainId: "domain",
        domainSlug: "identity",
        productId: "product",
        productSlug: "accounts",
      },
      version: "1.0.0_snapshot",
      stage: "SNAPSHOT",
      owners: [],
      references: [],
      spec: {
        record: {
          id: "account-created",
          name: "AccountCreated",
          tenantId: "tenant",
          domainId: "domain",
          productId: "product",
          specType: "asyncapi@3.0",
          document,
        },
        children: {},
      },
    });
    repo.handEdit(
      canonicalPath("storage/contracts", event),
      serializeDocument(event),
    );
    await synchronizeBinding("binding", async () => repo);
    const version = await h.db.eventSpecVersion.findFirstOrThrow();
    expect(version.document).toMatchObject({ asyncapi: "3.0.0" });
    expect(JSON.stringify(version.document)).toContain("AccountCreated");
    expect(
      await h.db.schemaReference.count({
        where: {
          fromKind: "EVENT_SPEC_VERSION",
          fromId: version.id,
          toId: entity.id,
        },
      }),
    ).toBe(1);
    await projectionTransaction(h.db, (tx) => tx.schemaReference.deleteMany());
    await synchronizeBinding("binding", async () => repo, true);
    expect(await h.db.eventSpecVersion.count()).toBe(1);
    expect((await h.db.eventSpecVersion.findFirstOrThrow()).id).toBe(
      version.id,
    );
    expect(
      await h.db.schemaReference.count({
        where: { fromKind: "EVENT_SPEC_VERSION", fromId: version.id },
      }),
    ).toBe(1);
  }, 60000);
  it("claims a durable sync job only once across concurrent drains", async () => {
    await bootstrap();
    await h.db.gitOpsJob.deleteMany();
    await enqueueJob("binding", "SYNC", "concurrent");
    const result = await Promise.all([
      processGitOpsJobs(1, async () => repo),
      processGitOpsJobs(1, async () => repo),
    ]);
    expect(result.reduce((a, b) => a + b, 0)).toBe(1);
    expect(
      (
        await h.db.gitOpsJob.findUniqueOrThrow({
          where: { dedupeKey: "concurrent" },
        })
      ).attempts,
    ).toBe(1);
  });
});
