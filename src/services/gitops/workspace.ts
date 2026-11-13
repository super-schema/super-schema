import { prisma } from "@/lib/db";
import { ctxCan } from "@/lib/access";
import { resolveTenantStorage } from "@/lib/gitops/tenant-mode";
import { compareVersion, validateDocument } from "@/lib/gitops/canonical";
import { GitOpsError } from "@/lib/gitops/contracts";
import type { ServiceContext } from "@/types/service-context";
import { productFor, rootBinding } from "./settings";

export async function getGitOpsWorkspace(
  tenantId: string,
  productId: string | undefined,
  ctx: ServiceContext,
) {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
  });
  if (ctx.tenantId !== tenantId)
    throw new GitOpsError("Tenant not found", "NOT_FOUND");
  const products = (
    await prisma.product.findMany({
      where: { domain: { tenantId } },
      include: { domain: true },
      orderBy: { name: "asc" },
    })
  ).filter((p) =>
    ctxCan(ctx, "entity.read", {
      tenantId,
      domainId: p.domainId,
      productId: p.id,
    }),
  );
  const selected = productId ? await productFor(productId, ctx) : products[0];
  const settings = selected
    ? await prisma.productGitSettings.findUnique({
        where: { productId: selected.id },
      })
    : null;
  const tenantBinding = await rootBinding(tenantId);
  const binding = settings
    ? await prisma.tenantGitBinding.findUnique({
        where: { id: settings.bindingId },
      })
    : tenantBinding;
  const changeSets = selected
    ? await prisma.changeSet.findMany({
        where: {
          tenantId,
          productId: selected.id,
          OR: [{ authorId: ctx.userId }, { prNumber: { not: null } }],
        },
        orderBy: { updatedAt: "desc" },
        take: 100,
      })
    : [];
  const [items, documents, errors, deliveries, link, app, jobs] =
    await Promise.all([
      prisma.changeSetItem.findMany({
        where: { changeSetId: { in: changeSets.map((c) => c.id) } },
      }),
      binding && selected
        ? prisma.gitCanonicalDocument.findMany({
            where: {
              bindingId: binding.id,
              OR: [{ productId: selected.id }, { productId: null }],
            },
            orderBy: { path: "asc" },
          })
        : Promise.resolve([]),
      binding
        ? prisma.indexError.findMany({
            where: { bindingId: binding.id },
            take: 100,
          })
        : Promise.resolve([]),
      selected
        ? prisma.deliveryPullRequest.findMany({
            where: { productId: selected.id },
            orderBy: { updatedAt: "desc" },
            take: 100,
          })
        : Promise.resolve([]),
      prisma.gitUserLink.findUnique({
        where: { userId: ctx.userId },
        select: { login: true, updatedAt: true },
      }),
      ctxCan(ctx, "git.manage")
        ? prisma.gitProviderApp.findUnique({
            where: { id: "github" },
            select: { appId: true, clientId: true, baseUrl: true },
          })
        : prisma.gitProviderApp.findUnique({
            where: { id: "github" },
            select: { id: true },
          }),
      binding && ctxCan(ctx, "deploy.configure", { tenantId })
        ? prisma.gitOpsJob.findMany({
            where: { bindingId: binding.id, state: "FAILED" },
            take: 50,
          })
        : Promise.resolve([]),
    ]);
  const visibleDocuments = documents
    .filter((row) => {
      const d = validateDocument(row.document);
      if (d.kind === "Tenant") return true;
      if (d.kind === "Domain") return d.id === selected?.domainId;
      if (d.kind === "Product") return d.id === selected?.id;
      return ctxCan(
        ctx,
        d.kind === "Event"
          ? "event.read"
          : d.kind === "Trait"
            ? "trait.read"
            : d.kind === "Entity"
              ? "entity.read"
              : "asset.read",
        {
          tenantId: d.scope.tenantId,
          domainId: d.scope.domainId,
          productId: d.scope.productId,
        },
      );
    })
    .toSorted(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        a.objectId.localeCompare(b.objectId) ||
        (a.stage === "SNAPSHOT" ? -1 : 1) - (b.stage === "SNAPSHOT" ? -1 : 1) ||
        compareVersion(b.version || "0.0.0", a.version || "0.0.0"),
    );
  const prefix = [
    binding?.basePath,
    selected && `domains/${selected.domain.slug}/products/${selected.slug}/`,
  ]
    .filter(Boolean)
    .join("/");
  const visibleErrors = ctxCan(ctx, "deploy.configure", { tenantId })
    ? errors
    : errors.filter((e) => e.path.startsWith(prefix));
  return {
    mode: resolveTenantStorage(tenant.contentStorage),
    tenant: {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      environments: tenant.deploymentEnvironments,
    },
    userId: ctx.userId,
    products: products.map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      domainId: p.domainId,
      domainSlug: p.domain.slug,
    })),
    selectedProductId: selected?.id,
    settings,
    binding,
    tenantBinding,
    documents: visibleDocuments,
    errors: visibleErrors,
    deliveries,
    link,
    app,
    jobs,
    changeSets: changeSets.map((c) => ({
      ...c,
      leaseToken: null,
      leasedUntil: null,
      // A submitted PR may also have unsent local edits. Keep all draft content
      // private to its author; other readers follow the public GitHub PR link.
      ...(c.authorId !== ctx.userId
        ? { title: `PR #${c.prNumber}`, description: "" }
        : {}),
      items:
        c.authorId === ctx.userId
          ? items.filter((i) => i.changeSetId === c.id)
          : [],
    })),
    canConfigure: ctxCan(ctx, "deploy.configure", { tenantId }),
    canManageApp: ctxCan(ctx, "git.manage"),
    canEdit:
      !!selected &&
      ctxCan(ctx, "entity.write", {
        tenantId,
        domainId: selected.domainId,
        productId: selected.id,
      }),
    canRun:
      !!selected &&
      ctxCan(ctx, "deploy.run", {
        tenantId,
        domainId: selected.domainId,
        productId: selected.id,
      }),
  };
}
