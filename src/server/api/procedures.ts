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

// adminProcedure — requires Admin role (system-level)
export const adminProcedure = protectedProcedure.use(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async ({ context, next }: any) => {
    const userRole = context?.session?.user?.role ?? context?.userRole;
    if (userRole !== "ADMIN") {
      throw new Error("FORBIDDEN: Requires ADMIN role. Contact your administrator.");
    }
    return next({ context });
  }
);

// authorProcedure — requires Author role (or higher) for the relevant domain
export const authorProcedure = protectedProcedure.use(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async ({ context, next }: any) => {
    const userRole = context?.session?.user?.role ?? context?.userRole;
    const allowed = ["AUTHOR", "STEWARD", "COMPLIANCE_OFFICER", "ADMIN"];
    if (!allowed.includes(userRole)) {
      throw new Error("FORBIDDEN: Requires AUTHOR role. Contact your administrator.");
    }
    return next({ context });
  }
);

// stewardProcedure — requires Steward role (or higher)
export const stewardProcedure = protectedProcedure.use(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async ({ context, next }: any) => {
    const userRole = context?.session?.user?.role ?? context?.userRole;
    const allowed = ["STEWARD", "COMPLIANCE_OFFICER", "ADMIN"];
    if (!allowed.includes(userRole)) {
      throw new Error("FORBIDDEN: Requires STEWARD role. Contact your administrator.");
    }
    return next({ context });
  }
);

// complianceProcedure — requires Compliance Officer role (or higher)
export const complianceProcedure = protectedProcedure.use(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async ({ context, next }: any) => {
    const userRole = context?.session?.user?.role ?? context?.userRole;
    const allowed = ["COMPLIANCE_OFFICER", "ADMIN"];
    if (!allowed.includes(userRole)) {
      throw new Error("FORBIDDEN: Requires COMPLIANCE_OFFICER role. Contact your administrator.");
    }
    return next({ context });
  }
);
