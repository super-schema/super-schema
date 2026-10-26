/**
 * A stored `user_roles` row as an `Assignment` (pure: no I/O, no throws). The row carries its scope twice, as `scopeKey` and as the
 * `tenantId` / `domainId` / `productId` columns, and the database keeps them consistent (`user_roles_scope_columns_check`); this builds the
 * full `Scope` from the columns and accepts the row only when the key it computes from them is the stored key and the assignment is valid
 * (a known role; GLOBAL only for ADMIN). A row that fails either test is dropped, never half-trusted: a bad row grants nothing.
 */

import { isAssignment, scopeKey, type Assignment, type Scope } from "./scope";

/** The columns of a `user_roles` row the policy needs. The id columns may be absent from a narrower select: absent reads as null. */
export type RoleRow = {
  role: string;
  scopeKey: string;
  tenantId?: string | null;
  domainId?: string | null;
  productId?: string | null;
};

/** The columns to select to build an assignment (kept next to the mapper that reads them). */
export const ROLE_ROW_SELECT = { role: true, scopeKey: true, tenantId: true, domainId: true, productId: true } as const;

function isRow(value: unknown): value is RoleRow {
  return typeof value === "object" && value !== null && typeof (value as RoleRow).role === "string" && typeof (value as RoleRow).scopeKey === "string";
}

/**
 * The scope the row's key names, completed from the row's columns; `null` when the key is not a scope key or the columns say something
 * else than the key (a column the scope does not have must be empty: a tenant row with a domain column is not a tenant row).
 */
function scopeOfRow(row: RoleRow): Scope | null {
  const tenantId = row.tenantId ?? null;
  const domainId = row.domainId ?? null;
  const productId = row.productId ?? null;
  const kind = row.scopeKey === "G" ? "G" : row.scopeKey.slice(0, 2);
  switch (kind) {
    case "G":
      return tenantId === null && domainId === null && productId === null ? { kind: "GLOBAL" } : null;
    case "T:":
      return tenantId === null || domainId !== null || productId !== null ? null : { kind: "TENANT", tenantId };
    case "D:":
      return tenantId === null || domainId === null || productId !== null ? null : { kind: "DOMAIN", tenantId, domainId };
    case "P:":
      return tenantId === null || domainId === null || productId === null ? null : { kind: "PRODUCT", tenantId, domainId, productId };
    default:
      return null;
  }
}

/** The assignment a stored row grants, or `null` when the row is not a valid, self-consistent assignment. */
export function assignmentFromRow(row: unknown): Assignment | null {
  if (!isRow(row)) return null;
  const scope = scopeOfRow(row);
  if (scope === null || scopeKey(scope) !== row.scopeKey) return null;
  const assignment = { role: row.role, scope };
  return isAssignment(assignment) ? assignment : null;
}

/** The valid assignments among stored rows, in order. A non-array yields none. */
export function assignmentsFromRows(rows: unknown): Assignment[] {
  if (!Array.isArray(rows)) return [];
  const assignments: Assignment[] = [];
  for (const row of rows) {
    const assignment = assignmentFromRow(row);
    if (assignment) assignments.push(assignment);
  }
  return assignments;
}
