"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { ROLE_COLORS, type Role } from "@/types/schemas/rbac";
import type { GrantableScopes, RoleMatrix as RoleMatrixData } from "@/types/schemas/user-admin";
import { getRoleMatrixAction } from "@/app/(dashboard)/admin/actions";
import { UserStatusBadge } from "./UserStatusBadge";
import { roleLabel } from "./scope-selection";

import { NativeSelect } from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
          <NativeSelect
            id="role-matrix-tenant"
            data-testid="role-matrix-tenant"
            value={tenantId ?? matrix?.tenantId ?? ""}
            onChange={(event) => setTenantId(event.target.value)}
          >
            {tenants.map((tenant) => (
              <option key={tenant.scopeKey} value={tenant.tenantId ?? ""}>{tenant.tenantName}</option>
            ))}
          </NativeSelect>
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
          <div className="overflow-hidden rounded-lg border border-border">
            <Table
              className="text-body-small"
              data-testid="role-matrix-table"
              containerProps={{
                role: "region",
                "aria-label": `Role matrix of ${matrix.tenantName}`,
                tabIndex: 0,
                className: "outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
              }}
            >
              <TableCaption className="sr-only">
                Roles in {matrix.tenantName}: each row is a person, each column a tenant, domain or product, and each cell the highest role they hold there.
              </TableCaption>
              <TableHeader>
                <TableRow className="bg-muted/50 hover:bg-muted/50">
                  <TableHead scope="col" className="sticky left-0 bg-muted/50 text-muted-foreground">User</TableHead>
                  {matrix.scopes.map((scope) => (
                    <TableHead key={scope.scopeKey} scope="col" data-scope-key={scope.scopeKey} className="text-muted-foreground">
                      <span className="block text-foreground">{scope.productName ?? scope.domainName ?? scope.tenantName}</span>
                      <span className="block text-caption font-normal">{KIND_LABEL[scope.kind]}</span>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {matrix.rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={matrix.scopes.length + 1} className="py-space-8 text-center text-muted-foreground">Nobody holds a role in this tenant yet.</TableCell>
                  </TableRow>
                ) : (
                  matrix.rows.map((row) => (
                    <TableRow key={row.userId} data-testid="matrix-row" data-email={row.email}>
                      <TableHead scope="row" className="sticky left-0 bg-background font-normal whitespace-normal">
                        <span className="break-all">{row.email}</span>
                        {row.status === "disabled" && <span className="ml-space-2 align-middle"><UserStatusBadge status="disabled" /></span>}
                      </TableHead>
                      {matrix.scopes.map((scope) => {
                        const cell = row.cells[scope.scopeKey] ?? { direct: null, effective: null };
                        return (
                          <TableCell key={scope.scopeKey} data-testid="matrix-cell" data-scope-key={scope.scopeKey}>
                            <Cell direct={cell.direct} effective={cell.effective} />
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
