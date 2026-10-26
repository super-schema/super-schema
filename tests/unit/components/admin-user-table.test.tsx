// @vitest-environment jsdom
/**
 * The user list and its detail panel, and the role matrix, against the answers the server actions give: real status (active, disabled, invited), roles with
 * the names of their scopes, last sign-in, a filter by text and by status, invitations revoked from their own row with a confirmation, the panel's focus
 * management, and the matrix of users by scopes. The controls inside the panel are covered in admin-user-controls.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { RoleMatrix as RoleMatrixData } from "@/types/schemas/user-admin";
import { GLOBAL_ADMIN_SCOPES, TENANT_ADMIN_SCOPES, listedInvitation, listedRole, listedUser } from "../../helpers/admin-fixtures";

const actions = vi.hoisted(() => ({
  listUsersAction: vi.fn(),
  revokeInvitationAction: vi.fn(),
  getRoleMatrixAction: vi.fn(),
  inviteUserAction: vi.fn(),
  createResetLinkAction: vi.fn(),
  setUserDisabledAction: vi.fn(),
  assignRoleAction: vi.fn(),
  removeRoleAction: vi.fn(),
  updateUserNameAction: vi.fn(),
}));
vi.mock("@/app/(dashboard)/admin/actions", () => actions);

import { RoleMatrix } from "@/components/custom/admin/RoleMatrix";
import { UserDataTable } from "@/components/custom/admin/UserDataTable";

const names = { tenant: ["t1", "Alpha"] as [string, string], domain: ["t1-dom", "Alpha Payments"] as [string, string] };
const SIGNED_IN = new Date("2026-10-20T10:30:00Z");

const alice = listedUser({ email: "alice@example.test", name: "Alice", lastLoginAt: SIGNED_IN, roles: [listedRole("AUTHOR", names), listedRole("VIEWER", { tenant: ["t1", "Alpha"] })] });
const bob = listedUser({ email: "bob@example.test", status: "disabled", roles: [listedRole("VIEWER", names)] });
const me = listedUser({ email: "root@example.test", name: "Root", isSelf: true, roles: [listedRole("ADMIN", "platform", { removeBlockedReason: "Cannot remove your own admin role" })], disableBlockedReason: "You cannot disable your own account" });
const invite = listedInvitation("new@example.test", [listedRole("STEWARD", names)]);

const answer = (items = [alice, bob, me, invite], truncated = false) => ({ success: true as const, data: { items, truncated } });

beforeEach(() => {
  vi.clearAllMocks();
  actions.listUsersAction.mockResolvedValue(answer());
});
afterEach(cleanup);

const renderTable = (scopes = TENANT_ADMIN_SCOPES) => render(<UserDataTable scopes={scopes} />);
const rows = () => screen.getAllByTestId("user-row");
const rowOf = (email: string) => rows().find((row) => row.getAttribute("data-email") === email) as HTMLElement;

describe("UserDataTable", () => {
  it("has the columns Email, Name, Status, Roles and Last sign-in", async () => {
    renderTable();
    await screen.findAllByTestId("user-row");
    expect(within(screen.getByTestId("user-table")).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Email", "Name", "Status", "Roles", "Last sign-in"]);
  });

  it("lists every person with their real status, roles by the names of their scopes, and last sign-in", async () => {
    renderTable();
    await screen.findAllByTestId("user-row");
    expect(rows().map((row) => row.getAttribute("data-email"))).toEqual(["alice@example.test", "bob@example.test", "root@example.test"]);

    const a = rowOf("alice@example.test");
    expect(within(a).getAllByRole("cell")[1].textContent).toBe("Alice");
    expect(within(a).getByTestId("user-status").getAttribute("data-status")).toBe("active");
    expect(within(a).getAllByTestId("user-role-badge").map((b) => b.textContent)).toEqual(["AUTHOR(Alpha / Alpha Payments)", "VIEWER(Alpha)"]);
    expect(within(a).getByTestId("user-last-sign-in-cell").textContent).toBe(SIGNED_IN.toLocaleString());

    const b = rowOf("bob@example.test");
    expect(within(b).getAllByRole("cell")[1].textContent).toBe("—");
    expect(within(b).getByTestId("user-status").textContent).toBe("Disabled");
    expect(within(b).getByTestId("user-last-sign-in-cell").textContent).toBe("Never");
    expect(within(rowOf("root@example.test")).getByTestId("user-role-badge").textContent).toBe("ADMIN(Platform)");
  });

  it("an invitation is a row of its own: invited, with its roles, when it expires, and a Revoke that asks first", async () => {
    actions.revokeInvitationAction.mockResolvedValue({ success: true });
    renderTable();
    const row = await screen.findByTestId("invitation-row");
    expect(row.getAttribute("data-email")).toBe("new@example.test");
    expect(within(row).getByTestId("user-status").getAttribute("data-status")).toBe("invited");
    expect(within(row).getByTestId("user-role-badge").textContent).toBe("STEWARD(Alpha / Alpha Payments)");
    expect(within(row).getByTestId("invitation-expiry").textContent).toContain(invite.expiresAt?.toLocaleString());

    fireEvent.click(within(row).getByTestId("invitation-revoke"));
    expect(actions.revokeInvitationAction).not.toHaveBeenCalled();
    actions.listUsersAction.mockResolvedValue(answer([alice, bob, me]));
    fireEvent.click(within(row).getByTestId("invitation-revoke-confirm"));
    await waitFor(() => expect(actions.revokeInvitationAction).toHaveBeenCalledWith("inv-new@example.test"));
    await waitFor(() => expect(screen.queryByTestId("invitation-row")).toBeNull());
  });

  it("shows the service's own message when a revoke is refused", async () => {
    actions.revokeInvitationAction.mockResolvedValue({ error: "Invitation not found", code: "NOT_FOUND" });
    renderTable();
    const row = await screen.findByTestId("invitation-row");
    fireEvent.click(within(row).getByTestId("invitation-revoke"));
    fireEvent.click(within(row).getByTestId("invitation-revoke-confirm"));
    expect((await screen.findByTestId("user-table-error")).textContent).toBe("Invitation not found");
  });

  it("filters by text (e-mail or name) and by status", async () => {
    renderTable();
    await screen.findAllByTestId("user-row");
    fireEvent.change(screen.getByTestId("user-filter"), { target: { value: "ALICE" } });
    expect(rows().map((r) => r.getAttribute("data-email"))).toEqual(["alice@example.test"]);
    fireEvent.change(screen.getByTestId("user-filter"), { target: { value: "" } });
    fireEvent.change(screen.getByTestId("user-status-filter"), { target: { value: "disabled" } });
    expect(rows().map((r) => r.getAttribute("data-email"))).toEqual(["bob@example.test"]);
    fireEvent.change(screen.getByTestId("user-status-filter"), { target: { value: "invited" } });
    expect(screen.queryAllByTestId("user-row")).toHaveLength(0);
    expect(screen.getAllByTestId("invitation-row")).toHaveLength(1);
    fireEvent.change(screen.getByTestId("user-filter"), { target: { value: "nobody-matches" } });
    expect(screen.getByText("No users match your filter.")).toBeTruthy();
  });

  it("shows the server's message when the list cannot be read, and says when the list is cut at its limit", async () => {
    actions.listUsersAction.mockResolvedValue({ error: "You do not have permission to do this" });
    const { unmount } = renderTable();
    expect((await screen.findByTestId("user-table-error")).textContent).toBe("You do not have permission to do this");
    unmount();
    actions.listUsersAction.mockResolvedValue(answer([alice], true));
    renderTable();
    expect((await screen.findByTestId("user-table-truncated")).textContent).toMatch(/cut at its limit/);
  });

  it("opens the person's panel from the row (a click) or from the e-mail button (the keyboard), with focus moved into it and back on Escape", async () => {
    renderTable();
    await screen.findAllByTestId("user-row");
    const open = within(rowOf("alice@example.test")).getByTestId("user-open");
    open.focus();
    fireEvent.click(open);
    const panel = screen.getByTestId("user-detail-panel");
    expect(panel.getAttribute("data-email")).toBe("alice@example.test");
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(document.activeElement).toBe(within(panel).getByRole("heading", { name: "User Details" }));
    expect(within(panel).getByTestId("user-last-sign-in").textContent).toContain(SIGNED_IN.toLocaleString());

    fireEvent.keyDown(panel, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("user-detail-panel")).toBeNull());
    expect(document.activeElement).toBe(open);
  });

  it("the panel of another person's account has the account controls enabled; your own and an out-of-reach account have them disabled for a reason", async () => {
    const outside = listedUser({ email: "outside@example.test", manageable: false, disableBlockedReason: "This account cannot be changed from here.", roles: [listedRole("VIEWER", names)] });
    actions.listUsersAction.mockResolvedValue(answer([alice, me, outside]));
    renderTable(GLOBAL_ADMIN_SCOPES);
    await screen.findAllByTestId("user-row");
    const toggle = () => within(screen.getByTestId("user-detail-panel")).getByTestId("user-status-toggle");
    const reset = () => within(screen.getByTestId("user-detail-panel")).getByTestId("user-reset-link");

    fireEvent.click(rowOf("alice@example.test"));
    expect(toggle().getAttribute("aria-disabled")).toBeNull();
    expect(reset().getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(screen.getByTestId("user-detail-close"));

    fireEvent.click(rowOf("root@example.test"));
    expect(toggle().getAttribute("aria-disabled")).toBe("true");
    expect(toggle().getAttribute("title")).toBe("You cannot disable your own account");
    expect(reset().getAttribute("aria-disabled")).toBeNull();
    expect(within(screen.getByTestId("user-detail-panel")).getByTestId("role-remove").getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByTestId("user-detail-close"));

    fireEvent.click(rowOf("outside@example.test"));
    expect(toggle().getAttribute("title")).toBe("This account cannot be changed from here.");
    expect(reset().getAttribute("aria-disabled")).toBe("true");
  });

  it("a disabled account's panel offers Enable, and no reset link until it is enabled", async () => {
    renderTable();
    await screen.findAllByTestId("user-row");
    fireEvent.click(rowOf("bob@example.test"));
    const panel = screen.getByTestId("user-detail-panel");
    expect(within(panel).getByTestId("user-status-toggle").textContent).toBe("Enable account");
    expect(within(panel).getByTestId("user-reset-link").getAttribute("title")).toBe("Enable the account before making a reset link.");
  });

  it("the panel's name is saved through the server and the list reloads; Save waits for a change", async () => {
    actions.updateUserNameAction.mockResolvedValue({ success: true, data: {} });
    renderTable();
    await screen.findAllByTestId("user-row");
    fireEvent.click(rowOf("alice@example.test"));
    expect((screen.getByTestId("user-name-save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alice B" } });
    fireEvent.click(screen.getByTestId("user-name-save"));
    await waitFor(() => expect(actions.updateUserNameAction).toHaveBeenCalledWith("u-alice@example.test", "Alice B"));
    await waitFor(() => expect(actions.listUsersAction).toHaveBeenCalledTimes(2));
  });

  it("the Invite user button opens the dialog with the places the caller may grant", async () => {
    renderTable();
    await screen.findAllByTestId("user-row");
    fireEvent.click(screen.getByTestId("invite-user-open"));
    expect(screen.getByTestId("invite-user-dialog")).toBeTruthy();
    expect(within(screen.getByTestId("scope-tenant")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose a tenant…", "Alpha"]);
  });
});

const matrix: RoleMatrixData = {
  tenantId: "t1",
  tenantName: "Alpha",
  truncated: false,
  scopes: [
    { kind: "TENANT", scopeKey: "T:t1", tenantId: "t1", tenantName: "Alpha", domainId: null, domainName: null, productId: null, productName: null, label: "Alpha", depth: 0 },
    { kind: "DOMAIN", scopeKey: "D:d1", tenantId: "t1", tenantName: "Alpha", domainId: "d1", domainName: "Payments", productId: null, productName: null, label: "Alpha / Payments", depth: 1 },
    { kind: "PRODUCT", scopeKey: "P:p1", tenantId: "t1", tenantName: "Alpha", domainId: "d1", domainName: "Payments", productId: "p1", productName: "Checkout", label: "Alpha / Payments / Checkout", depth: 2 },
  ],
  rows: [
    { userId: "u1", email: "alice@example.test", name: "Alice", status: "active", cells: { "T:t1": { direct: "VIEWER", effective: "VIEWER" }, "D:d1": { direct: "AUTHOR", effective: "AUTHOR" }, "P:p1": { direct: null, effective: "AUTHOR" } } },
    { userId: "u2", email: "bob@example.test", name: null, status: "disabled", cells: { "T:t1": { direct: null, effective: null }, "D:d1": { direct: null, effective: null }, "P:p1": { direct: "STEWARD", effective: "STEWARD" } } },
  ],
};

describe("RoleMatrix", () => {
  it("shows a row per person and a column per tenant, domain and product, with the highest role AT each scope and inherited roles marked as such", async () => {
    actions.getRoleMatrixAction.mockResolvedValue({ success: true, data: matrix });
    render(<RoleMatrix scopes={TENANT_ADMIN_SCOPES} />);
    await screen.findByTestId("role-matrix-table");
    expect(actions.getRoleMatrixAction).toHaveBeenCalledWith(undefined);
    expect(within(screen.getByTestId("role-matrix-table")).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["User", "AlphaTenant", "PaymentsDomain", "CheckoutProduct"]);

    const alice = screen.getAllByTestId("matrix-row").find((r) => r.getAttribute("data-email") === "alice@example.test") as HTMLElement;
    const cells = within(alice).getAllByTestId("matrix-cell");
    expect(within(cells[0]).getByTestId("matrix-role").textContent).toBe("Viewer");
    expect(within(cells[1]).getByTestId("matrix-role").textContent).toBe("Author");
    expect(within(cells[2]).getByTestId("matrix-inherited").textContent).toBe("Author (inherited)");

    const bob = screen.getAllByTestId("matrix-row").find((r) => r.getAttribute("data-email") === "bob@example.test") as HTMLElement;
    expect(within(bob).getByTestId("user-status").textContent).toBe("Disabled");
    expect(within(within(bob).getAllByTestId("matrix-cell")[0]).getByText("No role")).toBeTruthy();
    expect(within(within(bob).getAllByTestId("matrix-cell")[2]).getByTestId("matrix-role").textContent).toBe("Steward");
  });

  it("is a labelled table inside a keyboard-reachable named region, with row and column headers", async () => {
    actions.getRoleMatrixAction.mockResolvedValue({ success: true, data: matrix });
    render(<RoleMatrix scopes={TENANT_ADMIN_SCOPES} />);
    await screen.findByTestId("role-matrix-table");
    const region = screen.getByRole("region", { name: "Role matrix of Alpha" });
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(screen.getAllByRole("rowheader").map((h) => h.textContent)).toEqual(["alice@example.test", "bob@example.testDisabled"]);
    expect(screen.getByRole("table").querySelector("caption")?.textContent).toContain("Roles in Alpha");
  });

  it("offers a tenant select only when the caller may look at more than one tenant, and asks for the chosen one", async () => {
    actions.getRoleMatrixAction.mockResolvedValue({ success: true, data: matrix });
    const { unmount } = render(<RoleMatrix scopes={TENANT_ADMIN_SCOPES} />);
    await screen.findByTestId("role-matrix-table");
    expect(screen.queryByTestId("role-matrix-tenant")).toBeNull();
    unmount();

    render(<RoleMatrix scopes={GLOBAL_ADMIN_SCOPES} />);
    await screen.findByTestId("role-matrix-table");
    expect(within(screen.getByTestId("role-matrix-tenant")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Alpha", "Beta"]);
    fireEvent.change(screen.getByTestId("role-matrix-tenant"), { target: { value: "t2" } });
    await waitFor(() => expect(actions.getRoleMatrixAction).toHaveBeenLastCalledWith("t2"));
  });

  it("shows the server's message when the matrix cannot be read, and says when nobody holds a role yet", async () => {
    actions.getRoleMatrixAction.mockResolvedValue({ error: "Tenant not found", code: "NOT_FOUND" });
    const { unmount } = render(<RoleMatrix scopes={TENANT_ADMIN_SCOPES} />);
    expect((await screen.findByTestId("role-matrix-error")).textContent).toBe("Tenant not found");
    unmount();
    actions.getRoleMatrixAction.mockResolvedValue({ success: true, data: { ...matrix, rows: [] } });
    render(<RoleMatrix scopes={TENANT_ADMIN_SCOPES} />);
    expect(await screen.findByText("Nobody holds a role in this tenant yet.")).toBeTruthy();
  });
});
