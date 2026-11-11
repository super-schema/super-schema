import type { getGitOpsWorkspace } from "@/services/gitops/workspace";
export function workspaceFixture(
  viewer = false,
  wholeRepo = false,
): Awaited<ReturnType<typeof getGitOpsWorkspace>> {
  const root = wholeRepo ? "" : "contracts/catalog",
    path = [
      root,
      "domains/identity/products/accounts/entities/account/1.0.0_snapshot/entity.yaml",
    ]
      .filter(Boolean)
      .join("/");
  const document = {
    apiVersion: "superschema.io/v1",
    kind: "Entity",
    id: "account",
    scope: {
      tenantId: "tenant",
      tenantSlug: "onepay",
      domainId: "domain",
      domainSlug: "identity",
      productId: "product",
      productSlug: "accounts",
    },
    stage: "SNAPSHOT",
    version: "1.0.0_snapshot",
    owners: [],
    references: [],
    spec: {
      record: {
        id: "account",
        name: "Account",
        slug: "account",
        description: "Account contract",
      },
      children: { fields: [] },
    },
  };
  const binding = {
    id: "binding",
    tenantId: "tenant",
    productId: null,
    repositoryUrl: "https://github.com/OnePayPal/event-schema-central",
    installationId: "123",
    branch: "development",
    basePath: root,
    indexedSha: "a".repeat(40),
    lastSyncStatus: "SYNCED",
    lastSyncAt: new Date("2026-11-10T20:00:00Z"),
    lastError: null,
  };
  return {
    mode: "git",
    tenant: {
      id: "tenant",
      name: "OnePay",
      slug: "onepay",
      environments: ["development", "staging", "qa", "production"],
    },
    userId: "author",
    selectedProductId: "product",
    products: [
      {
        id: "product",
        name: "Accounts",
        slug: "accounts",
        domainId: "domain",
        domainSlug: "identity",
      },
    ],
    settings: {
      productId: "product",
      bindingId: "binding",
      revision: 1,
      sourceSha: binding.indexedSha,
      owners: ["@organization/schema-team"],
      stages: ["development", "staging", "qa", "production"].map((name) => ({
        name,
        branch: name,
        path: "environments",
      })),
      targets: [],
    },
    binding,
    tenantBinding: binding,
    documents: [
      {
        id: "canonical",
        kind: "Entity",
        objectId: "account",
        productId: "product",
        version: "1.0.0_snapshot",
        stage: "SNAPSHOT",
        path,
        commitSha: binding.indexedSha,
        document,
      },
    ],
    errors: [],
    deliveries: [
      {
        id: "delivery",
        kind: "ARTIFACT",
        target: "json-schema",
        sourceSha: binding.indexedSha,
        state: "IN_REVIEW",
        prNumber: 6,
        prUrl: "https://github.com/OnePayPal/event-schema-central/pull/6",
      },
    ],
    link: { login: "schema-author" },
    app: { id: "github" },
    jobs: [],
    changeSets: viewer
      ? []
      : [
          {
            id: "cs",
            kind: "EDIT",
            authorId: "author",
            title: "Add account metadata",
            description: "",
            state: "IN_REVIEW",
            prNumber: 5,
            prUrl: "https://github.com/OnePayPal/event-schema-central/pull/5",
            headSha: "b".repeat(40),
            revision: 1,
            items: [
              {
                id: "item",
                objectKind: "Entity",
                objectId: "account",
                objectKey: "Entity:account:1.0.0_snapshot",
                path,
                document,
                outOfDate: false,
                conflicts: [],
              },
            ],
          },
        ],
    canConfigure: !viewer,
    canManageApp: !viewer,
    canEdit: !viewer,
    canRun: !viewer,
  } as unknown as Awaited<ReturnType<typeof getGitOpsWorkspace>>;
}
