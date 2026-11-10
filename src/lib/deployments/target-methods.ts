import { z } from "zod";
import { METHODS, type DeploymentMethod } from "./contracts";

export const REGISTRY_TARGETS = ["avro", "json-schema", "protobuf"] as const;
export const TargetMethodMappingsSchema = z.record(z.string().min(1).max(100), z.array(z.enum(METHODS)).min(1).max(METHODS.length)
  .refine((methods) => new Set(methods).size === methods.length, "Deployment methods must be unique"));
export type TargetMethodMappings = z.infer<typeof TargetMethodMappingsSchema>;
export function registryTarget(target: string): boolean { return (REGISTRY_TARGETS as readonly string[]).includes(target); }
export function deploymentMethodsFor(target: string, configured: TargetMethodMappings = {}): DeploymentMethod[] {
  return configured[target] ?? (registryTarget(target) ? ["git", "registry"] : configured["*"] ?? ["git", "http"]);
}
