import {
  beforeAll,
  afterAll,
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
import { emptyEventDocument } from "@/lib/events/document/types";
import { GitContentStore } from "@/services/gitops/content-store";
import {
  synchronizeBinding,
  enqueueJob,
  processGitOpsJobs,
} from "@/services/gitops/sync";
import { promoteEnvironment } from "@/services/gitops/delivery";
import { getGitOpsWorkspace } from "@/services/gitops/workspace";

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
  for (const remove of [
    () => h.db.gitOpsJob.deleteMany(),
    () => h.db.indexError.deleteMany(),
    () => h.db.gitCanonicalDocument.deleteMany(),
    () => h.db.changeSetItem.deleteMany(),
    () => h.db.changeSet.deleteMany(),
    () => h.db.deliveryPullRequest.deleteMany(),
    () => h.db.productGitSettings.deleteMany(),
    () => h.db.tenantGitBinding.deleteMany(),
    () => h.db.schemaReference.deleteMany(),
    () => h.db.eventSpec.deleteMany(),
    () => h.db.entity.deleteMany(),
    () => h.db.product.deleteMany(),
    () => h.db.domain.deleteMany(),
    () => h.db.tenant.deleteMany(),
  ])
    await remove();
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
  it("exports a bootstrap PR under the configured folder and indexes only after merge", async () => {
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
    await h.db.schemaReference.deleteMany();
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
