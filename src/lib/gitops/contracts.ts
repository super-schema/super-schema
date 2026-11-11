import { z } from "zod";

export const KINDS = [
  "Tenant",
  "Domain",
  "Product",
  "Entity",
  "Event",
  "Trait",
  "Enum",
  "Scalar",
  "Union",
  "Service",
  "Interface",
  "Model",
  "Decorator",
] as const;
export const KindSchema = z.enum(KINDS);
export type ObjectKind = z.infer<typeof KindSchema>;
const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const slug = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const branch = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (s) =>
      !/[\x00-\x20~^:?*\[\\]/.test(s) &&
      !s.includes("..") &&
      !s.includes("@{") &&
      !s.startsWith("-") &&
      !s.startsWith("/") &&
      !s.endsWith("/") &&
      !s.endsWith(".") &&
      !s.split("/").some((p) => !p || p.startsWith(".") || p.endsWith(".lock")),
    "Invalid Git branch",
  );
export const basePath = z
  .string()
  .max(400)
  .refine(
    (s) =>
      !s.startsWith("/") &&
      !s.endsWith("/") &&
      !s.includes("\\") &&
      !/[\x00-\x1f\x7f]/.test(s) &&
      s
        .split("/")
        .every((p) => p !== "." && p !== ".." && (p !== "" || s === "")),
    "Use a safe repository-relative path",
  );
export const VersionSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:_snapshot)?$/);
export const OwnerSchema = z
  .string()
  .regex(/^@[a-zA-Z0-9-]+(?:\/[a-zA-Z0-9_.-]+)?$/);
export const ScopeSchema = z
  .object({
    tenantId: id,
    tenantSlug: slug,
    domainId: id.optional(),
    domainSlug: slug.optional(),
    productId: id.optional(),
    productSlug: slug.optional(),
  })
  .strict();
const jsonRecord = z.record(z.string(), z.json());
export const CanonicalSchema = z
  .object({
    apiVersion: z.literal("superschema.io/v1"),
    kind: KindSchema,
    id,
    version: VersionSchema.optional(),
    stage: z.enum(["SNAPSHOT", "RELEASED"]).optional(),
    scope: ScopeSchema,
    owners: z.array(OwnerSchema).max(100).default([]),
    spec: z
      .object({
        record: jsonRecord,
        children: z.record(z.string(), z.array(jsonRecord)).default({}),
        versionRecord: jsonRecord.optional(),
      })
      .strict(),
    references: z
      .array(
        z
          .object({
            kind: KindSchema,
            id,
            version: VersionSchema.optional(),
            role: z
              .enum(["FIELD", "PAYLOAD", "HEADERS", "KEY", "MESSAGE"])
              .optional(),
          })
          .strict(),
      )
      .default([]),
    deleted: z.boolean().optional(),
    configuration: jsonRecord.optional(),
  })
  .strict();
export type CanonicalDocument = z.infer<typeof CanonicalSchema>;
export type Scope = z.infer<typeof ScopeSchema>;
export const StageSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    branch,
    path: basePath.default("environments"),
  })
  .strict();
export const TargetSchema = z
  .object({
    target: z.string().min(1).max(100),
    repositoryUrl: z.string().url(),
    installationId: z.string().regex(/^\d+$/),
    branch,
    pathTemplate: z
      .string()
      .min(1)
      .max(500)
      .default("artifacts/{product}/{object}/{version}/{target}"),
    enabled: z.boolean().default(true),
  })
  .strict();
export const ProductSettingsSchema = z
  .object({
    repositoryUrl: z.string().url().optional(),
    installationId: z.string().regex(/^\d+$/).optional(),
    branch: branch.optional(),
    basePath: basePath.optional(),
    owners: z.array(OwnerSchema).max(100).default([]),
    stages: z
      .array(StageSchema)
      .min(1)
      .max(50)
      .refine(
        (a) =>
          new Set(a.map((s) => s.name)).size === a.length &&
          new Set(a.map((s) => s.branch)).size === a.length,
        "Use unique environment names and branches",
      ),
    targets: z.array(TargetSchema).max(100).default([]),
  })
  .strict();
export type ProductSettings = z.infer<typeof ProductSettingsSchema>;
export const BindingSchema = z
  .object({
    repositoryUrl: z.string().url(),
    installationId: z.string().regex(/^\d+$/),
    branch: branch.default("main"),
    basePath: basePath.default("superschema"),
    enabled: z.boolean().default(true),
  })
  .strict();
export const AppSchema = z
  .object({
    appId: z.string().regex(/^\d+$/),
    privateKey: z.string().min(1).max(32000),
    webhookSecret: z.string().min(20).max(1000),
    clientId: z.string().min(1).max(200),
    clientSecret: z.string().min(1).max(2000),
    baseUrl: z.string().url().default("https://github.com"),
  })
  .strict();
export const DraftSchema = z
  .object({
    productId: id,
    document: CanonicalSchema,
    operation: z
      .enum(["CREATE", "UPDATE", "DELETE", "RENAME"])
      .default("UPDATE"),
  })
  .strict();
export class GitOpsError extends Error {
  constructor(
    message: string,
    readonly code = "GITOPS_ERROR",
  ) {
    super(message);
    this.name = "GitOpsError";
  }
}
export type FileChange = { path: string; content: string | null };
export type PrState = {
  number: number;
  url: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  closed: boolean;
  mergeable: boolean | null;
  state:
    | "IN_REVIEW"
    | "CHANGES_REQUESTED"
    | "APPROVED"
    | "CONFLICT"
    | "CHECKS_FAILING"
    | "MERGED"
    | "CLOSED";
  review: unknown;
  checks: unknown;
};
