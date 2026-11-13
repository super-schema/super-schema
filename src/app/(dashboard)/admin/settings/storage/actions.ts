"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { guardActiveTenant, contextOf } from "@/lib/action-context";
import { ACTIVE_TENANT_COOKIE } from "@/lib/active-tenant";
import { GitOpsError } from "@/lib/gitops/contracts";
import { SecretBoxError } from "@/lib/crypto/secret-box";
import {
  getTenantStorageSettings,
  onboardTenant,
  saveTenantGitProfile,
  setTenantContentStorage,
  startTenantBootstrap,
  syncTenantStorage,
} from "@/services/tenant-storage.service";
import { saveApp } from "@/services/gitops/settings";
import type { ServiceContext } from "@/types/service-context";

async function call<T>(
  run: (tenantId: string, ctx: ServiceContext) => Promise<T>,
) {
  try {
    const access = await guardActiveTenant("tenant.access", {
      label: "Tenant",
    });
    if (!access.allowed) return { error: access.refusal.error };
    const id = access.resource.tenantId!,
      ctx = { ...contextOf(access.principal), tenantId: id };
    const data = await run(id, ctx);
    revalidatePath("/admin/settings/storage");
    revalidatePath("/admin/workflows/gitops");
    revalidatePath("/", "layout");
    return { data };
  } catch (e) {
    if (e instanceof GitOpsError || e instanceof SecretBoxError)
      return { error: e.message };
    if (e instanceof ZodError)
      return { error: e.issues[0]?.message ?? "Check the storage settings" };
    if (e && typeof e === "object" && "code" in e && e.code === "P2002")
      return {
        error: "This name or URL is already in use. Choose another name.",
      };
    return {
      error:
        "Storage setup failed. Check the database migration, repository access and GitHub App, then retry.",
    };
  }
}
export async function tenantStorageSettingsAction() {
  return call((id, ctx) => getTenantStorageSettings(id, ctx));
}
export async function saveTenantStorageProfileAction(input: unknown) {
  return call((id, ctx) => saveTenantGitProfile(id, input, ctx));
}
export async function setTenantStorageAction(mode: unknown, revision: number) {
  return call((id, ctx) => setTenantContentStorage(id, mode, revision, ctx));
}
export async function createTenantStorageAction(input: unknown) {
  return call(async (_id, ctx) => {
    const result = await onboardTenant(input, ctx);
    (await cookies()).set(ACTIVE_TENANT_COOKIE, result.tenantId, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
    return result;
  });
}
export async function saveTenantStorageAppAction(input: unknown) {
  return call((_id, ctx) => saveApp(input, ctx));
}
export async function bootstrapTenantStorageAction() {
  return call((id, ctx) => startTenantBootstrap(id, ctx));
}
export async function syncTenantStorageAction() {
  return call((id, ctx) => syncTenantStorage(id, ctx));
}
