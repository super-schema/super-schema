import { AsyncLocalStorage } from "node:async_hooks";
import { GitOpsError } from "./contracts";

const projection = new AsyncLocalStorage<boolean>();
export function contentStorage(
  env: Readonly<Record<string, string | undefined>> = process.env,
): "database" | "git" {
  const mode = env.CONTENT_STORAGE ?? "database";
  if (mode !== "database" && mode !== "git")
    throw new GitOpsError(
      "CONTENT_STORAGE must be database or git",
      "CONFIGURATION_ERROR",
    );
  return mode;
}
export function withProjectionWrites<T>(fn: () => Promise<T>): Promise<T> {
  return projection.run(true, fn);
}
export const CONTENT_MODELS = new Set([
  "Tenant",
  "Domain",
  "Product",
  "Entity",
  "Field",
  "EntityVersion",
  "EventSpec",
  "EventSpecVersion",
  "Trait",
  "SharedEnum",
  "CustomScalar",
  "UnionType",
  "ServiceDefinition",
  "Operation",
  "OperationParameter",
  "OperationResponse",
  "InterfaceDefinition",
  "ModelDefinition",
  "ModelFieldDefinition",
  "DecoratorDefinition",
  "SchemaReference",
]);
export function assertContentWrite(
  model: string,
  operation: string,
  args?: unknown,
  tenantMode: "database" | "git" = contentStorage(),
): void {
  if (
    tenantMode !== "git" ||
    projection.getStore() ||
    !/^(create|update|upsert|delete)/.test(operation)
  )
    return;
  const data = args as
    | { data?: Record<string, unknown>; update?: Record<string, unknown> }
    | undefined;
  const hierarchy = ["Tenant", "Domain", "Product"].includes(model);
  const provision =
    hierarchy &&
    (operation === "create" ||
      operation === "createMany" ||
      (operation === "upsert" && !Object.keys(data?.update ?? {}).length));
  const metadataOnly =
    model === "Tenant" &&
    operation.startsWith("update") &&
    Object.keys(data?.data ?? {}).every((key) =>
      [
        "deploymentEnvironments",
        "contentStorage",
        "storageRevision",
        "deploymentEnvironmentDetails",
        "deploymentTargetMethods",
        "updatedAt",
      ].includes(key),
    );
  function nested(current: string, value: unknown): boolean {
    if (Array.isArray(value)) return value.some((v) => nested(current, v));
    if (!value || typeof value !== "object") return false;
    return Object.entries(value).some(([key, v]) => {
      const target = RELATIONS[current]?.[key];
      if (target) {
        const keys = v && typeof v === "object" ? Object.keys(v) : [];
        const mutating = keys.some((k) =>
          [
            "create",
            "createMany",
            "update",
            "updateMany",
            "upsert",
            "delete",
            "deleteMany",
            "connectOrCreate",
          ].includes(k),
        );
        const reparenting =
          INVERSE[current]?.includes(key) &&
          keys.some((k) => ["connect", "disconnect", "set"].includes(k));
        return (
          (CONTENT_MODELS.has(target) && (mutating || reparenting)) ||
          nested(target, v)
        );
      }
      return (
        [
          "data",
          "create",
          "update",
          "upsert",
          "createMany",
          "updateMany",
          "connectOrCreate",
        ].includes(key) && nested(current, v)
      );
    });
  }
  if (
    (CONTENT_MODELS.has(model) && !provision && !metadataOnly) ||
    nested(model, args)
  ) {
    throw new GitOpsError(
      "Git is the content source of truth. Open GitOps authoring to save a private draft and submit a pull request.",
      "GITOPS_AUTHORING_REQUIRED",
    );
  }
}

// Generated from the Prisma relation surface; JSON scalar properties are never interpreted as nested writes.
const RELATIONS: Record<string, Record<string, string>> = {
  User: {
    accounts: "Account",
    sessions: "Session",
    entities: "Entity",
    auditLogs: "AuditLog",
    gitConfigs: "GitConfig",
    roles: "UserRole",
    notifications: "Notification",
    webhooks: "WebhookEndpoint",
    publishedEntityVersions: "EntityVersion",
    publishedEventSpecVersions: "EventSpecVersion",
    releasedEntityVersions: "EntityVersion",
    releasedEventSpecVersions: "EventSpecVersion",
    grantedRoles: "UserRole",
    invitationsCreated: "Invitation",
    authTokens: "AuthToken",
  },
  Account: { user: "User" },
  Session: { user: "User" },
  Tenant: {
    domains: "Domain",
    userRoles: "UserRole",
    entities: "Entity",
    sharedEnums: "SharedEnum",
    customScalars: "CustomScalar",
    unionTypes: "UnionType",
    services: "ServiceDefinition",
    traits: "Trait",
    eventSpecs: "EventSpec",
    webhookEndpoints: "WebhookEndpoint",
    deploymentConnections: "DeploymentConnection",
    deploymentWorkflows: "DeploymentWorkflow",
    deploymentRuns: "DeploymentRun",
  },
  Domain: {
    tenant: "Tenant",
    products: "Product",
    entities: "Entity",
    modelDefinitions: "ModelDefinition",
    decoratorDefinitions: "DecoratorDefinition",
    userRoles: "UserRole",
    sharedEnums: "SharedEnum",
    customScalars: "CustomScalar",
    unionTypes: "UnionType",
    services: "ServiceDefinition",
    interfaces: "InterfaceDefinition",
    traits: "Trait",
    eventSpecs: "EventSpec",
  },
  ProductTier: { products: "Product" },
  Product: {
    domain: "Domain",
    tier: "ProductTier",
    entities: "Entity",
    deploymentWorkflows: "DeploymentWorkflow",
    userRoles: "UserRole",
    sharedEnums: "SharedEnum",
    customScalars: "CustomScalar",
    unionTypes: "UnionType",
    services: "ServiceDefinition",
    traits: "Trait",
    eventSpecs: "EventSpec",
  },
  Entity: {
    fields: "Field",
    services: "ServiceDefinition",
    pullRequests: "GitPullRequest",
    deploymentWorkflows: "DeploymentWorkflow",
    deploymentRuns: "DeploymentRun",
    tenant: "Tenant",
    domain: "Domain",
    product: "Product",
    owner: "User",
    parentEntity: "Entity",
    childEntities: "Entity",
    versions: "EntityVersion",
    latestVersion: "EntityVersion",
    traitHeaderPins: "Trait",
  },
  ModelDefinition: { fields: "ModelFieldDefinition", domain: "Domain" },
  ModelFieldDefinition: { model: "ModelDefinition" },
  DecoratorDefinition: { domain: "Domain" },
  Field: { entity: "Entity", conceptLinks: "FieldConceptLink" },
  EntityVersion: {
    entity: "Entity",
    publishedBy: "User",
    releasedBy: "User",
    latestOf: "Entity",
    traitHeaderPins: "Trait",
  },
  Trait: {
    tenant: "Tenant",
    domain: "Domain",
    product: "Product",
    headersEntity: "Entity",
    headersEntityVersion: "EntityVersion",
  },
  EventSpec: {
    tenant: "Tenant",
    domain: "Domain",
    product: "Product",
    versions: "EventSpecVersion",
    latestVersion: "EventSpecVersion",
  },
  EventSpecVersion: {
    eventSpec: "EventSpec",
    latestOf: "EventSpec",
    publishedBy: "User",
    releasedBy: "User",
  },
  BusinessConcept: { fieldLinks: "FieldConceptLink" },
  FieldConceptLink: { field: "Field", concept: "BusinessConcept" },
  AuditLog: { user: "User" },
  GitConfig: { creator: "User" },
  GitPullRequest: { entity: "Entity" },
  UserRole: {
    user: "User",
    tenant: "Tenant",
    domain: "Domain",
    product: "Product",
    grantedBy: "User",
  },
  Invitation: { createdBy: "User", roles: "InvitationRole" },
  InvitationRole: { invitation: "Invitation" },
  AuthToken: { user: "User" },
  Notification: { user: "User" },
  WebhookEndpoint: {
    deliveries: "WebhookDelivery",
    creator: "User",
    tenant: "Tenant",
  },
  WebhookDelivery: { endpoint: "WebhookEndpoint" },
  GovernanceRequest: { approvals: "GovernanceApproval" },
  GovernanceApproval: { request: "GovernanceRequest" },
  DeploymentConnection: {
    tenant: "Tenant",
    workflows: "DeploymentWorkflow",
    runs: "DeploymentRun",
  },
  DeploymentWorkflow: {
    tenant: "Tenant",
    entity: "Entity",
    product: "Product",
    connection: "DeploymentConnection",
    runs: "DeploymentRun",
  },
  DeploymentRun: {
    tenant: "Tenant",
    entity: "Entity",
    workflow: "DeploymentWorkflow",
    connection: "DeploymentConnection",
    attempts: "DeploymentAttempt",
  },
  DeploymentAttempt: { run: "DeploymentRun" },
  SharedEnum: { tenant: "Tenant", domain: "Domain", product: "Product" },
  CustomScalar: { tenant: "Tenant", domain: "Domain", product: "Product" },
  UnionType: { tenant: "Tenant", domain: "Domain", product: "Product" },
  ServiceDefinition: {
    tenant: "Tenant",
    domain: "Domain",
    product: "Product",
    entity: "Entity",
    operations: "Operation",
  },
  Operation: {
    service: "ServiceDefinition",
    parameters: "OperationParameter",
    responses: "OperationResponse",
  },
  OperationParameter: { operation: "Operation" },
  OperationResponse: { operation: "Operation" },
  InterfaceDefinition: { domain: "Domain" },
};

const INVERSE: Record<string, string[]> = {
  User: [
    "entities",
    "publishedEntityVersions",
    "publishedEventSpecVersions",
    "releasedEntityVersions",
    "releasedEventSpecVersions",
  ],
  Tenant: [
    "domains",
    "entities",
    "sharedEnums",
    "customScalars",
    "unionTypes",
    "services",
    "traits",
    "eventSpecs",
  ],
  Domain: [
    "products",
    "entities",
    "modelDefinitions",
    "decoratorDefinitions",
    "sharedEnums",
    "customScalars",
    "unionTypes",
    "services",
    "interfaces",
    "traits",
    "eventSpecs",
  ],
  ProductTier: ["products"],
  Product: [
    "entities",
    "sharedEnums",
    "customScalars",
    "unionTypes",
    "services",
    "traits",
    "eventSpecs",
  ],
  Entity: [
    "fields",
    "services",
    "childEntities",
    "versions",
    "traitHeaderPins",
  ],
  ModelDefinition: ["fields"],
  EntityVersion: ["latestOf", "traitHeaderPins"],
  EventSpec: ["versions"],
  EventSpecVersion: ["latestOf"],
  ServiceDefinition: ["operations"],
  Operation: ["parameters", "responses"],
};
