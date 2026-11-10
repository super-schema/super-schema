"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { guardActiveTenant, guardSubject, contextOf } from "@/lib/action-context";
import { DeliveryError } from "@/lib/deployments/contracts";
import { SecretBoxError } from "@/lib/crypto/secret-box";
import type { ServiceContext } from "@/types/service-context";
import * as service from "@/services/deployment-workflow.service";

async function call<T>(scope: { productId: string; action: "deploy.read" | "deploy.run" } | null, run: (tenantId: string, ctx: ServiceContext) => Promise<T>) {
  try {
    const access = scope
      ? await guardSubject(scope.action, { kind: "product", id: scope.productId }, { label: "Product" })
      : await guardActiveTenant("deploy.configure", { label: "Tenant" });
    if (!access.allowed) return { error: access.refusal.error };
    const data = await run(access.resource.tenantId!, contextOf(access.principal));
    revalidatePath("/schemas");
    return { success: true as const, data };
  } catch (e) {
    if (e instanceof ZodError) return { error: e.issues[0]?.message ?? "Invalid configuration" };
    if (e instanceof DeliveryError || e instanceof SecretBoxError) return { error: e.message };
    return { error: "Could not save or load deployment configuration. Check for a duplicate name or unapplied database migration." };
  }
}
export async function getTenantDeploymentConfigurationAction() { return call(null, (id, ctx) => service.getTenantDeploymentConfiguration(id, ctx)); }
export async function saveDeploymentEnvironmentsAction(input: unknown) { return call(null, (id, ctx) => service.saveDeploymentEnvironments(id, input, ctx)); }
export async function saveTenantDeploymentConnectionAction(input: unknown) { return call(null, (id, ctx) => service.saveTenantDeploymentConnection(id, input, ctx)); }
export async function verifyTenantDeploymentConnectionAction(connectionId: string) { return call(null, (id, ctx) => service.verifyTenantDeploymentConnection(id, connectionId, ctx)); }
export async function getProductDeploymentConfigurationAction(productId: string) { return call({ productId, action: "deploy.read" }, (_id, ctx) => service.getProductDeploymentConfiguration(productId, ctx)); }
export async function saveProductDeploymentWorkflowAction(productId: string, input: unknown) { return call({ productId, action: "deploy.run" }, (_id, ctx) => service.saveProductDeploymentWorkflow(productId, input, ctx)); }

export async function importTenantLegacyGitConnectionAction(connectionId: string) { return call(null, (id, ctx) => service.importTenantLegacyGitConnection(id, connectionId, ctx)); }

export async function saveDeploymentTargetMethodsAction(input: unknown) { return call(null, (id, ctx) => service.saveDeploymentTargetMethods(id, input, ctx)); }
