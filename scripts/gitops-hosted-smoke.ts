/** Explicit hosted acceptance test. All writes use temporary branches and one isolated folder; main is never a PR target. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { prisma, hostedPg } from "./gitops-hosted-db";
import { GitHubProvider } from "@/lib/gitops/provider";
import { GitContentStore } from "@/services/gitops/content-store";
import { setTenantContentStorage } from "@/services/tenant-storage.service";
import { synchronizeBinding } from "@/services/gitops/sync";
import {
  deliverArtifacts,
  promoteEnvironment,
} from "@/services/gitops/delivery";
import { ensureDefaultWorkflow } from "@/services/gitops/settings";
import { getGitOpsWorkspace } from "@/services/gitops/workspace";
import { validateDocument } from "@/lib/gitops/canonical";
import { sealSecret } from "@/lib/crypto/secret-box";
import type { ServiceContext } from "@/types/service-context";

const run =
    new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15) +
    "-" +
    randomUUID().slice(0, 8),
  prefix = `ss/gitops-proof/${run}`,
  root = `.superschema-gitops-proof/${run}`;
const repository = "OnePayPal/event-schema-central",
  url = `https://github.com/${repository}`;
const token =
  process.env.GITOPS_TEST_TOKEN ??
  execFileSync("gh", ["auth", "token"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const remote = new GitHubProvider(url, token),
  provider = async () => remote,
  store = new GitContentStore(provider);
const branches = new Set<string>(),
  pullRequests: { number: number; url: string; kind: string }[] = [],
  report: Record<string, unknown> = {
    run,
    repository,
    root,
    branches: [],
    pullRequests,
  };
const api = <T>(method: string, path: string, data?: unknown): T =>
  JSON.parse(
    execFileSync(
      "gh",
      [
        "api",
        `repos/${repository}${path}`,
        "--method",
        method,
        ...(data === undefined ? [] : ["--input", "-"]),
      ],
      {
        input: data === undefined ? undefined : JSON.stringify(data),
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    ) || "null",
  );
async function recordPR(number: number, kind: string) {
  const p = api<{
    html_url: string;
    head: { ref: string };
    base: { ref: string };
    user: { login: string };
  }>("GET", `/pulls/${number}`);
  assert.ok(p.base.ref.startsWith(prefix), "A smoke PR must never target main");
  branches.add(p.head.ref);
  pullRequests.push({ number, url: p.html_url, kind });
  const files = api<{ filename: string; previous_filename?: string }[]>(
    "GET",
    `/pulls/${number}/files?per_page=100`,
  );
  assert.ok(
    files.every(
      (f) =>
        f.filename.startsWith(root + "/") &&
        (!f.previous_filename || f.previous_filename.startsWith(root + "/")),
    ),
    "A smoke PR escaped the storage folder",
  );
  return p;
}
async function merge(number: number) {
  for (let attempt = 0; ; attempt++) {
    const p = api<{ base: { ref: string }; head: { sha: string } }>(
      "GET",
      `/pulls/${number}`,
    );
    assert.ok(p.base.ref.startsWith(prefix));
    try {
      const m = api<{ merged: boolean }>("PUT", `/pulls/${number}/merge`, {
        merge_method: "squash",
        sha: p.head.sha,
      });
      assert.equal(m.merged, true);
      return;
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}
const ctx: ServiceContext = {
  userId: "gitops-smoke-author",
  userRole: "VIEWER",
  tenantId: "gitops-smoke-tenant",
  assignments: [
    {
      role: "ADMIN",
      scope: { kind: "TENANT", tenantId: "gitops-smoke-tenant" },
    },
  ],
  prisma,
};
process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 42).toString("base64");
try {
  const actor = await remote.actor(),
    main = await remote.base("main");
  report.actor = actor.login;
  report.mainBefore = main;
  for (const name of ["development", "staging", "qa", "production"]) {
    const branch = `${prefix}/${name}`;
    api("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha: main });
    branches.add(branch);
  }
  await prisma.user.create({
    data: { id: ctx.userId, email: "gitops-smoke@example.invalid" },
  });
  await prisma.tenant.create({
    data: {
      id: ctx.tenantId!,
      name: `GitOps Smoke ${run}`,
      slug: `gitops-smoke-${run.toLowerCase()}`,
      deploymentEnvironments: ["development", "staging", "qa", "production"],
    },
  });
  await prisma.domain.create({
    data: {
      id: "gitops-smoke-domain",
      tenantId: ctx.tenantId!,
      name: "GitOps Proof",
      slug: "gitops-proof",
    },
  });
  await prisma.product.create({
    data: {
      id: "gitops-smoke-product",
      domainId: "gitops-smoke-domain",
      name: `GitOps Smoke ${run}`,
      slug: `proof-${run.toLowerCase()}`,
    },
  });
  await prisma.entity.create({
    data: {
      id: "gitops-smoke-account",
      name: "GitOpsProofAccount",
      slug: "gitops-proof-account",
      tenantId: ctx.tenantId!,
      domainId: "gitops-smoke-domain",
      productId: "gitops-smoke-product",
      ownerId: ctx.userId,
      description: "GitOps proof",
      fields: {
        create: [
          {
            id: "gitops-smoke-id",
            name: "id",
            slug: "id",
            type: "string",
            nullable: false,
            isKey: true,
            aliases: [],
            sortOrder: 0,
            decorators: { typespec: { identity: { format: "uuid" } } },
          },
          {
            id: "gitops-smoke-name",
            name: "displayName",
            slug: "display-name",
            type: "string",
            nullable: true,
            aliases: [],
            sortOrder: 1,
          },
        ],
      },
    },
  });
  const binding = await prisma.tenantGitBinding.create({
    data: {
      id: "gitops-smoke-binding",
      tenantId: ctx.tenantId!,
      repositoryUrl: url,
      installationId: "1",
      branch: `${prefix}/development`,
      basePath: root,
      createdBy: ctx.userId,
    },
  });
  const stages = ["development", "staging", "qa", "production"].map((name) => ({
    name,
    branch: `${prefix}/${name}`,
    path: "environments",
  }));
  const targets = [
    {
      target: "json-schema",
      repositoryUrl: url,
      installationId: "1",
      branch: binding.branch,
      pathTemplate: "artifacts/{product}/{object}/{version}/{target}",
      enabled: true,
    },
  ];
  await prisma.productGitSettings.create({
    data: {
      productId: "gitops-smoke-product",
      tenantId: ctx.tenantId!,
      bindingId: binding.id,
      stages,
      targets,
    },
  });
  // Credential provisioning is intentionally separate: the hosted protocol uses the verified human token above.
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();
  await prisma.gitProviderApp.create({
    data: {
      id: "github",
      appId: "1",
      privateKey: sealSecret(privateKey, "GitProviderApp.privateKey"),
      webhookSecret: sealSecret(
        "hosted-smoke-webhook-only",
        "GitProviderApp.webhookSecret",
      ),
      clientId: "hosted-smoke",
      clientSecret: sealSecret("hosted-smoke", "GitProviderApp.clientSecret"),
    },
  });
  const workflowId = await ensureDefaultWorkflow(
    binding,
    "gitops-smoke-product",
    ctx.userId,
    stages,
  );
  report.defaultWorkflowId = workflowId;
  await setTenantContentStorage(ctx.tenantId!, "git", 1, ctx);
  let cs = await store.bootstrap("gitops-smoke-product", ctx);
  cs = await store.submit(
    cs.id,
    `[GitOps proof ${run}] bootstrap`,
    "Isolated storage-backend acceptance test.",
    ctx,
  );
  assert.equal(
    (await recordPR(cs.prNumber!, "bootstrap")).user.login,
    actor.login,
  );
  await merge(cs.prNumber!);
  await synchronizeBinding(binding.id, provider);
  const row = await prisma.gitCanonicalDocument.findFirstOrThrow({
      where: { kind: "Entity", stage: "SNAPSHOT" },
    }),
    document = validateDocument(row.document);
  document.spec.record.description = "Private draft before GitHub review";
  let edit = await store.saveDraft(
    { productId: "gitops-smoke-product", document },
    undefined,
    ctx,
  );
  assert.equal(
    (await prisma.entity.findUniqueOrThrow({ where: { id: document.id } }))
      .description,
    "GitOps proof",
  );
  edit = await store.submit(
    edit.id,
    `[GitOps proof ${run}] reviewed edit`,
    "Verify private drafts and user-authored PR updates.",
    ctx,
  );
  await recordPR(edit.prNumber!, "edit");
  document.spec.record.description = "Merged reviewed GitOps content";
  await store.saveDraft(
    { productId: "gitops-smoke-product", document },
    undefined,
    ctx,
  );
  const update = await store.submit(
    edit.id,
    edit.title,
    "Second commit on the same PR.",
    ctx,
  );
  assert.equal(update.prNumber, edit.prNumber);
  await merge(edit.prNumber!);
  await synchronizeBinding(binding.id, provider);
  assert.equal(
    (await prisma.entity.findUniqueOrThrow({ where: { id: document.id } }))
      .description,
    "Merged reviewed GitOps content",
  );
  const current = await prisma.tenantGitBinding.findUniqueOrThrow({
      where: { id: binding.id },
    }),
    job = (
      await prisma.gitOpsJob.findMany({ where: { kind: "DELIVERY" } })
    ).find((j) => (j.payload as { sha: string }).sha === current.indexedSha);
  assert.ok(job);
  await deliverArtifacts(binding.id, job.payload, provider);
  const artifact = await prisma.deliveryPullRequest.findFirstOrThrow({
    where: { kind: "ARTIFACT", sourceSha: current.indexedSha! },
  });
  await recordPR(artifact.prNumber!, "json-schema artifact");
  const outputs = await remote.readFiles(
    artifact.headSha!,
    (p) =>
      p.startsWith(root + "/artifacts/") &&
      p.endsWith(".json") &&
      !p.endsWith("superschema-provenance.json"),
  );
  assert.ok(outputs.length);
  const schema = outputs
    .map((f) => JSON.parse(f.content))
    .find((s) => s.properties?.id);
  assert.ok(schema, "The actual emitter must generate the id field");
  assert.equal(schema.properties.id.type, "string");
  assert.equal(schema.properties.id.format, "uuid");
  assert.ok(schema.required.includes("id"));
  report.emittedFiles = outputs.map((f) => f.path);
  await merge(artifact.prNumber!);
  await synchronizeBinding(binding.id, provider);
  await assert.rejects(
    () =>
      promoteEnvironment("gitops-smoke-product", "production", ctx, provider),
    /Merge qa/,
  );
  for (const name of ["staging", "qa", "production"]) {
    const stage = await promoteEnvironment(
      "gitops-smoke-product",
      name,
      ctx,
      provider,
    );
    await recordPR(stage.prNumber!, name);
    await merge(stage.prNumber!);
    await synchronizeBinding(binding.id, provider);
  }
  let release = await store.promote("gitops-smoke-product", document.id, ctx);
  release = await store.submit(
    release.id,
    `[GitOps proof ${run}] release 1.0.0`,
    "Promote the frozen snapshot through GitHub review.",
    ctx,
  );
  await recordPR(release.prNumber!, "release");
  await merge(release.prNumber!);
  await synchronizeBinding(binding.id, provider);
  assert.equal(
    (await prisma.entityVersion.findFirstOrThrow()).stage,
    "RELEASED",
  );
  const workspace = await getGitOpsWorkspace(
    ctx.tenantId!,
    "gitops-smoke-product",
    ctx,
  );
  report.uiEntryCount = workspace.documents.length;
  report.environmentStates = workspace.deliveries
    .filter((d) => d.kind === "ENVIRONMENT")
    .map((d) => ({ environment: d.target, state: d.state }));
  assert.ok(workspace.changeSets.every((c) => c.state === "MERGED"));
  assert.equal(
    report.environmentStates instanceof Array &&
      report.environmentStates.length,
    3,
  );
  assert.equal(
    await remote.base("main"),
    main,
    "The default branch must remain unchanged",
  );
  report.status = "passed";
  report.mainAfter = await remote.base("main");
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message : "Hosted test failed";
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  report.branches = [...branches];
  const reportPath = `/tmp/super-schema-gitops-hosted-${run}.json`;
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`Hosted proof report: ${reportPath}`);
  if (!process.argv.includes("--keep")) {
    for (const pr of pullRequests)
      try {
        const state = api<{ state: string }>("GET", `/pulls/${pr.number}`);
        if (state.state === "open")
          api("PATCH", `/pulls/${pr.number}`, { state: "closed" });
      } catch {
        console.error(`Could not close test PR #${pr.number}`);
      }
    for (const branch of branches)
      try {
        assert.ok(
          branch.toLowerCase().includes(run.toLowerCase()) ||
            branch.includes("gitops-smoke-product"),
        );
        api("DELETE", `/git/refs/heads/${encodeURIComponent(branch)}`);
      } catch {
        console.error(`Could not remove test branch ${branch}`);
      }
  }
  await prisma.$disconnect();
  await hostedPg.close();
}
