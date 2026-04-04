import { z } from "zod";

export const ClassificationLevelSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayColor: z.string(),
  bgColor: z.string(),
  textColor: z.string(),
  description: z.string().nullable(),
  sortOrder: z.number().int(),
  isSystem: z.boolean(),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
});

export type ClassificationLevel = z.infer<typeof ClassificationLevelSchema>;

export const CreateClassificationInputSchema = z.object({
  name: z
    .string()
    .min(1, "Classification name is required")
    .transform((s) => s.toUpperCase()),
  displayColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Must be a valid hex color (e.g., #FF0000)"),
  bgColor: z.string().min(1, "Background color is required"),
  textColor: z.string().min(1, "Text color is required"),
  description: z.string().optional(),
  sortOrder: z.number().int(),
});

export type CreateClassificationInput = z.infer<typeof CreateClassificationInputSchema>;

export const UpdateClassificationInputSchema = z.object({
  id: z.string().min(1, "Classification ID is required"),
  displayColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  bgColor: z.string().optional(),
  textColor: z.string().optional(),
  description: z.string().optional(),
  sortOrder: z.number().int().optional(),
});

export type UpdateClassificationInput = z.infer<typeof UpdateClassificationInputSchema>;

/**
 * System default classification levels with their UX design colors.
 */
export const SYSTEM_CLASSIFICATION_DEFAULTS: Omit<ClassificationLevel, "id" | "createdAt" | "updatedAt">[] = [
  {
    name: "PII",
    displayColor: "#DC2626",
    bgColor: "#DC262620",
    textColor: "#DC2626",
    description: "Personally Identifiable Information",
    sortOrder: 1,
    isSystem: true,
  },
  {
    name: "SENSITIVE",
    displayColor: "#D97706",
    bgColor: "#D9770620",
    textColor: "#D97706",
    description: "Sensitive business data",
    sortOrder: 2,
    isSystem: true,
  },
  {
    name: "INTERNAL",
    displayColor: "#2563EB",
    bgColor: "#2563EB20",
    textColor: "#2563EB",
    description: "Internal use only",
    sortOrder: 3,
    isSystem: true,
  },
  {
    name: "PUBLIC",
    displayColor: "#16A34A",
    bgColor: "#16A34A20",
    textColor: "#16A34A",
    description: "Public data",
    sortOrder: 4,
    isSystem: true,
  },
];
