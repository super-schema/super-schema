import { z } from "zod";
import type { TargetMethodMappings } from "./target-methods";

export const METHODS = ["git", "http", "registry"] as const;
export type DeploymentMethod = typeof METHODS[number];
const identifier = z.string().min(1).max(128);
export const segment = z.string().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use a lowercase kebab-case identifier");
export const contractVersion = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:_snapshot)?$/, "Use a semantic version, such as 1.0.0_snapshot");

export const CredentialsSchema = z.object({
  authType: z.enum(["none", "bearer", "basic", "github-app"]).default("none"),
  token: z.string().max(16000).optional(),
  username: z.string().max(500).optional(),
  password: z.string().max(16000).optional(),
  appId: z.string().max(128).optional(),
  installationId: z.string().max(128).optional(),
  privateKey: z.string().max(32000).optional(),
  signingSecret: z.string().max(16000).optional(),
}).strict().superRefine((c, ctx) => {
  if (c.authType === "bearer" && !c.token) ctx.addIssue({ code: "custom", message: "A bearer token is required" });
  if (c.authType === "basic" && (!c.username || !c.password)) ctx.addIssue({ code: "custom", message: "A username and password are required" });
  if (c.authType === "github-app" && (!c.appId || !c.installationId || !c.privateKey)) ctx.addIssue({ code: "custom", message: "App ID, installation ID and private key are required" });
});
export type Credentials = z.infer<typeof CredentialsSchema>;

export const ConnectionConfigSchema = z.object({
  url: z.string().url().max(2000),
  baseBranch: z.string().min(1).max(200).default("main"),
  supportsIdempotency: z.boolean().default(false),
}).strict();
export type ConnectionConfig = z.infer<typeof ConnectionConfigSchema>;
export const SaveConnectionSchema = z.object({
  id: identifier.optional(),
  name: z.string().trim().min(1).max(100),
  method: z.enum(METHODS),
  config: ConnectionConfigSchema,
  credentials: CredentialsSchema.optional(),
  active: z.boolean().default(true),
}).strict();
export type SaveConnection = z.input<typeof SaveConnectionSchema>;

export const WorkflowSettingsSchema = z.object({
  contractVersion: contractVersion.default("1.0.0_snapshot"),
  // Packaging is optional; hierarchy is always schemas/tenant/domain/product/schema/version.
  eventContract: z.boolean().default(false),
  contractKind: z.enum(["Topic", "Entity"]).default("Topic"),
  change: z.enum(["create", "new-version", "update-snapshot"]).default("create"),
  expectedPayloadHash: z.string().max(100).optional(),
  metadata: z.string().max(100000).default("{}"),
  example: z.string().max(100000).default(""),
  topicConfig: z.string().max(100000).default(""),
  subject: z.string().max(250).default(""),
  referenceSubjects: z.record(z.string(), z.string().min(1).max(250)).default({}),
  title: z.string().max(250).default(""),
}).strict();
export type WorkflowSettings = z.infer<typeof WorkflowSettingsSchema>;
export const SaveWorkflowSchema = z.object({
  id: identifier.optional(), name: z.string().trim().min(1).max(100), connectionId: identifier,
  format: z.string().min(1).max(100).optional(),
  supportedTargets: z.array(z.string().min(1).max(100)).min(1).max(100).refine((targets) => new Set(targets).size === targets.length, "Supported targets must be unique").optional(),
  environment: z.string().trim().min(1).max(100),
  settings: WorkflowSettingsSchema, active: z.boolean().default(true),
}).strict().superRefine((input, ctx) => {
  if (!input.supportedTargets?.length && !input.format) ctx.addIssue({ code: "custom", message: "Select at least one supported target" });
  if (input.format && input.supportedTargets && !input.supportedTargets.includes(input.format)) ctx.addIssue({ code: "custom", message: "The primary target must be included in supported targets" });
}).transform((input) => {
  const supportedTargets = input.supportedTargets ?? [input.format!];
  return { ...input, format: input.format ?? supportedTargets[0], supportedTargets };
});
export type SaveWorkflow = z.input<typeof SaveWorkflowSchema>;
export const EnvironmentListSchema = z.array(z.string().trim().min(1).max(100)).min(1).max(50)
  .refine((names) => new Set(names).size === names.length, "Environment names must be unique");
// Only deployment variables may override a centrally defined workflow.
export const WorkflowVariablesSchema = WorkflowSettingsSchema.pick({ contractVersion: true, title: true, metadata: true, example: true, topicConfig: true, subject: true, referenceSubjects: true, expectedPayloadHash: true }).partial();
export const PreviewSchema = z.object({ workflowId: identifier, format: z.string().min(1).max(100).optional(), version: z.number().int().positive(), idempotencyKey: z.string().uuid(), environment: z.string().min(1).max(100).optional(), connectionId: identifier.optional(), variables: WorkflowVariablesSchema.optional() }).strict();
export const ExecuteSchema = z.object({ runId: identifier, planHash: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict();

export interface ArtifactFile { path: string; content: string; entityId?: string; }
export interface ArtifactBundle {
  entity: { id: string; name: string; tenant: string; domain: string; product: string; schema: string };
  format: string; version: number; sourceEntityVersion: number; generatedAt: string;
  files: ArtifactFile[]; primaryFile: string; contentHash: string;
  referenceEntityIds: string[];
}
export interface DeliveryReceipt {
  outcome: "pr-opened" | "delivered" | "accepted" | "registered";
  url?: string; commitSha?: string; prNumber?: number; branch?: string; state?: string;
  httpStatus?: number; correlationId?: string;
  registrations?: { path: string; subject: string; id: number; version: number }[];
}
export interface PreparedPlan {
  bundle: ArtifactBundle; settings: WorkflowSettings; workflowRevision: number;
  connectionConfig: ConnectionConfig; environment: string;
  baseSha?: string; branch?: string; files?: ArtifactFile[];
  fileChanges?: { path: string; status: "added" | "modified" | "unchanged"; before?: string }[];
  validation: string[];
  requestHash?: string;
}
export interface ConnectionView {
  id: string; name: string; method: DeploymentMethod; config: ConnectionConfig; revision: number; active: boolean;
}
export interface WorkflowView {
  id: string; name: string; format: string; supportedTargets?: string[]; environment: string; connectionId: string;
  settings: WorkflowSettings; revision: number; active: boolean;
  scope?: "product" | "schema";
}
/** Empty arrays on legacy callers are normalized to the original single target. */
export function workflowTargets(workflow: { format: string; supportedTargets?: readonly string[] }): readonly string[] {
  return workflow.supportedTargets?.length ? workflow.supportedTargets : [workflow.format];
}
export interface RunView {
  id: string; workflowId: string; method: DeploymentMethod; format: string; artifactVersion: number;
  environment: string; status: string; createdAt: string; attemptCount: number; error: string | null;
  receipt: DeliveryReceipt | null; planHash: string; expiresAt: string;
}
export interface DeploymentConfiguration {
  targetMethods: TargetMethodMappings;
  legacyGit?: { id: string; name: string }[];
  environments: string[];
  connections: ConnectionView[];
}
export interface ProductDeploymentConfiguration extends DeploymentConfiguration {
  workflows: WorkflowView[];
  canManage: boolean;
}
export interface DeploymentWorkspace {
  entitySlug?: string;
  legacyGit?: { id: string; name: string }[];
  legacyMarkers?: { format: string; version: number; deployedAt?: string }[];
  connections: ConnectionView[]; workflows: WorkflowView[]; runs: RunView[];
  formats: { key: string; versions: number[]; sourceVersions?: Record<string, number> }[]; canConfigure: boolean; canRun: boolean;
  environments: string[];
  targetMethods: TargetMethodMappings;
  productWorkflowsHref: string | null;
  recorded: { target: string; environment: string; version: number; sourceVersion: number | null }[];
}
export interface DeploymentSummary {
  id: string; entityName: string; href: string; method: string; format: string; artifactVersion: number;
  environment: string; status: string; createdAt: string; outcome?: string; url?: string;
}

export class DeliveryError extends Error {
  constructor(message: string, public readonly retryable = false, public readonly uncertain = false, public readonly retryAfterMs?: number) {
    super(message); this.name = "DeliveryError";
  }
}
