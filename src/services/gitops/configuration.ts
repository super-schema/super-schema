import { prisma } from "@/lib/db";
import { ctxCan } from "@/lib/access";
import { openSecret } from "@/lib/crypto/secret-box";
import { parseRepository } from "@/lib/deployments/github";
import { GitHubProvider } from "@/lib/gitops/provider";
import {
  AppSchema,
  BindingSchema,
  ProductSettingsSchema,
  GitOpsError,
} from "@/lib/gitops/contracts";
import {
  loadGitOpsConfig,
  requiredGitOpsSetupFields,
  resolveGitOpsApp,
} from "@/lib/gitops/config.mjs";
import type { TenantGitBinding } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import {
  configuredApp,
  providerFor,
  requireAccess,
  rootBinding,
  saveApp,
  saveBinding,
  saveProductSettings,
  type ProviderFactory,
} from "./settings";

type LoadedConfiguration = NonNullable<ReturnType<typeof loadGitOpsConfig>>;

/** Explicit operator action. Reuse settings guards and preserve Git-owned workflow changes as drafts. */
export async function applyGitOpsConfiguration(
  loaded: LoadedConfiguration,
  ctx: ServiceContext,
  injectedProvider?: ProviderFactory,
) {
  const c = loaded.config,
    tenantId = c.scope.tenantId;
  const missing = requiredGitOpsSetupFields(c);
  if (missing.length)
    throw new GitOpsError(
      `Complete these configuration fields before applying: ${missing.join(", ")}`,
    );
  requireAccess(ctx, "deploy.configure", { tenantId });
  const actor = await prisma.user.findUnique({ where: { id: ctx.userId } });
  if (
    !actor ||
    actor.disabledAt ||
    actor.email.toLowerCase() !== c.scope.operatorEmail.toLowerCase()
  )
    throw new GitOpsError(
      "Use the enabled operator account named in the configuration",
      "FORBIDDEN",
    );
  if (
    (c.github.app.appId || c.github.app.clientId) &&
    !ctxCan(ctx, "git.manage")
  )
    throw new GitOpsError(
      "Platform administrator access is required to configure the GitHub App",
      "FORBIDDEN",
    );
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
  });
  const requested = new Set(c.scope.productIds);
  const products = await prisma.product.findMany({
    where: {
      domain: { tenantId },
      ...(requested.size ? { id: { in: [...requested] } } : {}),
    },
  });
  if (requested.size !== 0 && products.length !== requested.size)
    throw new GitOpsError("A selected product does not belong to this tenant");
  if (
    c.products.some(
      (p) => !products.some((selected) => selected.id === p.productId),
    )
  )
    throw new GitOpsError(
      "Product overrides must belong to the selected tenant and product scope",
    );
  const binding = BindingSchema.parse({
    repositoryUrl: c.repository.url,
    installationId: c.repository.installationId,
    branch: c.repository.sourceBranch,
    basePath: c.repository.root,
    enabled: c.repository.enabled,
  });
  parseRepository(binding.repositoryUrl);
  const existing = await rootBinding(tenantId);
  if (
    existing &&
    (existing.repositoryUrl !== binding.repositoryUrl ||
      existing.branch !== binding.branch ||
      existing.basePath !== binding.basePath) &&
    (await prisma.gitCanonicalDocument.count({
      where: { bindingId: existing.id },
    }))
  )
    throw new GitOpsError(
      "An indexed binding cannot be repointed; migrate its repository explicitly",
    );
  const appInput = resolveGitOpsApp(loaded),
    app = appInput ? AppSchema.parse(appInput) : null;
  if (!app) await configuredApp();
  const provider: ProviderFactory =
    injectedProvider ??
    (app
      ? async (candidate) => {
          if (new URL(candidate.repositoryUrl).origin !== app.baseUrl)
            throw new GitOpsError(
              "Repository host must match the configured GitHub App",
            );
          return GitHubProvider.installation(
            candidate.repositoryUrl,
            { appId: app.appId, privateKey: app.privateKey },
            candidate.installationId,
          );
        }
      : providerFor);
  const candidate = {
    ...existing,
    ...binding,
    id: existing?.id ?? "configuration-preflight",
    tenantId,
    productId: null,
    createdBy: ctx.userId,
  } as TenantGitBinding;
  const plans = products.map((p) => {
    const override = c.products.find((o) => o.productId === p.id);
    const values = override
      ? Object.fromEntries(
          Object.entries(override).filter(([key]) => key !== "productId"),
        )
      : {};
    return {
      productId: p.id,
      settings: ProductSettingsSchema.parse({ ...c.workflow, ...values }),
    };
  });
  for (const plan of plans) {
    requireAccess(ctx, "deploy.run", {
      tenantId,
      domainId: products.find((p) => p.id === plan.productId)!.domainId,
      productId: plan.productId,
    });
  }
  // Verify every branch and destination before changing credentials or configuration rows.
  const remote = await provider(candidate);
  await remote.base(binding.branch);
  if (remote instanceof GitHubProvider) await remote.verify();
  for (const plan of plans) {
    const prior = await prisma.tenantGitBinding.findUnique({
      where: { productId: plan.productId },
    });
    // Shared workflow defaults must not silently remove an existing product source binding.
    if (
      prior?.enabled &&
      ![
        plan.settings.repositoryUrl,
        plan.settings.installationId,
        plan.settings.branch,
        plan.settings.basePath,
      ].some((value) => value !== undefined)
    ) {
      plan.settings = {
        ...plan.settings,
        repositoryUrl: prior.repositoryUrl,
        installationId: prior.installationId,
        branch: prior.branch,
        basePath: prior.basePath,
      };
    }
    const settings = plan.settings,
      target = {
        ...candidate,
        repositoryUrl: settings.repositoryUrl ?? candidate.repositoryUrl,
        installationId: settings.installationId ?? candidate.installationId,
        branch: settings.branch ?? candidate.branch,
        basePath: settings.basePath ?? candidate.basePath,
      };
    parseRepository(target.repositoryUrl);
    if (settings.stages[0].branch !== target.branch)
      throw new GitOpsError(
        "The first product environment must use its canonical source branch",
      );
    if (
      prior?.indexedSha &&
      (prior.repositoryUrl !== target.repositoryUrl ||
        prior.branch !== target.branch ||
        prior.basePath !== target.basePath)
    )
      throw new GitOpsError("An indexed product binding cannot be repointed");
    const destination = await provider(target);
    for (const stage of settings.stages) await destination.base(stage.branch);
    for (const artifact of settings.targets.filter((t) => t.enabled)) {
      parseRepository(artifact.repositoryUrl);
      await (
        await provider({
          ...target,
          repositoryUrl: artifact.repositoryUrl,
          installationId: artifact.installationId,
        })
      ).base(artifact.branch);
    }
  }
  if (app) {
    const old = await prisma.gitProviderApp.findUnique({
      where: { id: "github" },
    });
    const same =
      old &&
      old.appId === app.appId &&
      old.clientId === app.clientId &&
      old.baseUrl === app.baseUrl &&
      openSecret(old.privateKey, "GitProviderApp.privateKey") ===
        app.privateKey &&
      openSecret(old.clientSecret, "GitProviderApp.clientSecret") ===
        app.clientSecret &&
      openSecret(old.webhookSecret, "GitProviderApp.webhookSecret") ===
        app.webhookSecret;
    if (!same) await saveApp(app, ctx);
  }
  const environments = [
    ...new Set([
      ...tenant.deploymentEnvironments,
      ...c.workflow.stages.map((s) => s.name),
      ...plans.flatMap((p) => p.settings.stages.map((s) => s.name)),
    ]),
  ];
  if (
    JSON.stringify(environments) !==
    JSON.stringify(tenant.deploymentEnvironments)
  )
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { deploymentEnvironments: environments },
    });
  const savedBinding = await saveBinding(tenantId, binding, ctx, provider);
  const results = [];
  if (savedBinding.enabled)
    for (const plan of plans) {
      const saved = await saveProductSettings(
        plan.productId,
        plan.settings,
        ctx,
        provider,
      );
      results.push({
        productId: plan.productId,
        ...("state" in saved
          ? { changeSetId: saved.id }
          : { configured: true }),
      });
    }
  return { bindingId: savedBinding.id, products: results };
}
