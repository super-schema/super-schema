import { prisma } from "@/lib/db";
import { ctxCan, scopeKey } from "@/lib/access";
import { getDbProvider } from "@/lib/db-provider";
import { generateSlug } from "@/lib/slug";
import { GitOpsError, ProductSettingsSchema } from "@/lib/gitops/contracts";
import {
  NewTenantSchema,
  TenantGitProfileSchema,
  TenantStorageSchema,
  type TenantGitProfile,
} from "@/lib/gitops/tenant-storage-contracts";
import { resolveTenantStorage } from "@/lib/gitops/tenant-mode";
import { DEFAULT_GITOPS_STAGES } from "@/lib/gitops/config.mjs";
import { GitHubProvider } from "@/lib/gitops/provider";
import {
  requireAccess,
  rootBinding,
  saveBinding,
  saveProductSettings,
  providerFor,
  assertGitRootAvailable,
  type ProviderFactory,
} from "./gitops/settings";
import { GitContentStore } from "./gitops/content-store";
import { enqueueJob } from "./gitops/sync";
import { ensureBundledTraits } from "./events/bundled-traits.service";
import type { ServiceContext } from "@/types/service-context";
import type { Prisma, TenantGitBinding } from "@/generated/prisma/client";

function requireStorage(ctx: ServiceContext, tenantId: string) {
  requireAccess(ctx, "tenant.storage.configure", { tenantId });
}
function namedSlug(name: string) {
  const slug = generateSlug(name);
  if (!slug) throw new GitOpsError("Names must contain a letter or number");
  return slug;
}

export async function getTenantStorageSettings(
  tenantId: string,
  ctx: ServiceContext,
) {
  requireStorage(ctx, tenantId);
  const [
    tenant,
    app,
    link,
    root,
    products,
    bindings,
    settings,
    canonicalCount,
    publicPrs,
    openDrafts,
  ] = await Promise.all([
    prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
    prisma.gitProviderApp.findUnique({
      where: { id: "github" },
      select: { appId: true, clientId: true, baseUrl: true, revision: true },
    }),
    prisma.gitUserLink.findUnique({
      where: { userId: ctx.userId },
      select: { login: true, appRevision: true },
    }),
    rootBinding(tenantId),
    prisma.product.findMany({
      where: { domain: { tenantId } },
      include: { domain: { select: { slug: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.tenantGitBinding.findMany({ where: { tenantId } }),
    prisma.productGitSettings.findMany({ where: { tenantId } }),
    prisma.gitCanonicalDocument.count({ where: { tenantId } }),
    prisma.changeSet.findMany({
      where: { tenantId, kind: "BOOTSTRAP", prNumber: { not: null } },
      select: {
        id: true,
        productId: true,
        prUrl: true,
        prNumber: true,
        state: true,
      },
      orderBy: { updatedAt: "desc" },
      take: 100,
    }),
    prisma.changeSet.count({
      where: { tenantId, state: { notIn: ["MERGED", "CLOSED"] } },
    }),
  ]);
  const mode = resolveTenantStorage(tenant.contentStorage);
  const manifests = await prisma.gitCanonicalDocument.findMany({
    where: { tenantId, kind: "Product" },
    select: { objectId: true, bindingId: true },
  });
  const ready =
    products.length > 0 &&
    products.every((p) => {
      const setting = settings.find((s) => s.productId === p.id),
        binding = bindings.find(
          (b) => b.id === (setting?.bindingId ?? root?.id),
        );
      return (
        binding?.enabled &&
        binding.indexedSha &&
        manifests.some(
          (m) => m.objectId === p.id && m.bindingId === binding.id,
        ) &&
        binding.lastSyncStatus !== "ERROR"
      );
    });
  const publicSourceCount = await prisma.changeSet.count({
    where: { tenantId, prNumber: { not: null } },
  });
  const canReturnToDatabase =
    canonicalCount === 0 && publicSourceCount === 0 && openDrafts === 0;
  const first = settings.find((s) => s.bindingId === root?.id);
  const defaults = ProductSettingsSchema.safeParse(root?.workflowDefaults);
  const parsed = ProductSettingsSchema.shape.stages.safeParse(
    defaults.success ? defaults.data.stages : first?.stages,
  );
  const stages = parsed.success
    ? parsed.data
    : tenant.deploymentEnvironments.map((name, index) => ({
        name,
        branch:
          index === 0 ? (root?.branch ?? `gitops/${name}`) : `gitops/${name}`,
        path: "environments",
      }));
  const state =
    mode === "database"
      ? "database"
      : !app
        ? "app_required"
        : !root?.enabled
          ? "repository_required"
          : !products.length
            ? "workspace_required"
            : ready
              ? "ready"
              : bindings.some((b) => b.lastSyncStatus === "ERROR")
                ? "index_error"
                : publicPrs.some((p) => !["MERGED", "CLOSED"].includes(p.state))
                  ? "review"
                  : publicPrs.some((p) => p.state === "MERGED")
                    ? "sync_required"
                    : "bootstrap_required";
  return {
    tenant: {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      description: tenant.description,
      mode,
      revision: tenant.storageRevision,
    },
    database:
      getDbProvider() === "postgresql" ? "PostgreSQL" : "Embedded PostgreSQL",
    app: app
      ? { appId: app.appId, clientId: app.clientId, baseUrl: app.baseUrl }
      : null,
    github: link
      ? { login: link.login, connected: link.appRevision === app?.revision }
      : null,
    canCreateTenant: ctxCan(ctx, "platform.admin"),
    canManageApp: ctxCan(ctx, "git.manage"),
    canReturnToDatabase,
    binding: root
      ? {
          id: root.id,
          repositoryUrl: root.repositoryUrl,
          installationId: root.installationId,
          branch: root.branch,
          basePath: root.basePath,
          enabled: root.enabled,
          indexedSha: root.indexedSha,
          lastSyncStatus: root.lastSyncStatus,
          lastError: root.lastError,
        }
      : null,
    profile: {
      binding: {
        repositoryUrl: root?.repositoryUrl ?? "",
        installationId: root?.installationId ?? "",
        branch: root?.branch ?? stages[0]?.branch ?? "gitops/development",
        basePath: root?.basePath ?? `superschema/${tenant.slug}`,
        enabled: true,
      },
      owners: defaults.success ? defaults.data.owners : (first?.owners ?? []),
      stages: stages.length
        ? stages
        : DEFAULT_GITOPS_STAGES.map((s) => ({ ...s })),
    },
    defaults: {
      stages: DEFAULT_GITOPS_STAGES.map((s) => ({ ...s })),
      branch: "gitops/development",
      basePath: "superschema",
    },
    products: products.map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      domainSlug: p.domain.slug,
    })),
    state,
    initialPrs: publicPrs.map((p) => ({
      ...p,
      productName:
        products.find((v) => v.id === p.productId)?.name ?? "Product",
    })),
  };
}

async function verifyProfile(
  tenantId: string,
  input: TenantGitProfile,
  ctx: ServiceContext,
  provider: ProviderFactory,
) {
  await assertGitRootAvailable(tenantId, input.binding);
  const candidate = {
    ...input.binding,
    id: "onboarding",
    tenantId,
    productId: null,
    createdBy: ctx.userId,
  } as TenantGitBinding;
  const remote = await provider(candidate);
  await remote.base(input.binding.branch);
  if (remote instanceof GitHubProvider) await remote.verify();
  for (const stage of input.stages) await remote.base(stage.branch);
}
async function workspace(
  tx: Prisma.TransactionClient,
  tenantId: string,
  domainName = "General",
  productName = "Workspace",
) {
  const existing = await tx.product.findFirst({
    where: { domain: { tenantId } },
  });
  if (existing) return existing;
  const domainSlug = namedSlug(domainName),
    productSlug = namedSlug(productName);
  const domain =
    (await tx.domain.findFirst({ where: { tenantId, slug: domainSlug } })) ??
    (await tx.domain.create({
      data: { tenantId, name: domainName, slug: domainSlug },
    }));
  return tx.product.create({
    data: { domainId: domain.id, name: productName, slug: productSlug },
  });
}

export async function saveTenantGitProfile(
  tenantId: string,
  raw: unknown,
  ctx: ServiceContext,
  provider: ProviderFactory = providerFor,
) {
  requireStorage(ctx, tenantId);
  const input = TenantGitProfileSchema.parse(raw);
  if (
    await prisma.changeSet.findFirst({
      where: {
        tenantId,
        kind: "BOOTSTRAP",
        state: { notIn: ["MERGED", "CLOSED"] },
      },
    })
  )
    throw new GitOpsError(
      "Merge or discard the initial import before changing its workflow settings",
      "BOOTSTRAP_IN_PROGRESS",
    );
  await verifyProfile(tenantId, input, ctx, provider);
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "tenants" WHERE id=${tenantId} FOR UPDATE`;
    await workspace(tx, tenantId);
  });
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
  });
  const environments = [
    ...new Set([
      ...tenant.deploymentEnvironments,
      ...input.stages.map((s) => s.name),
    ]),
  ];
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { deploymentEnvironments: environments },
  });
  const binding = await saveBinding(tenantId, input.binding, ctx, provider);
  await prisma.tenantGitBinding.update({
    where: { id: binding.id },
    data: {
      workflowDefaults: JSON.parse(
        JSON.stringify({
          owners: input.owners,
          stages: input.stages,
          targets: [],
        }),
      ),
    },
  });
  const products = await prisma.product.findMany({
    where: { domain: { tenantId } },
  });
  for (const product of products) {
    const previous = await prisma.productGitSettings.findUnique({
      where: { productId: product.id },
    });
    if (previous && previous.bindingId !== binding.id) continue;
    await saveProductSettings(
      product.id,
      {
        stages: input.stages,
        owners: input.owners,
        targets: previous?.targets ?? [],
      },
      ctx,
      provider,
    );
  }
  return { bindingId: binding.id };
}

export async function setTenantContentStorage(
  tenantId: string,
  raw: unknown,
  revision: number,
  ctx: ServiceContext,
) {
  requireStorage(ctx, tenantId);
  const mode = TenantStorageSchema.parse(raw);
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      { id: string; contentStorage: string | null; storageRevision: number }[]
    >`SELECT id,"contentStorage","storageRevision" FROM "tenants" WHERE id=${tenantId} FOR UPDATE`;
    const tenant = rows[0];
    if (!tenant) throw new GitOpsError("Tenant not found");
    if (tenant.storageRevision !== revision)
      throw new GitOpsError(
        "Storage settings changed in another tab; reload before saving",
        "CONFLICT",
      );
    if (resolveTenantStorage(tenant.contentStorage) === mode) return;
    if (mode === "database") {
      const [documents, publicChanges, drafts] = await Promise.all([
        tx.gitCanonicalDocument.count({ where: { tenantId } }),
        tx.changeSet.count({ where: { tenantId, prNumber: { not: null } } }),
        tx.changeSet.count({
          where: { tenantId, state: { notIn: ["MERGED", "CLOSED"] } },
        }),
      ]);
      if (documents || publicChanges || drafts)
        throw new GitOpsError(
          "This tenant has Git history or drafts. Export and migrate its content before switching to database storage.",
          "MIGRATION_REQUIRED",
        );
    } else {
      const binding = await tx.tenantGitBinding.findFirst({
        where: { tenantId, productId: null, enabled: true },
      });
      if (!binding)
        throw new GitOpsError(
          "Connect and verify a repository before choosing Git storage",
        );
      const previous = await tx.gitCanonicalDocument.count({
        where: { tenantId },
      });
      if (previous)
        throw new GitOpsError(
          "Review this tenant's existing Git index before migrating database content",
          "MIGRATION_REQUIRED",
        );
      await workspace(tx, tenantId);
    }
    await tx.tenant.update({
      where: { id: tenantId },
      data: { contentStorage: mode, storageRevision: { increment: 1 } },
    });
  });
  return { mode };
}

export async function onboardTenant(
  raw: unknown,
  ctx: ServiceContext,
  provider: ProviderFactory = providerFor,
) {
  if (!ctxCan(ctx, "platform.admin"))
    throw new GitOpsError(
      "Platform administrator access is required to create a tenant",
      "FORBIDDEN",
    );
  const input = NewTenantSchema.parse(raw),
    slug = namedSlug(input.name);
  namedSlug(input.domainName);
  namedSlug(input.productName);
  if (input.storage === "git" && input.git)
    await verifyProfile("new-tenant", input.git, ctx, provider);
  const tenant = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: {
        name: input.name,
        slug,
        description: input.description,
        contentStorage: input.storage,
        ...(input.git
          ? { deploymentEnvironments: input.git.stages.map((s) => s.name) }
          : {}),
      },
    });
    await tx.userRole.create({
      data: {
        userId: ctx.userId,
        role: "ADMIN",
        scopeKey: scopeKey({ kind: "TENANT", tenantId: tenant.id }),
        tenantId: tenant.id,
        grantedById: ctx.userId,
      },
    });
    await workspace(tx, tenant.id, input.domainName, input.productName);
    return tenant;
  });
  let notice: string | undefined;
  if (input.storage === "git" && input.git) {
    try {
      await saveTenantGitProfile(
        tenant.id,
        input.git,
        { ...ctx, tenantId: tenant.id },
        provider,
      );
    } catch (e) {
      notice =
        e instanceof GitOpsError
          ? e.message
          : "Tenant created. Reconnect its repository in storage settings to finish Git setup.";
    }
  } else {
    const traits = await ensureBundledTraits(prisma, tenant.id);
    if (!traits.success)
      notice =
        "Tenant created. Built-in traits can be retried from the database maintenance tools.";
  }
  return { tenantId: tenant.id, mode: input.storage, notice };
}

export async function startTenantBootstrap(
  tenantId: string,
  ctx: ServiceContext,
  provider: ProviderFactory = providerFor,
) {
  requireStorage(ctx, tenantId);
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
  });
  if (resolveTenantStorage(tenant.contentStorage) !== "git")
    throw new GitOpsError(
      "Choose Git storage before creating its initial import PR",
    );
  const link = await prisma.gitUserLink.findUnique({
    where: { userId: ctx.userId },
  });
  // A supplied provider is used by isolated protocol tests; production always requires the real human link.
  if (provider === providerFor && !link)
    throw new GitOpsError(
      "Connect your GitHub account before creating the initial import PR",
    );
  const products = await prisma.product.findMany({
    where: { domain: { tenantId } },
  });
  if (!products.length)
    throw new GitOpsError("Create the tenant's initial workspace first");
  const store = new GitContentStore(provider),
    result = [];
  for (const product of products) {
    const settings = await prisma.productGitSettings.findUnique({
        where: { productId: product.id },
      }),
      binding = settings
        ? await prisma.tenantGitBinding.findUnique({
            where: { id: settings.bindingId },
          })
        : await rootBinding(tenantId);
    if (!binding?.enabled)
      throw new GitOpsError("Connect an enabled Git repository first");
    if (
      await prisma.gitCanonicalDocument.findFirst({
        where: { bindingId: binding.id, kind: "Product", objectId: product.id },
      })
    )
      continue;
    const existing = await prisma.changeSet.findFirst({
      where: {
        tenantId,
        productId: product.id,
        kind: "BOOTSTRAP",
        prNumber: { not: null },
        state: { notIn: ["MERGED", "CLOSED"] },
      },
    });
    if (existing) {
      result.push({ url: existing.prUrl, number: existing.prNumber });
      continue;
    }
    const draft = await store.bootstrap(product.id, ctx),
      submitted = await store.submit(
        draft.id,
        `${tenant.name}: initialize ${product.name}`,
        "Initial tenant import. Review and merge to make the GitHub repository authoritative.",
        ctx,
      );
    result.push({ url: submitted.prUrl, number: submitted.prNumber });
  }
  return { pullRequests: result };
}

export async function syncTenantStorage(tenantId: string, ctx: ServiceContext) {
  requireStorage(ctx, tenantId);
  const bindings = await prisma.tenantGitBinding.findMany({
    where: { tenantId, enabled: true },
  });
  for (const binding of bindings)
    await enqueueJob(binding.id, "SYNC", `tenant-setup:${crypto.randomUUID()}`);
  return { queued: bindings.length };
}
