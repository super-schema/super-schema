import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { withProjectionWrites } from "./mode";

/** A transaction-local capability: it cannot leak through a pooled connection or survive rollback. */
export function projectionTransaction<T>(
  db: PrismaClient,
  run: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { timeout?: number; maxWait?: number },
) {
  return withProjectionWrites(() =>
    db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('superschema.gitops_projection_write', 'on', true)`;
      return run(tx);
    }, options),
  );
}
