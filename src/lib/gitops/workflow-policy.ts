import { prisma } from "@/lib/db";
import { DeliveryError } from "@/lib/deployments/contracts";
import { ProductSettingsSchema } from "./contracts";
import { contentStorage } from "./mode";
/** The managed default workflow inherits its repository and environment branch from Git-owned product configuration. */
export async function gitOpsWorkflowPolicy(
  workflowId: string,
  environment: string,
) {
  if (contentStorage() !== "git") return null;
  const settings = await prisma.productGitSettings.findFirst({
    where: { workflowId },
  });
  if (!settings) return null;
  const binding = await prisma.tenantGitBinding.findUnique({
    where: { id: settings.bindingId },
  });
  if (!binding?.enabled || !binding.indexedSha)
    throw new DeliveryError(
      "Synchronize the enabled GitOps binding before delivery",
    );
  const stages = ProductSettingsSchema.shape.stages.parse(settings.stages),
    index = stages.findIndex((s) => s.name === environment);
  if (index < 0)
    throw new DeliveryError(
      "Choose an environment defined in this product's GitOps workflow",
    );
  if (
    index > 1 &&
    !(await prisma.deliveryPullRequest.findFirst({
      where: {
        productId: settings.productId,
        kind: "ENVIRONMENT",
        target: stages[index - 1].name,
        sourceSha: settings.sourceSha ?? binding.indexedSha,
        state: "DELIVERED",
      },
    }))
  )
    throw new DeliveryError(
      `Promote the same canonical commit through ${stages[index - 1].name} in GitOps before ${environment}`,
    );
  return {
    revision: settings.revision,
    url: binding.repositoryUrl,
    baseBranch: stages[index].branch,
    gitRoot: binding.basePath,
    environments: stages.map((s) => s.name),
  };
}
export async function assertGitOpsWorkflowRevision(
  workflowId: string,
  environment: string,
  revision: number | undefined,
) {
  if (revision === undefined) return;
  const policy = await gitOpsWorkflowPolicy(workflowId, environment);
  if (!policy || policy.revision !== revision)
    throw new DeliveryError(
      "GitOps product configuration changed; create a new preview",
    );
}
/**
 * Repository, root path and per-environment branches of GitOps-managed workflows, read from the
 * product's stages whatever the content storage mode, so a deployment always targets the branch of
 * the selected environment. Promotion order and index freshness are enforced only by
 * {@link gitOpsWorkflowPolicy} in Git storage mode.
 */
export async function gitOpsStageDestinations(workflowIds: string[]) {
  const result = new Map<string, { url: string; gitRoot?: string; branches: Record<string, string> }>();
  if (!workflowIds.length) return result;
  const settings = await prisma.productGitSettings.findMany({
    where: { workflowId: { in: workflowIds } },
  });
  if (!settings.length) return result;
  const bindings = new Map(
    (
      await prisma.tenantGitBinding.findMany({
        where: { id: { in: settings.map((s) => s.bindingId) } },
      })
    ).map((b) => [b.id, b]),
  );
  for (const s of settings) {
    const binding = bindings.get(s.bindingId);
    const stages = ProductSettingsSchema.shape.stages.safeParse(s.stages);
    if (!s.workflowId || !binding?.enabled || !stages.success) continue;
    result.set(s.workflowId, {
      url: binding.repositoryUrl,
      gitRoot: binding.basePath || undefined,
      branches: Object.fromEntries(stages.data.map((st) => [st.name, st.branch])),
    });
  }
  return result;
}
