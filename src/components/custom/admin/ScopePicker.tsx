"use client";

import { useId } from "react";
import type { Role } from "@/types/schemas/rbac";
import type { GrantableScopes } from "@/types/schemas/user-admin";
import { EMPTY_SCOPE, describeSelection, domainOptions, platformOffered, productOptions, tenantOptions, type ScopeSelection } from "./scope-selection";

const PLATFORM_VALUE = "__platform__";

const SELECT_CLASS = "w-full bg-muted rounded-md px-space-3 py-1.5 text-body-small text-foreground outline-none focus-visible:ring-1 focus-visible:ring-primary";
const LABEL_CLASS = "block text-caption text-muted-foreground";

interface ScopePickerProps {
  /** What the caller may grant, from `getGrantableScopesAction`. Nothing outside it is ever offered. */
  scopes: GrantableScopes;
  /** The role being granted: the places offered are the ones the service accepts that role in (platform scope only for ADMIN, only to a platform administrator). */
  role: Role;
  value: ScopeSelection;
  onChange: (next: ScopeSelection) => void;
  disabled?: boolean;
  /** Prefix of the ids and test ids when several pickers share a page. */
  idPrefix?: string;
}

/**
 * Where a role applies, chosen from lists (a tenant, then optionally one of its domains, then optionally one of that domain's products) instead of an
 * id typed by hand. It offers only places the caller may grant `role` in; choosing only a tenant is the whole tenant, a tenant and a domain is that domain,
 * and so on. "Platform" is on the list only for a platform administrator granting the platform role. Native selects: keyboard operable and announced by
 * every screen reader as they are.
 */
export function ScopePicker({ scopes, role, value, onChange, disabled, idPrefix }: ScopePickerProps) {
  const generated = useId();
  const id = idPrefix ?? generated;
  const tenants = tenantOptions(scopes.scopes, role);
  const domains = value.tenantId ? domainOptions(scopes.scopes, role, value.tenantId) : [];
  const products = value.domainId ? productOptions(scopes.scopes, role, value.domainId) : [];
  const platform = platformOffered(scopes.canGrantPlatform, role);
  const summary = describeSelection(scopes.scopes, value);

  return (
    <fieldset className="space-y-space-3 min-w-0" data-testid="scope-picker" disabled={disabled}>
      <legend className="text-caption text-muted-foreground mb-space-1">Where the role applies</legend>

      <div className="space-y-space-1">
        <label htmlFor={`${id}-tenant`} className={LABEL_CLASS}>Tenant</label>
        <select
          id={`${id}-tenant`}
          data-testid="scope-tenant"
          className={SELECT_CLASS}
          value={value.platform ? PLATFORM_VALUE : value.tenantId}
          onChange={(event) => {
            const next = event.target.value;
            if (next === PLATFORM_VALUE) onChange({ platform: true, tenantId: "", domainId: "", productId: "" });
            else onChange({ ...EMPTY_SCOPE, tenantId: next });
          }}
        >
          <option value="">Choose a tenant…</option>
          {platform && <option value={PLATFORM_VALUE}>Platform (every tenant)</option>}
          {tenants.map((tenant) => (
            <option key={tenant.scopeKey} value={tenant.tenantId ?? ""}>{tenant.tenantName}</option>
          ))}
        </select>
      </div>

      {!value.platform && value.tenantId && domains.length > 0 && (
        <div className="space-y-space-1">
          <label htmlFor={`${id}-domain`} className={LABEL_CLASS}>Domain</label>
          <select
            id={`${id}-domain`}
            data-testid="scope-domain"
            className={SELECT_CLASS}
            value={value.domainId}
            onChange={(event) => onChange({ platform: false, tenantId: value.tenantId, domainId: event.target.value, productId: "" })}
          >
            <option value="">Whole tenant</option>
            {domains.map((domain) => (
              <option key={domain.scopeKey} value={domain.domainId ?? ""}>{domain.domainName}</option>
            ))}
          </select>
        </div>
      )}

      {!value.platform && value.domainId && products.length > 0 && (
        <div className="space-y-space-1">
          <label htmlFor={`${id}-product`} className={LABEL_CLASS}>Product</label>
          <select
            id={`${id}-product`}
            data-testid="scope-product"
            className={SELECT_CLASS}
            value={value.productId}
            onChange={(event) => onChange({ ...value, productId: event.target.value })}
          >
            <option value="">Whole domain</option>
            {products.map((product) => (
              <option key={product.scopeKey} value={product.productId ?? ""}>{product.productName}</option>
            ))}
          </select>
        </div>
      )}

      <p data-testid="scope-summary" aria-live="polite" className="text-caption text-muted-foreground">
        {summary ? <>Applies to: <span className="text-foreground">{summary}</span></> : "Choose where the role applies."}
      </p>
      {tenants.length === 0 && !platform && (
        <p role="note" data-testid="scope-none-offered" className="text-caption text-muted-foreground">
          There is no place you may grant this role in.
        </p>
      )}
    </fieldset>
  );
}
