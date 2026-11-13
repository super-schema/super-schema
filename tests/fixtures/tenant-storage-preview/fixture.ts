import type { getTenantStorageSettings } from "@/services/tenant-storage.service";
export type StorageSnapshot = Awaited<
  ReturnType<typeof getTenantStorageSettings>
>;
export function storageFixture(
  mode: "database" | "git" = "database",
): StorageSnapshot {
  const stages = ["development", "staging", "qa", "production"].map((name) => ({
    name,
    branch: `gitops/${name}`,
    path: "environments",
  }));
  return {
    tenant: {
      id: "tenant",
      name: "Platform schemas",
      slug: "platform-schemas",
      description: "Shared schema catalog",
      mode,
      revision: 1,
    },
    database: "PostgreSQL",
    app: {
      appId: "123",
      clientId: "fixture-client",
      baseUrl: "https://github.com",
    },
    github: { login: "schema-author", connected: true },
    canCreateTenant: true,
    canManageApp: true,
    canReturnToDatabase: mode === "database",
    binding: {
      id: "binding",
      repositoryUrl: "https://github.com/example/schema-catalog",
      installationId: "456",
      branch: stages[0].branch,
      basePath: "contracts/platform",
      enabled: true,
      indexedSha: mode === "git" ? "a".repeat(40) : null,
      lastSyncStatus: mode === "git" ? "SYNCED" : "NEVER",
      lastError: null,
    },
    profile: {
      binding: {
        repositoryUrl: "https://github.com/example/schema-catalog",
        installationId: "456",
        branch: stages[0].branch,
        basePath: "contracts/platform",
        enabled: true,
      },
      owners: ["@example/schema-reviewers"],
      stages,
    },
    defaults: { stages, branch: stages[0].branch, basePath: "superschema" },
    products: [
      {
        id: "product",
        name: "Contracts",
        slug: "contracts",
        domainSlug: "platform",
      },
    ],
    state: mode === "git" ? "ready" : "database",
    initialPrs:
      mode === "git"
        ? [
            {
              id: "pr",
              productId: "product",
              productName: "Contracts",
              prUrl: "https://github.com/example/schema-catalog/pull/7",
              prNumber: 7,
              state: "MERGED",
            },
          ]
        : [],
  };
}
