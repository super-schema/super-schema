import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { contentStorage } from "./mode";
import { GitOpsError } from "./contracts";

export type TenantContentStorage = "database" | "git";
type Reader = Pick<Prisma.TransactionClient, "tenant">;

export function resolveTenantStorage(value: unknown): TenantContentStorage {
  if (value === undefined || value === null) return contentStorage();
  if (value !== "database" && value !== "git")
    throw new GitOpsError(
      "Invalid tenant storage configuration",
      "CONFIGURATION_ERROR",
    );
  return value;
}
export async function tenantContentStorage(
  db: Reader,
  tenantId: string,
): Promise<TenantContentStorage> {
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { contentStorage: true },
  });
  return resolveTenantStorage(tenant?.contentStorage);
}

/** One-time compatibility initialization; new tenants always receive an explicit backend. */
export async function initializeLegacyTenantStorage(
  db: Pick<PrismaClient, "tenant">,
): Promise<void> {
  await db.tenant.updateMany({
    where: { contentStorage: null },
    data: { contentStorage: contentStorage() },
  });
}

export function isTenantGitWriteError(error: unknown): boolean {
  if (String(error).includes("GITOPS_AUTHORING_REQUIRED")) return true;
  try {
    return JSON.stringify(
      error && typeof error === "object" ? error : null,
    ).includes("GITOPS_AUTHORING_REQUIRED");
  } catch {
    return false;
  }
}
