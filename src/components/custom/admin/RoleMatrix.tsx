"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { ROLE_COLORS, type Role } from "@/types/schemas/rbac";
import type { GrantableScopes, RoleMatrix as RoleMatrixData } from "@/types/schemas/user-admin";
import { getRoleMatrixAction } from "@/app/(dashboard)/admin/actions";
import { UserStatusBadge } from "./UserStatusBadge";
import { roleLabel } from "./scope-selection";

interface RoleMatrixProps {
  /** The tenants the caller may look at come from here; with none (it is still loading) the tenant in view is shown. */
  scopes: GrantableScopes | null;
}

const KIND_LABEL = { TENANT: "Tenant", DOMAIN: "Domain", PRODUCT: "Product" } as const;

function Cell({ direct, effective }: { direct: Role | null; effective: Role | null }) {
  if (direct) {
    const colors = ROLE_COLORS[direct];
    return (
      <span data-testid="matrix-role" data-role={direct} className={`inline-flex rounded-full px-2 py-0.5 text-caption ${colors.bg} ${colors.text}`}>
        {roleLabel(direct)}
      </span>
    );
  }
  if (effective) {
    return (
      <span data-testid="matrix-inherited" data-role={effective} className="text-caption italic text-muted-foreground" title={`Inherited from a wider scope: ${roleLabel(effective)}`}>
        {roleLabel(effective)} <span className="not-italic">(inherited)</span>
      </span>
    );
  }
  return (
    <>
      <span aria-hidden="true" className="text-muted-foreground">{"·"}</span>
      <span className="sr-only">No role</span>
    </>
  );
}

/**
 * Users by scopes for one tenant: a row for everyone who holds a role in it, a column for the tenant, each domain and each product, and in each cell the
 * highest role the person holds AT that scope (a role they hold only through a wider scope is shown as inherited). The server decides which tenants the
 * caller may look at and which roles they see; a tenant administrator never sees another tenant's people.
 */
export function RoleMatrix({ scopes }: RoleMatrixProps) {
  const tenants = scopes?.scopes.filter((scope) => scope.kind === "TENANT") ?? [];
  const [tenantId, setTenantId] = useState<string | undefined>(undefined);
  const [matrix, setMatrix] = useState<RoleMatrixData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      const res = await getRoleMatrixAction(tenantId);
      if (cancelled) return;
      if ("data" in res && res.data) setMatrix(res.data);
      else {
        setMatrix(null);
        setError("error" in res && res.error ? res.error : "The role matrix could not be loaded.");
      }
      setLoading(false);
    }
    // Fetch when the tenant changes; state updates occur after the async result resolves.
    void load();
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  return (
    <div className="space-y-space-4" data-testid="role-matrix">
      {tenants.length > 1 && (
        <div className="flex items-center gap-space-2">
          <label htmlFor="role-matrix-tenant" className="text-caption text-muted-foreground">Tenant</label>
          <select
            id="role-matrix-tenant"
            data-testid="role-matrix-tenant"
            value={tenantId ?? matrix?.tenantId ?? ""}
            onChange={(event) => setTenantId(event.target.value)}
            className="bg-muted rounded-md px-space-3 py-1.5 text-body-small text-foreground outline-none focus-visible:ring-1 focus-visible:ring-primary"
          >
            {tenants.map((tenant) => (
              <option key={tenant.scopeKey} value={tenant.tenantId ?? ""}>{tenant.tenantName}</option>
            ))}
          </select>
        </div>
      )}

      {error && (
        <div role="alert" data-testid="role-matrix-error" className="rounded-md border border-destructive/40 bg-destructive/10 px-space-4 py-space-3 text-body-small text-destructive">
          {error}
        </div>
      )}

      {loading && !matrix && (
        <p role="status" className="text-body-small text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin inline mr-space-2" aria-hidden="true" />
          Loading the role matrix…
        </p>
      )}

      {matrix && (
        <>
          {matrix.truncated && (
            <p role="note" className="text-caption text-muted-foreground">The matrix is cut at its limit: it lists the first people only.</p>
          )}
          <div role="region" aria-label={`Role matrix of ${matrix.tenantName}`} tabIndex={0} className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-body-small" data-testid="role-matrix-table">
              <caption className="sr-only">
                Roles in {matrix.tenantName}: each row is a person, each column a tenant, domain or product, and each cell the highest role they hold there.
              </caption>
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th scope="col" className="sticky left-0 bg-muted/50 px-space-4 py-space-3 text-left font-medium text-muted-foreground">User</th>
                  {matrix.scopes.map((scope) => (
                    <th key={scope.scopeKey} scope="col" data-scope-key={scope.scopeKey} className="px-space-3 py-space-3 text-left font-medium text-muted-foreground">
                      <span className="block text-foreground">{scope.productName ?? scope.domainName ?? scope.tenantName}</span>
                      <span className="block text-caption font-normal">{KIND_LABEL[scope.kind]}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.rows.length === 0 ? (
                  <tr>
                    <td colSpan={matrix.scopes.length + 1} className="px-space-4 py-space-8 text-center text-muted-foreground">Nobody holds a role in this tenant yet.</td>
                  </tr>
                ) : (
                  matrix.rows.map((row) => (
                    <tr key={row.userId} data-testid="matrix-row" data-email={row.email} className="border-b border-border last:border-0">
                      <th scope="row" className="sticky left-0 bg-background px-space-4 py-space-3 text-left font-normal text-foreground">
                        <span className="break-all">{row.email}</span>
                        {row.status === "disabled" && <span className="ml-space-2 align-middle"><UserStatusBadge status="disabled" /></span>}
                      </th>
                      {matrix.scopes.map((scope) => {
                        const cell = row.cells[scope.scopeKey] ?? { direct: null, effective: null };
                        return (
                          <td key={scope.scopeKey} data-testid="matrix-cell" data-scope-key={scope.scopeKey} className="px-space-3 py-space-3">
                            <Cell direct={cell.direct} effective={cell.effective} />
                          </td>
                        );
                      })}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
