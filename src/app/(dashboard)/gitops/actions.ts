"use server";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { guardActiveTenant, contextOf } from "@/lib/action-context";
import { GitOpsError } from "@/lib/gitops/contracts";
import { SecretBoxError } from "@/lib/crypto/secret-box";
import { prisma } from "@/lib/db";
import { GitContentStore } from "@/services/gitops/content-store";
import { getGitOpsWorkspace } from "@/services/gitops/workspace";
import {
  saveApp,
  saveBinding,
  saveProductSettings,
  bindingFor,
  productFor,
  requireAccess,
} from "@/services/gitops/settings";
import { enqueueJob } from "@/services/gitops/sync";
import { promoteEnvironment, retryGitOpsJob } from "@/services/gitops/delivery";
import type { ServiceContext } from "@/types/service-context";
async function call<T>(
  run: (tenantId: string, ctx: ServiceContext) => Promise<T>,
) {
  try {
    const access = await guardActiveTenant("tenant.access", {
      label: "Tenant",
    });
    if (!access.allowed) return { error: access.refusal.error };
    const tenantId = access.resource.tenantId!,
      ctx = { ...contextOf(access.principal), tenantId };
    const data = await run(tenantId, ctx);
    revalidatePath("/admin/workflows/gitops");
    return { data };
  } catch (e) {
    if (e instanceof GitOpsError || e instanceof SecretBoxError)
      return { error: e.message };
    if (e instanceof ZodError)
      return { error: e.issues[0]?.message ?? "Invalid input" };
    return {
      error:
        "GitOps operation failed. Check the configuration, database migration and connection, then retry.",
    };
  }
}
export async function gitOpsWorkspaceAction(productId?: string) {
  return call((id, ctx) => getGitOpsWorkspace(id, productId, ctx));
}
export async function saveGitOpsAppAction(input: unknown) {
  return call((_id, ctx) => saveApp(input, ctx));
}
export async function saveGitOpsBindingAction(input: unknown) {
  return call((id, ctx) => saveBinding(id, input, ctx));
}
export async function saveGitOpsProductAction(
  productId: string,
  input: unknown,
) {
  return call((_id, ctx) => saveProductSettings(productId, input, ctx));
}
export async function bootstrapGitOpsAction(productId: string) {
  return call((_id, ctx) => new GitContentStore().bootstrap(productId, ctx));
}
export async function saveGitOpsDraftAction(input: unknown, revision?: number) {
  return call(async (_id, ctx) => {
    const store = new GitContentStore(),
      cs = await store.saveDraft(input, revision, ctx);
    return cs.prNumber
      ? store.submit(cs.id, cs.title, cs.description, ctx)
      : cs;
  });
}
export async function submitGitOpsAction(
  id: string,
  title: string,
  description: string,
) {
  return call((_tid, ctx) =>
    new GitContentStore().submit(id, title, description, ctx),
  );
}
export async function refreshGitOpsDraftAction(id: string) {
  return call((_tid, ctx) => new GitContentStore().refresh(id, ctx));
}
export async function discardGitOpsAction(id: string) {
  return call((_tid, ctx) => new GitContentStore().discard(id, ctx));
}
export async function promoteGitOpsAction(productId: string, key: string) {
  return call((_tid, ctx) =>
    new GitContentStore().promote(productId, key, ctx),
  );
}
export async function promoteGitOpsEnvironmentAction(
  productId: string,
  environment: string,
) {
  return call((_tid, ctx) => promoteEnvironment(productId, environment, ctx));
}
export async function syncGitOpsAction(productId: string) {
  return call(async (_tid, ctx) => {
    await productFor(productId, ctx, "entity.write");
    const { binding } = await bindingFor(productId);
    return enqueueJob(binding.id, "SYNC", `manual:${crypto.randomUUID()}`);
  });
}
export async function retryGitOpsJobAction(id: string) {
  return call((_tid, ctx) => retryGitOpsJob(id, ctx));
}
export async function unlinkGitHubAction() {
  return call(async (_tid, ctx) => {
    await prisma.gitUserLink.deleteMany({ where: { userId: ctx.userId } });
    return { unlinked: true };
  });
}

export async function rebuildGitOpsAction(productId: string) {
  return call(async (_tid, ctx) => {
    const p = await productFor(productId, ctx);
    requireAccess(ctx, "deploy.configure", { tenantId: p.domain.tenantId });
    const { binding } = await bindingFor(productId);
    return enqueueJob(binding.id, "SYNC", `rebuild:${crypto.randomUUID()}`, {
      force: true,
    });
  });
}
