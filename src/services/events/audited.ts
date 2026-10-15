// src/services/events/audited.ts
import { withAudit, AuditUserMissingError } from "@/lib/audit";
import { ServiceErrorRejection } from "@/services/scoped-create.service";
import { ok, err, type Result } from "@/types/result";

export interface AuditedWriteParams<T> {
  action: string;
  entityType: string;
  entityId: string;
  userId: string;
  beforeState?: object;
  /** A Result failure is returned as-is and never audited (withAudit only logs after fn resolves). */
  run: () => Promise<Result<T>>;
}

function prismaCode(e: unknown): string | undefined {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

/** withAudit + the error mapping every events mutation needs (no throw crosses the service boundary). */
export async function auditedWrite<T>(p: AuditedWriteParams<T>): Promise<Result<T>> {
  try {
    const data = await withAudit({
      action: p.action,
      entityType: p.entityType,
      entityId: p.entityId,
      userId: p.userId,
      beforeState: p.beforeState,
      fn: async () => {
        const r = await p.run();
        if (!r.success) throw new ServiceErrorRejection(r.error);
        return r.data;
      },
    });
    return ok(data);
  } catch (e: unknown) {
    if (e instanceof ServiceErrorRejection) return err(e.serviceError);
    if (e instanceof AuditUserMissingError) return err({ code: "UNAUTHORIZED", message: e.message });
    const code = prismaCode(e);
    if (code === "P2002") return err({ code: "CONFLICT", message: "A concurrent change won.", suggestedFix: "Reload and try again." });
    if (code === "P2003") {
      return err({ code: "IN_USE", message: "This record is referenced by another record and cannot be removed.", suggestedFix: "Remove the references first." });
    }
    if (code === "P2025") return err({ code: "NOT_FOUND", message: "The record no longer exists." });
    return err({ code: "DB_ERROR", message: e instanceof Error ? e.message : "Database error" });
  }
}
