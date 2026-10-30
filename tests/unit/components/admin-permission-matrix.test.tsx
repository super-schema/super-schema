// @vitest-environment jsdom
/**
 * The permissions matrix of the Admin Users screen, end to end through the components (the server actions are stand-ins that answer as the services do for each
 * person): a platform administrator, a tenant administrator, a domain-scoped administrator, an AUTHOR and a person with no role. What each is SHOWN:
 *  - the platform administrator: the Users screen, both tenants in every picker, platform scope for ADMIN;
 *  - the tenant administrator: the Users screen, their tenant only, no platform scope, no platform tab;
 *  - the domain-scoped administrator, the AUTHOR, the person with no role: the no-permission screen, and the Users page is never rendered, so it asks the
 *    server for nothing (no action is called).
 */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { adminCapabilities } from "@/lib/access/capabilities";
import type { Assignment } from "@/lib/access";
import { assign } from "../../helpers/access-mocks";
import { GLOBAL_ADMIN_SCOPES, TENANT_ADMIN_SCOPES, listedRole, listedUser } from "../../helpers/admin-fixtures";

const nav = vi.hoisted(() => ({ pathname: "/admin" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname, useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: { href: string; children: ReactNode }) => <a href={href} {...props}>{children}</a> }));

const actions = vi.hoisted(() => ({
  getGrantableScopesAction: vi.fn(),
  listUsersAction: vi.fn(),
  getRoleMatrixAction: vi.fn(),
  inviteUserAction: vi.fn(),
  revokeInvitationAction: vi.fn(),
  createResetLinkAction: vi.fn(),
  setUserDisabledAction: vi.fn(),
  assignRoleAction: vi.fn(),
  removeRoleAction: vi.fn(),
  updateUserNameAction: vi.fn(),
}));
vi.mock("@/app/(dashboard)/admin/actions", () => actions);

import { AdminShell } from "@/components/custom/admin/AdminShell";
import AdminUsersPage from "@/app/(dashboard)/admin/page";

const T = "t1";
type Persona = { who: string; assignments: Assignment[]; scopes: typeof GLOBAL_ADMIN_SCOPES | null; sees: "users" | "no-permission"; tabs: string[] };
const PERSONAS: Persona[] = [
  { who: "a platform administrator", assignments: [assign.global()], scopes: GLOBAL_ADMIN_SCOPES, sees: "users", tabs: ["settings", "users", "domains", "emitters", "health", "classifications", "ai"] },
  { who: "a tenant administrator", assignments: [assign.tenant("ADMIN", T)], scopes: TENANT_ADMIN_SCOPES, sees: "users", tabs: ["settings", "users", "domains"] },
  { who: "a domain-scoped administrator", assignments: [assign.domain("ADMIN", T, "dom-a")], scopes: null, sees: "no-permission", tabs: ["settings"] },
  { who: "an AUTHOR", assignments: [assign.tenant("AUTHOR", T)], scopes: null, sees: "no-permission", tabs: ["settings"] },
  { who: "a person with no role", assignments: [], scopes: null, sees: "no-permission", tabs: ["settings"] },
];

beforeEach(() => {
  vi.clearAllMocks();
  nav.pathname = "/admin";
  actions.listUsersAction.mockResolvedValue({ success: true, data: { items: [listedUser({ email: "someone@example.test", roles: [listedRole("VIEWER", { tenant: ["t1", "Alpha"] })] })], truncated: false } });
  actions.getRoleMatrixAction.mockResolvedValue({ error: "unused" });
});
afterEach(cleanup);

describe.each(PERSONAS)("$who on /admin", ({ assignments, scopes, sees, tabs }) => {
  beforeEach(() => {
    actions.getGrantableScopesAction.mockResolvedValue(scopes ? { success: true, data: scopes } : { error: "You do not have permission to do this", code: "FORBIDDEN" });
    render(
      <AdminShell capabilities={adminCapabilities(assignments, T)}>
        <AdminUsersPage />
      </AdminShell>
    );
  });

  it("is shown the tabs they may use, and the right screen", async () => {
    expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("data-testid")?.replace("admin-tab-", ""))).toEqual(tabs);
    if (sees === "users") {
      expect(await screen.findByTestId("user-table")).toBeTruthy();
      expect(screen.queryByTestId("admin-no-permission")).toBeNull();
    } else {
      expect(screen.getByTestId("admin-no-permission")).toBeTruthy();
      expect(screen.queryByTestId("user-table")).toBeNull();
    }
  });

  it(sees === "users" ? "may invite, into the places they administer and no others" : "asks the server for nothing: no action is called", async () => {
    if (sees === "no-permission") {
      for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled();
      return;
    }
    await screen.findByTestId("user-table");
    await waitFor(() => expect(actions.getGrantableScopesAction).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("invite-user-open"));
    const tenantSelect = screen.getByTestId("scope-tenant");
    fireEvent.change(screen.getByTestId("invite-role"), { target: { value: "ADMIN" } });
    const options = within(tenantSelect).getAllByRole("option").map((o) => o.textContent);
    if (assignments[0].scope.kind === "GLOBAL") expect(options).toEqual(["Choose a tenant…", "Platform (every tenant)", "Alpha", "Beta"]);
    else expect(options).toEqual(["Choose a tenant…", "Alpha"]);
  });
});
