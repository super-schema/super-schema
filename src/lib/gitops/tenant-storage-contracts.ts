import { z } from "zod";
import { BindingSchema, OwnerSchema, ProductSettingsSchema } from "./contracts";

export const TenantStorageSchema = z.enum(["database", "git"]);
export const TenantGitProfileSchema = z
  .object({
    binding: BindingSchema,
    owners: z.array(OwnerSchema).max(100).default([]),
    stages: ProductSettingsSchema.shape.stages,
  })
  .strict()
  .refine((v) => v.stages[0].branch === v.binding.branch, {
    message: "The first environment must use the canonical source branch",
    path: ["stages"],
  });
export const NewTenantSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(2000).default(""),
    storage: TenantStorageSchema.default("database"),
    domainName: z.string().trim().min(1).max(100).default("General"),
    productName: z.string().trim().min(1).max(100).default("Workspace"),
    git: TenantGitProfileSchema.optional(),
  })
  .strict()
  .refine((v) => v.storage !== "git" || !!v.git, {
    message: "Connect a repository for Git storage",
    path: ["git"],
  });
export type TenantGitProfile = z.infer<typeof TenantGitProfileSchema>;
