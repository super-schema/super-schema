import { randomUUID } from "node:crypto";
import { getGitOpsWorkerSettings } from "@/lib/gitops/config.mjs";
import { prisma } from "@/lib/db";
import type { Prisma, TenantGitBinding } from "@/generated/prisma/client";
import { openSecret } from "@/lib/crypto/secret-box";
import { parseRepository } from "@/lib/deployments/github";
import {
  validateRepository,
  validateDocument,
  objectKey,
} from "@/lib/gitops/canonical";
import { MODELS, objectIdentity } from "@/lib/gitops/canonical";
import { GitOpsError } from "@/lib/gitops/contracts";
import { rebuildProjection } from "@/lib/gitops/projection";
import { verifyWebhook } from "@/lib/gitops/provider";
import {
  configuredApp,
  json,
  providerFor,
  type ProviderFactory,
} from "./settings";

type JobDb = Prisma.TransactionClient | typeof prisma;
export async function enqueueJob(
  bindingId: string,
  kind: string,
  key: string,
  payload: unknown = {},
  db: JobDb = prisma,
) {
  return db.gitOpsJob.upsert({
    where: { dedupeKey: key },
    create: { bindingId, kind, dedupeKey: key, payload: json(payload) },
    update: {},
  });
}
export async function synchronizeBinding(
  id: string,
  provider: ProviderFactory = providerFor,
  force = false,
): Promise<void> {
  const binding = await prisma.tenantGitBinding.findUniqueOrThrow({
    where: { id },
  });
  if (!binding.enabled) return;
  const remote = await provider(binding),
    sha = await remote.base(binding.branch);
  await prisma.tenantGitBinding.update({
    where: { id },
    data: { lastSyncStatus: "SYNCING", lastError: null },
  });
  try {
    if (
      force ||
      binding.lastSyncStatus === "ERROR" ||
      sha !== binding.indexedSha
    ) {
      const prefix = binding.basePath ? `${binding.basePath}/` : "";
      const files = await remote.readFiles(
        sha,
        (p) =>
          p.startsWith(prefix) &&
          /(?:tenant|domain|product|entity|event|trait|enum|scalar|union|service|interface|model|decorator)\.yaml$/.test(
            p,
          ),
      );
      const previous = await prisma.gitCanonicalDocument.findMany({
        where: { bindingId: id },
      });
      if (!files.length) {
        await prisma.tenantGitBinding.update({
          where: { id },
          data: {
            lastSyncStatus: "BOOTSTRAP_REQUIRED",
            lastSyncAt: new Date(),
            lastError:
              "Initialize or export this binding to Git, then merge the bootstrap PR",
          },
        });
        return;
      }
      const external = (
        await prisma.gitCanonicalDocument.findMany({
          where: { tenantId: binding.tenantId, bindingId: { not: id } },
        })
      ).map((d) => validateDocument(d.document));
      const result = validateRepository(
        files,
        binding.basePath,
        previous.map((p) => ({ path: p.path, content: p.content })),
        external,
      );
      const tenant = await prisma.tenant.findUniqueOrThrow({
        where: { id: binding.tenantId },
      });
      for (const f of result.documents)
        if (
          f.document.scope.tenantId !== binding.tenantId ||
          f.document.scope.tenantSlug !== tenant.slug ||
          (binding.productId &&
            f.document.scope.productId &&
            f.document.scope.productId !== binding.productId)
        )
          result.errors.push({
            path: f.path,
            message:
              "Canonical content belongs to a different tenant or product binding",
          });
      if (!result.documents.some((f) => f.document.kind === "Tenant"))
        result.errors.push({
          path: prefix + "tenant.yaml",
          message: "A canonical tenant manifest is required",
        });
      if (result.errors.length) {
        await prisma.$transaction(async (tx) => {
          await tx.indexError.deleteMany({ where: { bindingId: id } });
          for (const e of result.errors)
            await tx.indexError.upsert({
              where: { bindingId_path: { bindingId: id, path: e.path } },
              create: {
                bindingId: id,
                path: e.path,
                sha,
                message: e.message.slice(0, 4000),
              },
              update: { sha, message: e.message.slice(0, 4000) },
            });
        });
        throw new GitOpsError(
          `${result.errors.length} canonical file validation error(s); the previous projection is preserved`,
          "INDEX_FAILED",
        );
      }
      const overrides = binding.productId
        ? []
        : await prisma.tenantGitBinding.findMany({
            where: {
              tenantId: binding.tenantId,
              productId: { not: null },
              enabled: true,
            },
          });
      const selected = result.documents.filter(
        (f) =>
          !f.document.scope.productId ||
          !overrides.some((b) => b.productId === f.document.scope.productId),
      );
      const changed = selected.filter(
        (f) =>
          !previous.some(
            (p) =>
              p.path === f.path &&
              p.blobSha === files.find((x) => x.path === f.path)?.sha,
          ),
      );
      const touched = new Set(
        (force || binding.lastSyncStatus === "ERROR" ? selected : changed).map(
          (f) => objectIdentity(f.document),
        ),
      );
      await rebuildProjection(
        prisma,
        selected
          .filter((f) => touched.has(objectIdentity(f.document)))
          .map((f) => f.document),
        binding.createdBy,
        async (tx) => {
          await tx.gitCanonicalDocument.deleteMany({
            where: {
              bindingId: id,
              path: { notIn: selected.map((f) => f.path) },
            },
          });
          for (const f of selected) {
            const d = f.document,
              blobSha = files.find((x) => x.path === f.path)!.sha;
            const prior = previous.find((p) => p.path === f.path);
            const data = {
              tenantId: binding.tenantId,
              productId: d.scope.productId ?? null,
              objectId: d.id,
              kind: d.kind,
              version: d.version ?? "",
              stage: d.stage ?? null,
              path: f.path,
              blobSha,
              content: f.content,
              commitSha: prior?.blobSha === blobSha ? prior.commitSha : sha,
              document: json(d),
            };
            await tx.gitCanonicalDocument.upsert({
              where: { bindingId_path: { bindingId: id, path: f.path } },
              create: { bindingId: id, ...data },
              update: data,
            });
          }
          for (const removed of previous.filter(
            (old) =>
              !["Tenant", "Domain", "Product"].includes(old.kind) &&
              !selected.some(
                (f) =>
                  objectIdentity(f.document) === `${old.kind}:${old.objectId}`,
              ),
          )) {
            if (
              await tx.gitCanonicalDocument.findFirst({
                where: { kind: removed.kind, objectId: removed.objectId },
              })
            )
              continue;
            const model = MODELS[removed.kind as keyof typeof MODELS];
            const table = (
              tx as unknown as Record<
                string,
                { deleteMany: (args: unknown) => Promise<unknown> }
              >
            )[model];
            await table.deleteMany({ where: { id: removed.objectId } });
          }
          for (const manifest of selected.filter(
            (f) =>
              f.document.kind === "Product" &&
              f.document.configuration &&
              (force || changed.some((c) => c.path === f.path)),
          )) {
            const d = manifest.document,
              c = d.configuration!;
            await tx.productGitSettings.upsert({
              where: { productId: d.id },
              create: {
                productId: d.id,
                tenantId: binding.tenantId,
                bindingId: id,
                sourceSha: sha,
                owners: d.owners,
                stages: json(c.stages),
                targets: json(c.targets ?? []),
              },
              update: {
                owners: d.owners,
                stages: json(c.stages),
                targets: json(c.targets ?? []),
                revision: { increment: 1 },
              },
            });
            await enqueueJob(
              id,
              "DEFAULT_WORKFLOW",
              `workflow:${id}:${sha}:${d.id}`,
              { productId: d.id },
              tx,
            );
          }
          for (const item of await tx.changeSetItem.findMany({
            where: {
              changeSetId: {
                in: (
                  await tx.changeSet.findMany({
                    where: {
                      tenantId: binding.tenantId,
                      state: { notIn: ["MERGED", "CLOSED"] },
                      OR: [
                        { leasedUntil: null },
                        { leasedUntil: { lt: new Date() } },
                      ],
                    },
                  })
                ).map((c) => c.id),
              },
            },
          })) {
            const f = files.find((f) => f.path === (item.oldPath ?? item.path));
            if ((f?.sha ?? null) !== item.baseBlobSha)
              await tx.changeSetItem.update({
                where: { id: item.id },
                data: { outOfDate: true },
              });
          }
          await tx.indexError.deleteMany({ where: { bindingId: id } });
          if (
            (
              await tx.tenantGitBinding.updateMany({
                where: { id, revision: binding.revision },
                data: {
                  indexedSha: sha,
                  lastSyncAt: new Date(),
                  lastSyncStatus: "SYNCED",
                  lastError: null,
                },
              })
            ).count !== 1
          )
            throw new GitOpsError(
              "Binding configuration changed during indexing",
            );
          const products = new Set(
            changed
              .map((f) => f.document.scope.productId)
              .filter((id): id is string => !!id),
          );
          for (const shared of changed.filter(
            (f) => !f.document.scope.productId,
          ))
            for (const product of selected.filter(
              (f) =>
                f.document.kind === "Product" &&
                (!shared.document.scope.domainId ||
                  f.document.scope.domainId === shared.document.scope.domainId),
            ))
              products.add(product.document.id);
          const frozenDocs = new Map(
            result.documents.map((f) => [objectKey(f.document), f.document]),
          );
          for (const d of external)
            if (!frozenDocs.has(objectKey(d))) frozenDocs.set(objectKey(d), d);
          for (const productId of products) {
            await tx.productGitSettings.updateMany({
              where: { productId, bindingId: id },
              data: { sourceSha: sha },
            });
            await enqueueJob(
              id,
              "DELIVERY",
              `delivery:${id}:${sha}:${productId}`,
              {
                productId,
                sha,
                documents: [...frozenDocs.values()],
                changed: changed
                  .filter((f) => f.document.scope.productId === productId)
                  .map((f) => objectKey(f.document)),
              },
              tx,
            );
          }

          if (
            changed.some(
              (f) =>
                f.document.kind === "Domain" || f.document.kind === "Product",
            )
          )
            await enqueueJob(id, "OWNERS", `owners:${id}:${sha}`, { sha }, tx);
        },
      );
    } else
      await prisma.tenantGitBinding.update({
        where: { id },
        data: {
          lastSyncAt: new Date(),
          lastSyncStatus: "SYNCED",
          lastError: null,
        },
      });
    await synchronizePullRequests(binding, provider);
  } catch (e) {
    await prisma.tenantGitBinding.update({
      where: { id },
      data: {
        lastSyncStatus: "ERROR",
        lastError:
          e instanceof GitOpsError
            ? e.message
            : "GitHub synchronization failed; retry or check the connection",
      },
    });
    throw e;
  }
}
async function synchronizePullRequests(
  binding: TenantGitBinding,
  provider: ProviderFactory,
): Promise<void> {
  const products = await prisma.productGitSettings.findMany({
      where: { bindingId: binding.id },
    }),
    productIds = products.map((p) => p.productId);
  const remote = await provider(binding);
  for (const cs of await prisma.changeSet.findMany({
    where: {
      productId: { in: productIds },
      prNumber: { not: null },
      state: { notIn: ["MERGED", "CLOSED"] },
    },
  })) {
    const state = await remote.pullRequest(cs.prNumber!);
    const diverged =
      !state.merged &&
      !state.closed &&
      !!cs.headSha &&
      cs.headSha !== state.headSha;
    if (diverged)
      await prisma.changeSetItem.updateMany({
        where: { changeSetId: cs.id },
        data: { outOfDate: true },
      });
    await prisma.changeSet.update({
      where: { id: cs.id },
      data: {
        state: diverged ? "OUT_OF_DATE" : state.state,
        mergeable: state.mergeable,
        review: json(state.review),
        checks: json(state.checks),
        ...(["MERGED", "CLOSED"].includes(state.state)
          ? { openKey: null }
          : {}),
      },
    });
  }
  for (const delivery of await prisma.deliveryPullRequest.findMany({
    where: {
      bindingId: binding.id,
      prNumber: { not: null },
      state: { notIn: ["DELIVERED", "CLOSED"] },
    },
  })) {
    const target = {
      ...binding,
      repositoryUrl: delivery.repositoryUrl,
      installationId: delivery.installationId ?? binding.installationId,
    };
    try {
      const state = await (
        await provider(target)
      ).pullRequest(delivery.prNumber!);
      const diverged = !!delivery.headSha && delivery.headSha !== state.headSha;
      await prisma.deliveryPullRequest.update({
        where: { id: delivery.id },
        data: {
          state: diverged
            ? "DIVERGED"
            : state.merged
              ? "DELIVERED"
              : state.closed
                ? "CLOSED"
                : state.state,
          lastError: diverged
            ? "The PR branch changed outside Super Schema; review it before retrying"
            : null,
        },
      });
    } catch {
      await prisma.deliveryPullRequest.update({
        where: { id: delivery.id },
        data: { lastError: "Could not refresh the destination PR status" },
      });
    }
  }
}
export async function receiveWebhook(
  body: string,
  signature: string | null,
  event: string,
  deliveryId: string,
): Promise<number> {
  const app = await configuredApp();
  if (
    !verifyWebhook(
      body,
      signature,
      openSecret(app.webhookSecret, "GitProviderApp.webhookSecret"),
    )
  )
    throw new GitOpsError("Invalid GitHub webhook signature", "UNAUTHORIZED");
  if (
    !/^[a-zA-Z0-9_-]{1,200}$/.test(deliveryId) ||
    body.length > 2 * 1024 * 1024
  )
    throw new GitOpsError("Invalid webhook delivery");
  const data = JSON.parse(body) as {
    repository?: { full_name?: string; html_url?: string };
    installation?: { id?: number };
  };
  if (
    ![
      "push",
      "pull_request",
      "pull_request_review",
      "check_suite",
      "check_run",
      "installation",
      "installation_repositories",
    ].includes(event)
  )
    return 0;
  return prisma.$transaction(async (tx) => {
    if (await tx.gitWebhookDelivery.findUnique({ where: { id: deliveryId } }))
      return 0;
    await tx.gitWebhookDelivery.create({ data: { id: deliveryId, event } });
    const bindings = await tx.tenantGitBinding.findMany({
      where: {
        enabled: true,
        installationId: String(data.installation?.id ?? ""),
      },
    });
    let queued = 0;
    for (const binding of bindings) {
      const repo = parseRepository(binding.repositoryUrl);
      if (
        data.repository?.full_name &&
        `${repo.owner}/${repo.repo}`.toLowerCase() !==
          data.repository.full_name.toLowerCase()
      )
        continue;
      if (
        data.repository?.html_url &&
        new URL(data.repository.html_url).origin !==
          new URL(binding.repositoryUrl).origin
      )
        continue;
      await enqueueJob(
        binding.id,
        "SYNC",
        `webhook:${deliveryId}:${binding.id}`,
        {},
        tx,
      );
      queued++;
    }
    return queued;
  });
}
export async function pollBindings(): Promise<void> {
  const now = new Date();
  const {pollIntervalMs}=getGitOpsWorkerSettings();
  for (const binding of await prisma.tenantGitBinding.findMany({
    where: { enabled: true, nextSyncAt: { lte: now } },
    take: 100,
  })) {
    await prisma.$transaction(async (tx) => {
      if (
        (
          await tx.tenantGitBinding.updateMany({
            where: { id: binding.id, nextSyncAt: { lte: now } },
            data: { nextSyncAt: new Date(Date.now() + pollIntervalMs) },
          })
        ).count
      )
        await enqueueJob(
          binding.id,
          "SYNC",
          `poll:${binding.id}:${Math.floor(Date.now() / pollIntervalMs)}`,
          {},
          tx,
        );
    });
  }
}
export async function processGitOpsJobs(
  limit = 5,
  provider: ProviderFactory = providerFor,
): Promise<number> {
  await pollBindings();
  let processed = 0;
  const jobs = await prisma.gitOpsJob.findMany({
    where: {
      state: { in: ["PENDING", "RUNNING"] },
      dueAt: { lte: new Date() },
      OR: [{ leasedUntil: null }, { leasedUntil: { lt: new Date() } }],
    },
    orderBy: { dueAt: "asc" },
    take: Math.min(20, Math.max(1, limit)),
  });
  for (const job of jobs) {
    const token = randomUUID();
    const claimed = await prisma.gitOpsJob.updateMany({
      where: {
        id: job.id,
        state: { in: ["PENDING", "RUNNING"] },
        OR: [{ leasedUntil: null }, { leasedUntil: { lt: new Date() } }],
      },
      data: {
        state: "RUNNING",
        leaseToken: token,
        leasedUntil: new Date(Date.now() + 120000),
        attempts: { increment: 1 },
      },
    });
    if (!claimed.count) continue;
    const heartbeat = setInterval(() => {
      void prisma.gitOpsJob
        .updateMany({
          where: { id: job.id, leaseToken: token },
          data: { leasedUntil: new Date(Date.now() + 120000) },
        })
        .catch(() => {});
    }, 30000);
    heartbeat.unref();
    try {
      if (job.kind === "SYNC")
        await synchronizeBinding(
          job.bindingId,
          provider,
          (job.payload as { force?: boolean })?.force === true,
        );
      else if (job.kind === "DEFAULT_WORKFLOW") {
        const settings = await import("./settings"),
          productId = (job.payload as { productId: string }).productId,
          binding = await prisma.tenantGitBinding.findUniqueOrThrow({
            where: { id: job.bindingId },
          }),
          config = await prisma.productGitSettings.findUniqueOrThrow({
            where: { productId },
          }),
          stages = config.stages as {
            name: string;
            branch: string;
            path: string;
          }[];
        const workflowId = await settings.ensureDefaultWorkflow(
          binding,
          productId,
          binding.createdBy,
          stages,
        );
        await prisma.productGitSettings.update({
          where: { productId },
          data: { workflowId },
        });
      } else {
        const delivery = await import("./delivery");
        if (job.kind === "DELIVERY")
          await delivery.deliverArtifacts(job.bindingId, job.payload, provider);
        else if (job.kind === "OWNERS")
          await delivery.synchronizeOwners(job.bindingId, provider);
        else throw new GitOpsError("Unknown GitOps job kind");
      }
      await prisma.gitOpsJob.updateMany({
        where: { id: job.id, leaseToken: token },
        data: {
          state: "SUCCEEDED",
          leaseToken: null,
          leasedUntil: null,
          finishedAt: new Date(),
          lastError: null,
        },
      });
      processed++;
    } catch (e) {
      await prisma.gitOpsJob.updateMany({
        where: { id: job.id, leaseToken: token },
        data: {
          state: job.attempts + 1 >= 5 ? "FAILED" : "PENDING",
          leaseToken: null,
          leasedUntil: null,
          dueAt: new Date(
            Date.now() + Math.min(3600000, 30000 * 2 ** job.attempts),
          ),
          lastError:
            e instanceof GitOpsError
              ? e.message.slice(0, 2000)
              : "GitOps operation failed; verify the connection and retry",
        },
      });
    } finally {
      clearInterval(heartbeat);
    }
  }
  return processed;
}
