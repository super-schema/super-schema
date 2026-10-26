// @vitest-environment jsdom
/**
 * The scope picker and the rules behind it: a role is granted AT a scope chosen from lists of what the caller may grant (a tenant, then optionally one of
 * its domains, then optionally one of that domain's products), instead of an id typed by hand. Platform scope is on the list only for a platform administrator
 * and only for the platform role (ADMIN). A choice the role cannot take is cleared when the role changes.
 */
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ScopePicker } from "@/components/custom/admin/ScopePicker";
import {
  EMPTY_SCOPE,
  defaultSelection,
  describeSelection,
  domainOptions,
  platformOffered,
  productOptions,
  reconcileSelection,
  selectionToInput,
  tenantOptions,
  type ScopeSelection,
} from "@/components/custom/admin/scope-selection";
import type { Role } from "@/types/schemas/rbac";
import type { GrantableScopes } from "@/types/schemas/user-admin";
import { GLOBAL_ADMIN_SCOPES, TENANT_ADMIN_SCOPES, tenantScopes } from "../../helpers/admin-fixtures";

afterEach(cleanup);

function Harness({ scopes, role, initial = EMPTY_SCOPE, onChange }: { scopes: GrantableScopes; role: Role; initial?: ScopeSelection; onChange?: (value: ScopeSelection) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <ScopePicker
      scopes={scopes}
      role={role}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}
const optionsOf = (testId: string) => within(screen.getByTestId(testId)).getAllByRole("option").map((option) => option.textContent);
const choose = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

describe("ScopePicker", () => {
  it("offers a platform administrator both tenants, and the platform for the platform role only", () => {
    const { unmount } = render(<Harness scopes={GLOBAL_ADMIN_SCOPES} role="ADMIN" />);
    expect(optionsOf("scope-tenant")).toEqual(["Choose a tenant…", "Platform (every tenant)", "Alpha", "Beta"]);
    unmount();
    render(<Harness scopes={GLOBAL_ADMIN_SCOPES} role="AUTHOR" />);
    expect(optionsOf("scope-tenant")).toEqual(["Choose a tenant…", "Alpha", "Beta"]);
  });

  it("offers a tenant administrator their tenant and never the platform, even for ADMIN", () => {
    render(<Harness scopes={TENANT_ADMIN_SCOPES} role="ADMIN" />);
    expect(optionsOf("scope-tenant")).toEqual(["Choose a tenant…", "Alpha"]);
  });

  it("a tenant alone is the whole tenant; a domain and a product are asked for only once the parent is chosen, and name the place in words", () => {
    const seen = vi.fn();
    render(<Harness scopes={TENANT_ADMIN_SCOPES} role="AUTHOR" onChange={seen} />);
    expect(screen.queryByTestId("scope-domain")).toBeNull();
    expect(screen.getByTestId("scope-summary").textContent).toBe("Choose where the role applies.");

    choose("scope-tenant", "t1");
    expect(optionsOf("scope-domain")).toEqual(["Whole tenant", "Alpha Payments"]);
    expect(screen.queryByTestId("scope-product")).toBeNull();
    expect(screen.getByTestId("scope-summary").textContent).toBe("Applies to: Alpha");

    choose("scope-domain", "t1-dom");
    expect(optionsOf("scope-product")).toEqual(["Whole domain", "Checkout", "Ledger"]);
    expect(screen.getByTestId("scope-summary").textContent).toBe("Applies to: Alpha / Alpha Payments");

    choose("scope-product", "t1-checkout");
    expect(screen.getByTestId("scope-summary").textContent).toBe("Applies to: Alpha / Alpha Payments / Checkout");
    expect(seen).toHaveBeenLastCalledWith({ platform: false, tenantId: "t1", domainId: "t1-dom", productId: "t1-checkout" });
  });

  it("changing the tenant clears the domain and the product; choosing platform clears them too", () => {
    const seen = vi.fn();
    render(<Harness scopes={GLOBAL_ADMIN_SCOPES} role="ADMIN" initial={{ platform: false, tenantId: "t1", domainId: "t1-dom", productId: "t1-checkout" }} onChange={seen} />);
    choose("scope-tenant", "t2");
    expect(seen).toHaveBeenLastCalledWith({ platform: false, tenantId: "t2", domainId: "", productId: "" });
    choose("scope-tenant", "__platform__");
    expect(seen).toHaveBeenLastCalledWith({ platform: true, tenantId: "", domainId: "", productId: "" });
    expect(screen.queryByTestId("scope-domain")).toBeNull();
    expect(screen.getByTestId("scope-summary").textContent).toBe("Applies to: Platform (every tenant)");
  });

  it("every select has a visible label (accessible name)", () => {
    render(<Harness scopes={TENANT_ADMIN_SCOPES} role="AUTHOR" initial={{ platform: false, tenantId: "t1", domainId: "t1-dom", productId: "" }} />);
    expect(screen.getByLabelText("Tenant")).toBeTruthy();
    expect(screen.getByLabelText("Domain")).toBeTruthy();
    expect(screen.getByLabelText("Product")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Where the role applies" })).toBeTruthy();
  });

  it("says so when the caller may grant this role nowhere", () => {
    render(<Harness scopes={{ scopes: [], canGrantPlatform: false, truncated: false }} role="VIEWER" />);
    expect(screen.getByTestId("scope-none-offered").textContent).toBe("There is no place you may grant this role in.");
  });
});

describe("scope selection rules", () => {
  const scopes = GLOBAL_ADMIN_SCOPES.scopes;

  it("turns a choice into the ids the services take: narrowest first, with its parents; platform is no ids at all; an incomplete choice is null", () => {
    expect(selectionToInput(EMPTY_SCOPE)).toBeNull();
    expect(selectionToInput({ platform: true, tenantId: "", domainId: "", productId: "" })).toEqual({});
    expect(selectionToInput({ platform: false, tenantId: "t1", domainId: "", productId: "" })).toEqual({ tenantId: "t1" });
    expect(selectionToInput({ platform: false, tenantId: "t1", domainId: "t1-dom", productId: "" })).toEqual({ tenantId: "t1", domainId: "t1-dom" });
    expect(selectionToInput({ platform: false, tenantId: "t1", domainId: "t1-dom", productId: "t1-checkout" })).toEqual({ tenantId: "t1", domainId: "t1-dom", productId: "t1-checkout" });
    expect(selectionToInput({ platform: false, tenantId: "t1", domainId: "", productId: "t1-checkout" })).toBeNull();
  });

  it("offers only the scopes the role is accepted in", () => {
    const narrow = [...tenantScopes("t1", "Alpha", ["VIEWER"]), ...tenantScopes("t2", "Beta", ["VIEWER", "AUTHOR"])];
    expect(tenantOptions(narrow, "AUTHOR").map((s) => s.tenantId)).toEqual(["t2"]);
    expect(tenantOptions(narrow, "VIEWER").map((s) => s.tenantId)).toEqual(["t1", "t2"]);
    expect(domainOptions(narrow, "AUTHOR", "t1")).toEqual([]);
    expect(productOptions(narrow, "VIEWER", "t2-dom").map((s) => s.productName)).toEqual(["Checkout", "Ledger"]);
  });

  it("offers platform scope to a platform administrator granting ADMIN, and to nobody else", () => {
    expect(platformOffered(true, "ADMIN")).toBe(true);
    expect(platformOffered(true, "STEWARD")).toBe(false);
    expect(platformOffered(false, "ADMIN")).toBe(false);
  });

  it("clears what a role change makes invalid, narrowest first, and keeps what is still offered", () => {
    const platform: ScopeSelection = { platform: true, tenantId: "", domainId: "", productId: "" };
    expect(reconcileSelection(platform, scopes, true, "ADMIN")).toBe(platform);
    expect(reconcileSelection(platform, scopes, true, "VIEWER")).toEqual(EMPTY_SCOPE);
    expect(reconcileSelection(platform, scopes, false, "ADMIN")).toEqual(EMPTY_SCOPE);
    const narrow = [...tenantScopes("t1", "Alpha", ["VIEWER", "AUTHOR"]), { ...tenantScopes("t1", "Alpha", ["VIEWER"])[1] }];
    const product: ScopeSelection = { platform: false, tenantId: "t1", domainId: "t1-dom", productId: "t1-checkout" };
    expect(reconcileSelection(product, narrow, false, "AUTHOR")).toEqual(product);
    const onlyTenant = tenantScopes("t1", "Alpha", ["ADMIN"]).slice(0, 1);
    expect(reconcileSelection(product, onlyTenant, false, "ADMIN")).toEqual({ platform: false, tenantId: "t1", domainId: "", productId: "" });
    expect(reconcileSelection(product, onlyTenant, false, "VIEWER")).toEqual(EMPTY_SCOPE);
  });

  it("preselects the only tenant on offer (a tenant administrator of one tenant has nothing to pick), else nothing", () => {
    expect(defaultSelection(TENANT_ADMIN_SCOPES.scopes, "VIEWER")).toEqual({ platform: false, tenantId: "t1", domainId: "", productId: "" });
    expect(defaultSelection(GLOBAL_ADMIN_SCOPES.scopes, "VIEWER")).toEqual(EMPTY_SCOPE);
    expect(defaultSelection([], "VIEWER")).toEqual(EMPTY_SCOPE);
  });

  it("names the narrowest place chosen", () => {
    expect(describeSelection(scopes, EMPTY_SCOPE)).toBeNull();
    expect(describeSelection(scopes, { platform: true, tenantId: "", domainId: "", productId: "" })).toBe("Platform (every tenant)");
    expect(describeSelection(scopes, { platform: false, tenantId: "t2", domainId: "t2-dom", productId: "" })).toBe("Beta / Beta Payments");
  });
});
