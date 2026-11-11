import { cacheGitArtifact } from "./artifact-cache";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/types/service-context";
import { getSchemaTargetCatalog } from "@/lib/schema-targets/catalog";
import {
  GitOpsError,
  ProductSettingsSchema,
  type CanonicalDocument,
  type FileChange,
} from "@/lib/gitops/contracts";
import {
  canonicalPath,
  documentSlug,
  objectKey,
  rootedPath,
  validateDocument,
  validateRepository,
} from "@/lib/gitops/canonical";
import { renderCanonicalArtifact } from "@/lib/gitops/render";
import {
  bindingFor,
  json,
  productFor,
  providerFor,
  type ProviderFactory,
} from "./settings";

export async function deliverArtifacts(
  bindingId: string,
  payload: unknown,
  provider: ProviderFactory = providerFor,
): Promise<void> {
  const input = payload as {
    productId: string;
    sha: string;
    documents: unknown[];
    changed: string[];
  };
  const binding = await prisma.tenantGitBinding.findUniqueOrThrow({
      where: { id: bindingId },
    }),
    settings = await prisma.productGitSettings.findUniqueOrThrow({
      where: { productId: input.productId },
    }),
    product = await prisma.product.findUniqueOrThrow({
      where: { id: input.productId },
    });
  if (settings.bindingId !== binding.id)
    throw new GitOpsError(
      "The artifact source binding changed; resynchronize before delivery",
    );
  if (!binding.enabled) throw new GitOpsError("The GitOps binding is disabled");
  const all = input.documents.map(validateDocument),
    changed = all.filter(
      (d) =>
        d.scope.productId === product.id &&
        input.changed.includes(objectKey(d)) &&
        !d.deleted,
    );
  const definitions = ProductSettingsSchema.parse({
    repositoryUrl: settings.repositoryUrl ?? undefined,
    installationId: settings.installationId ?? undefined,
    branch: settings.branch ?? undefined,
    basePath: settings.basePath ?? undefined,
    owners: settings.owners,
    stages: settings.stages,
    targets: settings.targets,
  });
  const targets = definitions.targets.length
    ? definitions.targets.filter((t) => t.enabled)
    : [
        ...getSchemaTargetCatalog()
          .filter((t) => t.enabledInSchemaTab)
          .map((t) => t.key),
        "asyncapi",
      ].map((target) => ({
        target,
        repositoryUrl: binding.repositoryUrl,
        installationId: binding.installationId,
        branch: binding.branch,
        pathTemplate: "artifacts/{product}/{object}/{version}/{target}",
        enabled: true,
      }));
  for (const target of targets) {
    const docs = changed.filter(
      (d) =>
        (d.kind === "Entity" && target.target !== "asyncapi") ||
        (d.kind === "Event" && target.target === "asyncapi"),
    );
    if (!docs.length) continue;
    // Snapshots roll together; each released version receives an independent reviewable PR.
    const groups = new Map<string, CanonicalDocument[]>();
    for (const d of docs) {
      const key = d.stage === "RELEASED" ? `${d.id}-${d.version}` : "snapshots";
      groups.set(key, [...(groups.get(key) ?? []), d]);
    }
    for (const [group, versions] of groups) {
      const sameRepo =
          target.repositoryUrl.replace(/\.git$/, "").toLowerCase() ===
          binding.repositoryUrl.replace(/\.git$/, "").toLowerCase(),
        root = sameRepo ? binding.basePath : "";
      const remote = await provider({
        ...binding,
        repositoryUrl: target.repositoryUrl,
        installationId: target.installationId,
      });
      const baseSha = await remote.base(target.branch),
        files: FileChange[] = [];
      for (const d of versions) {
        const variables: Record<string, string> = {
          product: product.slug,
          object: documentSlug(d),
          version: d.version!,
          target: target.target,
          domain: d.scope.domainSlug ?? "tenant",
          tenant: d.scope.tenantSlug,
        };
        const directory = target.pathTemplate.replace(
          /\{([a-z]+)\}/g,
          (_m, key: string) => variables[key] ?? "INVALID",
        );
        if (
          directory.includes("{") ||
          directory.startsWith("/") ||
          directory.split("/").some((p) => !p || p === ".." || p === ".")
        )
          throw new GitOpsError("Invalid artifact path template");
        const outputs = await renderCanonicalArtifact(
          d,
          target.target,
          all,
          binding.createdBy,
        );
        await cacheGitArtifact(d, target.target, outputs, input.sha);
        for (const f of outputs)
          files.push({
            path: rootedPath(root, `${directory}/${f.path}`),
            content: f.content,
          });
        files.push({
          path: rootedPath(root, `${directory}/superschema-provenance.json`),
          content:
            JSON.stringify(
              {
                objectId: d.id,
                version: d.version,
                sourceCommit: input.sha,
                sourceRepository: binding.repositoryUrl,
                files: outputs.map((f) => ({
                  path: f.path,
                  sha256: createHash("sha256").update(f.content).digest("hex"),
                })),
              },
              null,
              2,
            ) + "\n",
        });
      }
      const key = `artifact:${product.id}:${target.repositoryUrl}:${target.target}:${group}`,
        prior = await prisma.deliveryPullRequest.findUnique({
          where: { deliveryKey: key },
        });
      const branch =
        prior && !["DELIVERED", "CLOSED"].includes(prior.state)
          ? prior.branch
          : `superschema/${product.slug}/${target.target}/${group}/${input.sha.slice(0, 12)}`;
      const row = await prisma.deliveryPullRequest.upsert({
        where: { deliveryKey: key },
        create: {
          deliveryKey: key,
          productId: product.id,
          bindingId,
          kind: "ARTIFACT",
          target: target.target,
          installationId: target.installationId,
          repositoryUrl: target.repositoryUrl,
          baseBranch: target.branch,
          branch,
          sourceSha: input.sha,
          versions: json(
            versions.map((d) => ({ id: d.id, version: d.version })),
          ),
        },
        update: {
          sourceSha: input.sha,
          branch,
          state: "PENDING",
          versions: json(
            versions.map((d) => ({ id: d.id, version: d.version })),
          ),
        },
      });
      try {
        const receipt = await remote.commit({
          baseBranch: target.branch,
          baseSha,
          branch,
          root,
          expectedHead:
            prior && !["DELIVERED", "CLOSED"].includes(prior.state)
              ? (prior.headSha ?? undefined)
              : undefined,
          files,
          title: `${product.name}: ${target.target} ${group}`,
          body: `Generated from canonical commit ${input.sha}. Source: ${binding.repositoryUrl}/commit/${input.sha}. Review and merge in this repository.`,
          marker: `SuperSchema-Delivery: ${row.id}`,
        });
        await prisma.deliveryPullRequest.update({
          where: { id: row.id },
          data: {
            prNumber: receipt.prNumber,
            prUrl: receipt.prUrl,
            headSha: receipt.sha,
            state: "PR_OPEN",
            lastError: null,
          },
        });
      } catch (e) {
        await prisma.deliveryPullRequest.update({
          where: { id: row.id },
          data: {
            state: "FAILED",
            lastError:
              e instanceof GitOpsError ? e.message : "Artifact delivery failed",
          },
        });
        throw e;
      }
    }
  }
}
export async function synchronizeOwners(
  bindingId: string,
  provider: ProviderFactory = providerFor,
): Promise<void> {
  const binding = await prisma.tenantGitBinding.findUniqueOrThrow({
      where: { id: bindingId },
    }),
    remote = await provider(binding),
    sha = await remote.base(binding.branch);
  const docs = (
    await prisma.gitCanonicalDocument.findMany({
      where: { bindingId, kind: { in: ["Product", "Domain"] } },
    })
  ).map((d) => validateDocument(d.document));
  const lines = docs
    .filter((d) => d.owners.length)
    .map(
      (d) =>
        `/${canonicalPath(binding.basePath, d).replace(/(?:domain|product)\.yaml$/, "")} ${d.owners.join(" ")}`,
    );
  // GitHub does not load nested CODEOWNERS. Folder bindings receive a fragment; no file outside the configured root is touched.
  const path = rootedPath(
    binding.basePath,
    binding.basePath
      ? ".superschema/CODEOWNERS.fragment"
      : ".github/CODEOWNERS",
  );
  const old = await remote.readFiles(sha, (p) => p === path),
    start = `# superschema:${bindingId}:start`,
    end = `# superschema:${bindingId}:end`,
    block = `${start}\n${lines.join("\n")}\n${end}\n`;
  const priorText = old[0]?.content ?? "",
    from = priorText.indexOf(start),
    to = priorText.indexOf(end, from);
  const content =
    from >= 0 && to >= from
      ? priorText.slice(0, from) +
        block +
        priorText.slice(to + end.length).replace(/^\n/, "")
      : priorText +
        (priorText && !priorText.endsWith("\n") ? "\n" : "") +
        block;
  const file = { path, content };
  if (priorText === content) return;
  const product = await prisma.productGitSettings.findFirst({
    where: { bindingId },
  });
  if (!product) return;
  const key = `owners:${bindingId}`,
    prior = await prisma.deliveryPullRequest.findUnique({
      where: { deliveryKey: key },
    }),
    branch =
      prior && !["DELIVERED", "CLOSED"].includes(prior.state)
        ? prior.branch
        : `superschema/owners/${bindingId}/${sha.slice(0, 12)}`;
  const receipt = await remote.commit({
    baseBranch: binding.branch,
    baseSha: sha,
    branch,
    root: binding.basePath,
    expectedHead:
      prior && !["DELIVERED", "CLOSED"].includes(prior.state)
        ? (prior.headSha ?? undefined)
        : undefined,
    files: [file],
    title: "Synchronize schema owners",
    body: binding.basePath
      ? "Ownership fragment for the configured folder. A repository administrator must integrate these entries into the repository CODEOWNERS file to enable GitHub enforcement."
      : "Synchronize schema ownership from the canonical manifests. Review before merging.",
    marker: `SuperSchema-Owners: ${bindingId}`,
  });
  await prisma.deliveryPullRequest.upsert({
    where: { deliveryKey: key },
    create: {
      deliveryKey: key,
      productId: product.productId,
      bindingId,
      kind: "OWNERS",
      target: "owners",
      repositoryUrl: binding.repositoryUrl,
      baseBranch: binding.branch,
      branch,
      sourceSha: sha,
      prNumber: receipt.prNumber,
      prUrl: receipt.prUrl,
      headSha: receipt.sha,
      state: "PR_OPEN",
    },
    update: {
      branch,
      sourceSha: sha,
      prNumber: receipt.prNumber,
      prUrl: receipt.prUrl,
      headSha: receipt.sha,
      state: "PR_OPEN",
    },
  });
}
export async function promoteEnvironment(
  productId: string,
  name: string,
  ctx: ServiceContext,
  provider: ProviderFactory = providerFor,
) {
  const product = await productFor(productId, ctx, "deploy.run"),
    { binding, settings } = await bindingFor(productId);
  if (!settings || !binding.indexedSha)
    throw new GitOpsError("Synchronize the product binding first");
  const stages = ProductSettingsSchema.shape.stages.parse(settings.stages),
    index = stages.findIndex((s) => s.name === name);
  if (index <= 0)
    throw new GitOpsError("Choose an environment after the source environment");
  const sourceSha = settings.sourceSha ?? binding.indexedSha,
    previous = stages[index - 1];
  if (
    index > 1 &&
    !(await prisma.deliveryPullRequest.findFirst({
      where: {
        productId,
        kind: "ENVIRONMENT",
        target: previous.name,
        sourceSha,
        state: "DELIVERED",
      },
    }))
  )
    throw new GitOpsError(
      `Merge ${previous.name} for this exact source commit before promoting to ${name}`,
    );
  const source = await provider(binding),
    target = await provider(binding, ctx.userId),
    baseSha = await target.base(stages[index].branch);
  const prefix = binding.basePath ? `${binding.basePath}/` : "",
    sourceFiles = await source.readFiles(
      sourceSha,
      (p) =>
        p.startsWith(prefix) &&
        /(?:tenant|domain|product|entity|event|trait|enum|scalar|union|service|interface|model|decorator)\.yaml$/.test(
          p,
        ),
    );
  const selected = sourceFiles.filter((f) => {
    const d = validateRepository([f], binding.basePath).documents[0]?.document;
    return (
      d &&
      (d.scope.productId === productId ||
        (!d.scope.productId &&
          (!d.scope.domainId || d.scope.domainId === product.domainId)))
    );
  });
  const baseline = await target.readFiles(
    baseSha,
    (p) =>
      p.startsWith(prefix) &&
      /(?:tenant|domain|product|entity|event|trait|enum|scalar|union|service|interface|model|decorator)\.yaml$/.test(
        p,
      ),
  );
  const candidate = new Map(
    baseline.map((f) => [f.path, { path: f.path, content: f.content }]),
  );
  const selectedPaths = new Set(selected.map((f) => f.path));
  // Promotion replaces the product's canonical tree. Leaving the old snapshot beside
  // its release would make the target environment invalid and resurrect stale content.
  const removed = baseline.filter((f) => {
    const d = validateRepository([f], binding.basePath).documents[0]?.document;
    return (
      d &&
      !selectedPaths.has(f.path) &&
      (d.scope.productId === productId ||
        (!d.scope.productId &&
          (!d.scope.domainId || d.scope.domainId === product.domainId)))
    );
  });
  for (const file of removed) candidate.delete(file.path);
  for (const file of selected) candidate.set(file.path, file);
  const validation = validateRepository(
    [...candidate.values()],
    binding.basePath,
    baseline,
  );
  if (validation.errors.length)
    throw new GitOpsError(validation.errors.map((e) => e.message).join("; "));
  const manifest = {
    productId,
    product: product.slug,
    environment: name,
    previousEnvironment: previous.name,
    canonicalCommit: sourceSha,
    files: selected.map((f) => ({ path: f.path, blobSha: f.sha })),
  };
  const files: FileChange[] = [
    ...removed.map((f) => ({ path: f.path, content: null })),
    ...selected.map((f) => ({ path: f.path, content: f.content })),
    {
      path: rootedPath(
        binding.basePath,
        `${stages[index].path}/${product.slug}/${name.replace(/[^a-zA-Z0-9_-]/g, "-")}.json`,
      ),
      content: JSON.stringify(manifest, null, 2) + "\n",
    },
  ];
  const key = `environment:${productId}:${name}:${sourceSha}`,
    old = await prisma.deliveryPullRequest.findUnique({
      where: { deliveryKey: key },
    });
  if (old?.prUrl) return old;
  const branch = `ss/${product.slug}/environment/${index}/${sourceSha.slice(0, 12)}`;
  const receipt = await target.commit({
    baseBranch: stages[index].branch,
    baseSha,
    branch,
    root: binding.basePath,
    files,
    title: `${product.name}: promote to ${name}`,
    body: `Promote canonical commit ${sourceSha} from ${previous.name} to ${name}. This records schema readiness; application deployment remains owned by the repository.`,
    marker: `SuperSchema-Environment: ${key}`,
  });
  return prisma.deliveryPullRequest.create({
    data: {
      deliveryKey: key,
      productId,
      bindingId: binding.id,
      kind: "ENVIRONMENT",
      target: name,
      repositoryUrl: binding.repositoryUrl,
      baseBranch: stages[index].branch,
      branch,
      sourceSha,
      prNumber: receipt.prNumber,
      prUrl: receipt.prUrl,
      headSha: receipt.sha,
      state: "PR_OPEN",
    },
  });
}
export async function retryGitOpsJob(id: string, ctx: ServiceContext) {
  const job = await prisma.gitOpsJob.findUniqueOrThrow({ where: { id } });
  const binding = await prisma.tenantGitBinding.findUniqueOrThrow({
    where: { id: job.bindingId },
  });
  const productId = (job.payload as { productId?: string })?.productId;
  if (productId) await productFor(productId, ctx, "deploy.run");
  else {
    const { requireAccess } = await import("./settings");
    requireAccess(ctx, "deploy.configure", { tenantId: binding.tenantId });
  }
  return prisma.gitOpsJob.update({
    where: { id },
    data: {
      state: "PENDING",
      attempts: 0,
      dueAt: new Date(),
      leaseToken: null,
      leasedUntil: null,
      lastError: null,
    },
  });
}
