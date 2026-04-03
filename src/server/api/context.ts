import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function createRPCContext(opts: { headers: Headers }) {
  const session = await auth();
  return { session, db: prisma, headers: opts.headers };
}

export type RPCContext = Awaited<ReturnType<typeof createRPCContext>>;
