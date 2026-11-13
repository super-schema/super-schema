import type { PrismaClient } from "@/generated/prisma/client";
import { GitOpsError } from "./gitops/contracts";
import { isTenantGitWriteError } from "./gitops/tenant-mode";

/**
 * The app's Prisma client: runs the one-time storage initialization (`initialize`, on the raw client) before the first query, once per
 * process, and turns a Git-backed tenant's refused write into a GitOps error.
 */
export function withStorageInitialization(raw: PrismaClient, initialize: () => Promise<void>): PrismaClient {
  let initialization: Promise<void> | undefined;
  const initializeOnce = () =>
    (initialization ??= initialize().catch((error) => {
      initialization = undefined;
      throw error;
    }));
  const extended = raw.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          await initializeOnce();
          try {
            return await query(args);
          } catch (error) {
            if (isTenantGitWriteError(error))
              throw new GitOpsError(
                "This tenant stores contracts in Git. Use GitOps authoring to save a private draft and submit a pull request.",
                "GITOPS_AUTHORING_REQUIRED",
              );
            throw error;
          }
        },
      },
    },
  }) as unknown as PrismaClient;
  // Finish the initialization BEFORE a transaction opens. Started from a query inside an interactive transaction, the initialization (on the
  // raw client) waits for the transaction's connection while the transaction waits for it: on PGlite's single connection that holds until
  // Prisma's transaction timeout (P2028).
  return new Proxy(extended, {
    get(target, property, receiver) {
      if (property !== "$transaction") return Reflect.get(target, property, receiver);
      return async (...args: Parameters<PrismaClient["$transaction"]>) => {
        await initializeOnce();
        return (target.$transaction as (...a: unknown[]) => Promise<unknown>)(...args);
      };
    },
  });
}
