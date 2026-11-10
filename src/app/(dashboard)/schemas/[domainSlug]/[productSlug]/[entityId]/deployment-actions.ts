"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { guardSubject, contextOf } from "@/lib/action-context";
import { DeliveryError } from "@/lib/deployments/contracts";
import { SecretBoxError } from "@/lib/crypto/secret-box";
import type { ServiceContext } from "@/types/service-context";
import * as workflows from "@/services/deployment-workflow.service";

async function call<T>(entityId: string, action: "deploy.read" | "deploy.run" | "deploy.configure", run: (ctx: ServiceContext) => Promise<T>): Promise<{ success: true; data: T } | { error: string }> {
  try {
    const access = await guardSubject(action, { kind: "entity", id: entityId }, { label: "Entity" });
    if (!access.allowed) return { error: access.refusal.error };
    return { success: true, data: await run(contextOf(access.principal)) };
  } catch (error) {
    if (error instanceof ZodError) return { error: error.issues[0]?.message ?? "Invalid deployment settings" };
    if (error instanceof DeliveryError || error instanceof SecretBoxError) return { error: error.message };
    return { error: "The deployment request failed. Check the connection, workflow name and database migrations." };
  }
}
export async function getDeploymentWorkspaceAction(entityId: string) { return call(entityId, "deploy.read", (ctx) => workflows.getDeploymentWorkspace(entityId, ctx)); }
export async function saveDeploymentConnectionAction(entityId: string, input: unknown) { return call(entityId, "deploy.configure", (ctx) => workflows.saveDeploymentConnection(entityId, input, ctx)); }
export async function verifyDeploymentConnectionAction(entityId: string, id: string) { return call(entityId, "deploy.configure", (ctx) => workflows.verifyDeploymentConnection(entityId, id, ctx)); }
export async function importLegacyGitConnectionAction(entityId: string, id: string) { return call(entityId, "deploy.configure", (ctx) => workflows.importLegacyGitConnection(entityId, id, ctx)); }
export async function saveDeploymentWorkflowAction(entityId: string, input: unknown) { return call(entityId, "deploy.run", (ctx) => workflows.saveDeploymentWorkflow(entityId, input, ctx)); }
export async function previewDeploymentAction(entityId: string, input: unknown) { return call(entityId, "deploy.run", (ctx) => workflows.previewDeployment(entityId, input, ctx)); }
export async function executeDeploymentAction(entityId: string, input: unknown) {
  return call(entityId, "deploy.run", async (ctx) => {
    const result = await workflows.queueDeployment(entityId, input, ctx);
    if (result.status === "QUEUED") after(async () => { await workflows.processDeploymentRun(result.id); });
    revalidatePath("/deployments");
    return result;
  });
}
export async function refreshDeploymentReceiptAction(entityId: string, id: string) { return call(entityId, "deploy.read", (ctx) => workflows.refreshDeploymentReceipt(entityId, id, ctx)); }
