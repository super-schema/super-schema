import { storageFixture } from "./fixture";
import type { TenantGitProfile } from "@/lib/gitops/tenant-storage-contracts";
let current = storageFixture(
  new URLSearchParams(location.search).has("git") ? "git" : "database",
);
export const tenantStorageSettingsAction = async () => ({ data: current });
export const saveTenantStorageProfileAction = async (
  input: TenantGitProfile,
) => {
  current = {
    ...current,
    profile: input,
    binding: { ...current.binding!, ...input.binding },
  };
  return { data: true };
};
export const setTenantStorageAction = async (mode: "database" | "git") => {
  current = {
    ...current,
    tenant: { ...current.tenant, mode, revision: current.tenant.revision + 1 },
    state: mode === "git" ? "bootstrap_required" : "database",
  };
  return { data: true };
};
export const createTenantStorageAction = async (input: {
  name: string;
  storage: "database" | "git";
  git?: TenantGitProfile;
}) => {
  current = storageFixture(input.storage);
  current.tenant = { ...current.tenant, id: "new-tenant", name: input.name };
  if (input.git) current.profile = input.git;
  return { data: { tenantId: "new-tenant" } };
};
export const saveTenantStorageAppAction = async () => ({ data: true });
export const bootstrapTenantStorageAction = async () => ({ data: true });
export const syncTenantStorageAction = async () => ({ data: true });
