import { os } from "@orpc/server";
import type { RPCContext } from "./context";

export const publicProcedure = os.$context<RPCContext>();

// protectedProcedure adds auth check middleware
// oRPC middleware receives { context, input, path, next }
export const protectedProcedure = publicProcedure.use(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async ({ context, next }: any) => {
    if (!context?.session?.user) {
      throw new Error("UNAUTHORIZED: You must be logged in");
    }
    return next({ context });
  }
);
