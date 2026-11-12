import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { ctxCan, type ActionId } from "@/lib/access";
import { openSecret, sealSecret } from "@/lib/crypto/secret-box";
import { parseRepository } from "@/lib/deployments/github";
import { externalJson } from "@/lib/deployments/http";
import type { ServiceContext } from "@/types/service-context";
import type { Prisma, TenantGitBinding } from "@/generated/prisma/client";
import { contentStorage } from "@/lib/gitops/mode";
import { validateDocument } from "@/lib/gitops/canonical";
import {
  AppSchema,
  BindingSchema,
  ProductSettingsSchema,
  GitOpsError,
  type ProductSettings,
} from "@/lib/gitops/contracts";
import { getSchemaTargetCatalog } from "@/lib/schema-targets/catalog";
import { GitHubProvider, type GitProvider } from "@/lib/gitops/provider";

export const json = (v: unknown) =>
  JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
export function requireAccess(
  ctx: ServiceContext,
  action: ActionId,
  scope: { tenantId: string; domainId?: string; productId?: string },
): void {
  if (
    (ctx.tenantId && ctx.tenantId !== scope.tenantId) ||
    !ctxCan(ctx, action, scope)
  )
    throw new GitOpsError("GitOps access denied", "FORBIDDEN");
}
export async function productFor(
  id: string,
  ctx: ServiceContext,
  action: ActionId = "entity.read",
) {
  const p = await prisma.product.findUnique({
    where: { id },
    include: { domain: { include: { tenant: true } } },
  });
  if (!p) throw new GitOpsError("Product not found", "NOT_FOUND");
  requireAccess(ctx, action, {
    tenantId: p.domain.tenantId,
    domainId: p.domainId,
    productId: p.id,
  });
  return p;
}
export async function configuredApp() {
  const app = await prisma.gitProviderApp.findUnique({
    where: { id: "github" },
  });
  if (!app)
    throw new GitOpsError(
      "Configure the GitHub App in GitOps settings first",
      "APP_REQUIRED",
    );
  return app;
}
export async function saveApp(raw: unknown, ctx: ServiceContext) {
  if (!ctxCan(ctx, "git.manage"))
    throw new GitOpsError(
      "Platform administrator access required",
      "FORBIDDEN",
    );
  const data = AppSchema.parse(raw);
  const url = new URL(data.baseUrl);
  if (
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new GitOpsError("Use the GitHub host root as the App base URL");
  parseRepository(`${url.origin}/validation/validation`);
  const sealed = {
    appId: data.appId,
    privateKey: sealSecret(data.privateKey, "GitProviderApp.privateKey"),
    webhookSecret: sealSecret(
      data.webhookSecret,
      "GitProviderApp.webhookSecret",
    ),
    clientId: data.clientId,
    clientSecret: sealSecret(data.clientSecret, "GitProviderApp.clientSecret"),
    baseUrl: url.origin,
  };
  await prisma.gitProviderApp.upsert({
    where: { id: "github" },
    create: { id: "github", ...sealed },
    update: { ...sealed, revision: { increment: 1 } },
  });
  return { configured: true };
}
export async function installationProvider(
  binding: Pick<TenantGitBinding, "repositoryUrl" | "installationId">,
): Promise<GitHubProvider> {
  const app = await configuredApp();
  if (new URL(binding.repositoryUrl).origin !== app.baseUrl)
    throw new GitOpsError(
      "Repository host does not match the configured GitHub App",
    );
  return GitHubProvider.installation(
    binding.repositoryUrl,
    {
      appId: app.appId,
      privateKey: openSecret(app.privateKey, "GitProviderApp.privateKey"),
    },
    binding.installationId,
  );
}
export type ProviderFactory = (
  binding: TenantGitBinding,
  authorId?: string,
) => Promise<GitProvider>;
export const providerFor: ProviderFactory = async (binding, authorId) =>
  authorId ? userProvider(binding, authorId) : installationProvider(binding);
export async function userProvider(
  binding: Pick<TenantGitBinding, "repositoryUrl" | "installationId">,
  userId: string,
): Promise<GitHubProvider> {
  const app = await configuredApp();
  const link = await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "userId" FROM "git_user_links" WHERE "userId" = ${userId} FOR UPDATE`;
      const link = await tx.gitUserLink.findUnique({ where: { userId } });
      if (!link || link.appRevision !== app.revision)
        throw new GitOpsError(
          "Connect GitHub before submitting a source PR",
          "LINK_REQUIRED",
        );
      if (link.expiresAt && link.expiresAt.getTime() < Date.now() + 60000) {
        if (
          !link.refreshToken ||
          (link.refreshExpiresAt &&
            link.refreshExpiresAt.getTime() <= Date.now())
        )
          throw new GitOpsError(
            "Reconnect GitHub; the user token has expired",
            "LINK_REQUIRED",
          );
        const token = await exchangeToken(app, {
          grant_type: "refresh_token",
          refresh_token: openSecret(
            link.refreshToken,
            "GitUserLink.refreshToken",
          ),
        });
        return tx.gitUserLink.update({
          where: { userId },
          data: tokenData(token, app.revision),
        });
      }
      return link;
    },
    { timeout: 20000 },
  );
  const provider = new GitHubProvider(
    binding.repositoryUrl,
    openSecret(link.accessToken, "GitUserLink.accessToken"),
  );
  const actor = await provider.actor();
  if (String(actor.id) !== link.githubId)
    throw new GitOpsError(
      "The linked GitHub identity changed; reconnect",
      "LINK_REQUIRED",
    );
  return provider;
}
export async function rootBinding(tenantId: string) {
  return prisma.tenantGitBinding.findFirst({
    where: { tenantId, productId: null },
  });
}
export async function bindingFor(productId: string) {
  const settings = await prisma.productGitSettings.findUnique({
    where: { productId },
  });
  const product = await prisma.product.findUniqueOrThrow({
    where: { id: productId },
    include: { domain: true },
  });
  const binding = settings
    ? await prisma.tenantGitBinding.findUnique({
        where: { id: settings.bindingId },
      })
    : await rootBinding(product.domain.tenantId);
  if (!binding?.enabled || binding.tenantId !== product.domain.tenantId)
    throw new GitOpsError(
      "Configure an enabled Git binding for this tenant",
      "BINDING_REQUIRED",
    );
  return { binding, settings, product };
}
export async function ensureDefaultWorkflow(
  binding: TenantGitBinding,
  productId: string,
  userId: string,
  stages: ProductSettings["stages"],
) {
  const app = await configuredApp();
  const credentials = sealSecret(
    JSON.stringify({
      authType: "github-app",
      appId: app.appId,
      installationId: binding.installationId,
      privateKey: openSecret(app.privateKey, "GitProviderApp.privateKey"),
    }),
    "DeploymentConnection.credentials",
  );
  const name = `GitOps repository ${binding.id}`;
  const connection = await prisma.deploymentConnection.upsert({
    where: { tenantId_name: { tenantId: binding.tenantId, name } },
    create: {
      tenantId: binding.tenantId,
      name,
      method: "git",
      config: {
        url: binding.repositoryUrl,
        baseBranch: binding.branch,
        gitRoot: binding.basePath,
        supportsIdempotency: false,
      },
      credentials,
      createdBy: userId,
    },
    update: {
      config: {
        url: binding.repositoryUrl,
        baseBranch: binding.branch,
        gitRoot: binding.basePath,
        supportsIdempotency: false,
      },
      credentials,
      active: true,
      revision: { increment: 1 },
    },
  });
  await prisma.tenantGitBinding.update({
    where: { id: binding.id },
    data: { connectionId: connection.id },
  });
  const supportedTargets = getSchemaTargetCatalog()
    .filter((t) => t.enabledInSchemaTab)
    .map((t) => t.key);
  const workflow = await prisma.deploymentWorkflow.upsert({
    where: { productId_name: { productId, name: "GitOps · same repository" } },
    create: {
      tenantId: binding.tenantId,
      productId,
      connectionId: connection.id,
      name: "GitOps · same repository",
      format: supportedTargets[0],
      supportedTargets,
      environment: stages[0].name,
      settings: {},
      createdBy: userId,
    },
    update: {
      connectionId: connection.id,
      supportedTargets,
      environment: stages[0].name,
      active: true,
      revision: { increment: 1 },
    },
  });
  return workflow.id;
}
export async function saveBinding(
  tenantId: string,
  raw: unknown,
  ctx: ServiceContext,
  provider: ProviderFactory = providerFor,
) {
  requireAccess(ctx, "deploy.configure", { tenantId });
  const data = BindingSchema.parse(raw);
  parseRepository(data.repositoryUrl);
  const existing = await rootBinding(tenantId);
  if (
    existing &&
    (existing.repositoryUrl !== data.repositoryUrl ||
      existing.basePath !== data.basePath ||
      existing.branch !== data.branch) &&
    (await prisma.gitCanonicalDocument.count({
      where: { bindingId: existing.id },
    }))
  )
    throw new GitOpsError(
      "An indexed binding cannot be repointed; migrate the repository explicitly to preserve its source of truth",
    );
  const candidate = {
    ...data,
    id: existing?.id ?? "pending",
    tenantId,
    productId: null,
    createdBy: ctx.userId,
  } as TenantGitBinding;
  const remote = await provider(candidate);
  await remote.base(data.branch);
  if (remote instanceof GitHubProvider) await remote.verify();
  const binding = existing
    ? await prisma.tenantGitBinding.update({
        where: { id: existing.id },
        data: { ...data, revision: { increment: 1 } },
      })
    : await prisma.tenantGitBinding.create({
        data: { ...data, tenantId, createdBy: ctx.userId },
      });
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
  });
  const stages = tenant.deploymentEnvironments.map((name, i) => ({
    name,
    branch:
      i === 0 ? binding.branch : name.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
    path: "environments",
  }));
  for (const product of await prisma.product.findMany({
    where: { domain: { tenantId } },
  })) {
    const settings = await prisma.productGitSettings.findUnique({
      where: { productId: product.id },
    });
    if (settings && settings.bindingId !== binding.id) continue;
    const workflowId = await ensureDefaultWorkflow(
      binding,
      product.id,
      ctx.userId,
      stages,
    );
    await prisma.productGitSettings.upsert({
      where: { productId: product.id },
      create: {
        productId: product.id,
        tenantId,
        bindingId: binding.id,
        stages: json(stages),
        workflowId,
      },
      update: { workflowId },
    });
  }
  return binding;
}
export async function saveProductSettings(
  productId: string,
  raw: unknown,
  ctx: ServiceContext,
  provider: ProviderFactory = providerFor,
) {
  const product = await productFor(productId, ctx, "deploy.run"),
    data = ProductSettingsSchema.parse(raw),
    root = await rootBinding(product.domain.tenantId);
  if (!root) throw new GitOpsError("Configure the tenant Git binding first");
  if (
    data.stages.some(
      (s) => !product.domain.tenant.deploymentEnvironments.includes(s.name),
    )
  )
    throw new GitOpsError("Choose environments configured for this tenant");
  if (contentStorage() === "git") {
    const current = await bindingFor(productId);
    if (
      (data.repositoryUrl ?? root.repositoryUrl) !==
        current.binding.repositoryUrl ||
      (data.branch ?? root.branch) !== current.binding.branch ||
      (data.basePath ?? root.basePath) !== current.binding.basePath
    )
      throw new GitOpsError(
        "Changing an indexed source binding requires an explicit repository migration",
      );
    if (data.stages[0].branch !== current.binding.branch)
      throw new GitOpsError(
        "The first environment must use the canonical source branch",
      );
    const remote = await provider(current.binding);
    for (const stage of data.stages) await remote.base(stage.branch);
    const canonical = await prisma.gitCanonicalDocument.findFirst({
      where: {
        bindingId: current.binding.id,
        kind: "Product",
        objectId: productId,
      },
    });
    if (!canonical)
      throw new GitOpsError(
        "Merge the product bootstrap before changing Git-owned configuration",
      );
    const document = validateDocument(canonical.document);
    document.owners = data.owners;
    document.configuration = json(data) as never;
    const { GitContentStore } = await import("./content-store");
    return new GitContentStore(provider).saveDraft(
      { productId, document },
      undefined,
      ctx,
    );
  }
  const override = [
    data.repositoryUrl,
    data.installationId,
    data.branch,
    data.basePath,
  ].some((v) => v !== undefined);
  let binding = root;
  if (override) {
    const repositoryUrl = data.repositoryUrl ?? root.repositoryUrl;
    parseRepository(repositoryUrl);
    const config = {
      repositoryUrl,
      installationId: data.installationId ?? root.installationId,
      branch: data.branch ?? root.branch,
      basePath: data.basePath ?? root.basePath,
    };
    const prior = await prisma.tenantGitBinding.findUnique({
      where: { productId },
    });
    if (
      prior?.indexedSha &&
      (prior.repositoryUrl !== config.repositoryUrl ||
        prior.branch !== config.branch ||
        prior.basePath !== config.basePath)
    )
      throw new GitOpsError("An indexed product binding cannot be repointed");
    binding = await prisma.tenantGitBinding.upsert({
      where: { productId },
      create: {
        ...config,
        productId,
        tenantId: root.tenantId,
        createdBy: ctx.userId,
      },
      update: { ...config, enabled: true, revision: { increment: 1 } },
    });
  }
  if (data.stages[0].branch !== binding.branch)
    throw new GitOpsError(
      "The first environment must use the canonical source branch",
    );
  const remote = await provider(binding);
  for (const stage of data.stages) await remote.base(stage.branch);
  for (const target of data.targets) parseRepository(target.repositoryUrl);
  const workflowId = await ensureDefaultWorkflow(
    binding,
    productId,
    ctx.userId,
    data.stages,
  );
  return prisma.productGitSettings.upsert({
    where: { productId },
    create: {
      productId,
      tenantId: root.tenantId,
      bindingId: binding.id,
      ...data,
      stages: json(data.stages),
      targets: json(data.targets),
      workflowId,
    },
    update: {
      ...data,
      bindingId: binding.id,
      stages: json(data.stages),
      targets: json(data.targets),
      workflowId,
      revision: { increment: 1 },
    },
  });
}
interface OAuthToken {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  token_type?: string;
}
async function exchangeToken(
  app: Awaited<ReturnType<typeof configuredApp>>,
  input: Record<string, string>,
): Promise<OAuthToken> {
  const token = await externalJson<OAuthToken>(
    `${app.baseUrl}/login/oauth/access_token`,
    "POST",
    { "User-Agent": "SuperSchema-GitOps" },
    {
      client_id: app.clientId,
      client_secret: openSecret(
        app.clientSecret,
        "GitProviderApp.clientSecret",
      ),
      ...input,
    },
  );
  if (!token?.access_token)
    throw new GitOpsError(
      "GitHub authorization failed; reconnect your account",
      "LINK_REQUIRED",
    );
  return token;
}
function tokenData(token: OAuthToken, appRevision: number) {
  return {
    accessToken: sealSecret(token.access_token, "GitUserLink.accessToken"),
    refreshToken: token.refresh_token
      ? sealSecret(token.refresh_token, "GitUserLink.refreshToken")
      : null,
    expiresAt: token.expires_in
      ? new Date(Date.now() + token.expires_in * 1000)
      : null,
    refreshExpiresAt: token.refresh_token_expires_in
      ? new Date(Date.now() + token.refresh_token_expires_in * 1000)
      : null,
    appRevision,
  };
}
export function callbackUrl(): string {
  const base = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL;
  if (!base) throw new GitOpsError("Set AUTH_URL before connecting GitHub");
  return new URL("/api/gitops/callback", base).href;
}
export async function beginGitHubLink(userId: string): Promise<string> {
  const app = await configuredApp(),
    state = randomBytes(32).toString("base64url"),
    verifier = randomBytes(48).toString("base64url");
  await prisma.gitOpsOAuthState.create({
    data: {
      hash: createHash("sha256").update(state).digest("hex"),
      userId,
      verifier: sealSecret(verifier, "GitOpsOAuthState.verifier"),
      expiresAt: new Date(Date.now() + 10 * 60000),
    },
  });
  const u = new URL("/login/oauth/authorize", app.baseUrl);
  u.search = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: callbackUrl(),
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return u.href;
}
export async function finishGitHubLink(
  userId: string,
  state: string,
  code: string,
): Promise<void> {
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(state) || !code || code.length > 1000)
    throw new GitOpsError("Invalid OAuth callback");
  const hash = createHash("sha256").update(state).digest("hex"),
    app = await configuredApp();
  const saved = await prisma.$transaction(async (tx) => {
    const s = await tx.gitOpsOAuthState.findUnique({ where: { hash } });
    if (!s || s.userId !== userId || s.expiresAt.getTime() < Date.now())
      throw new GitOpsError(
        "GitHub authorization state expired or does not match this user",
      );
    if (
      (await tx.gitOpsOAuthState.deleteMany({ where: { hash, userId } }))
        .count !== 1
    )
      throw new GitOpsError("GitHub authorization state was already used");
    return s;
  });
  const token = await exchangeToken(app, {
    code,
    redirect_uri: callbackUrl(),
    code_verifier: openSecret(saved.verifier, "GitOpsOAuthState.verifier"),
  });
  const api =
    app.baseUrl === "https://github.com"
      ? "https://api.github.com"
      : `${app.baseUrl}/api/v3`;
  const actor = await externalJson<{ id: number; login: string; type: string }>(
    `${api}/user`,
    "GET",
    {
      Authorization: `Bearer ${token.access_token}`,
      "User-Agent": "SuperSchema-GitOps",
    },
  );
  if (!actor || actor.type !== "User")
    throw new GitOpsError("Link a human GitHub account");
  await prisma.gitUserLink.upsert({
    where: { userId },
    create: {
      userId,
      githubId: String(actor.id),
      login: actor.login,
      ...tokenData(token, app.revision),
    },
    update: {
      githubId: String(actor.id),
      login: actor.login,
      ...tokenData(token, app.revision),
    },
  });
}
