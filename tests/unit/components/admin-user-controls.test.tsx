// @vitest-environment jsdom
/**
 * The per-user controls of the Admin screens: disable and enable with a confirmation (UserStatusToggle), the roles of a person and assigning more with the
 * scope picker (RolesEditor). A control that is unavailable stays in place, disabled FOR A REASON the person can read (the server's own sentence); the
 * service's message is shown for every refusal; the legacy raw domain-id text input is gone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { GLOBAL_ADMIN_SCOPES, TENANT_ADMIN_SCOPES, listedRole } from "../../helpers/admin-fixtures";

const actions = vi.hoisted(() => ({ setUserDisabledAction: vi.fn(), assignRoleAction: vi.fn(), removeRoleAction: vi.fn() }));
vi.mock("@/app/(dashboard)/admin/actions", () => actions);

import { RolesEditor } from "@/components/custom/admin/RolesEditor";
import { UserStatusToggle } from "@/components/custom/admin/UserStatusToggle";
import { GuardedButton } from "@/components/custom/admin/GuardedButton";

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("GuardedButton", () => {
  it("stays focusable, says it is disabled, shows the reason as its tooltip and its description, and does nothing when activated", () => {
    const onClick = vi.fn();
    render(<GuardedButton blockedReason="You cannot disable your own account" onClick={onClick}>Disable</GuardedButton>);
    const button = screen.getByRole("button", { name: "Disable" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("title")).toBe("You cannot disable your own account");
    expect(button.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(button.getAttribute("aria-describedby") as string)?.textContent).toBe("You cannot disable your own account");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("is an ordinary button when nothing blocks it", () => {
    const onClick = vi.fn();
    render(<GuardedButton blockedReason={null} onClick={onClick}>Go</GuardedButton>);
    const button = screen.getByRole("button", { name: "Go" });
    expect(button.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("UserStatusToggle", () => {
  const active = { userId: "u1", email: "bob@example.test", status: "active" as const, disableBlockedReason: null };
  const disabled = { ...active, status: "disabled" as const };

  it("disabling asks first, says what happens, and does nothing until it is confirmed", async () => {
    actions.setUserDisabledAction.mockResolvedValue({ success: true, data: {} });
    const onChanged = vi.fn();
    render(<UserStatusToggle user={active} onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId("user-status-toggle"));
    const dialog = screen.getByTestId("user-status-dialog");
    expect(within(dialog).getByRole("heading", { name: "Disable this account?" })).toBeTruthy();
    expect(dialog.textContent).toContain("signed out on their next request");
    expect(dialog.textContent).toContain("bob@example.test");
    expect(actions.setUserDisabledAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("user-status-confirm"));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(actions.setUserDisabledAction).toHaveBeenCalledWith("u1", true);
    await waitFor(() => expect(screen.queryByTestId("user-status-dialog")).toBeNull());
  });

  it("enabling is a confirmation too, and sends enabled (false)", async () => {
    actions.setUserDisabledAction.mockResolvedValue({ success: true, data: {} });
    render(<UserStatusToggle user={disabled} />);
    expect(screen.getByTestId("user-status-toggle").textContent).toBe("Enable account");
    fireEvent.click(screen.getByTestId("user-status-toggle"));
    expect(screen.getByRole("heading", { name: "Enable this account?" })).toBeTruthy();
    fireEvent.click(screen.getByTestId("user-status-confirm"));
    await waitFor(() => expect(actions.setUserDisabledAction).toHaveBeenCalledWith("u1", false));
  });

  it("cancelling changes nothing", () => {
    render(<UserStatusToggle user={active} />);
    fireEvent.click(screen.getByTestId("user-status-toggle"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(actions.setUserDisabledAction).not.toHaveBeenCalled();
  });

  it("shows the service's own message when it refuses, and keeps the dialog open", async () => {
    actions.setUserDisabledAction.mockResolvedValue({ error: "Cannot disable the last platform administrator: at least one must stay enabled", code: "FORBIDDEN" });
    render(<UserStatusToggle user={active} />);
    fireEvent.click(screen.getByTestId("user-status-toggle"));
    fireEvent.click(screen.getByTestId("user-status-confirm"));
    expect((await screen.findByTestId("user-status-error")).textContent).toBe("Cannot disable the last platform administrator: at least one must stay enabled");
    expect(screen.getByTestId("user-status-dialog")).toBeTruthy();
  });

  it.each([
    "You cannot disable your own account",
    "Cannot disable the last platform administrator: at least one must stay enabled",
    "This account cannot be changed from here.",
  ])("an account that cannot be changed (%s): the control is disabled with that reason and opens no dialog", (reason) => {
    render(<UserStatusToggle user={{ ...active, disableBlockedReason: reason }} />);
    const toggle = screen.getByTestId("user-status-toggle");
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    expect(toggle.getAttribute("title")).toBe(reason);
    fireEvent.click(toggle);
    expect(screen.queryByTestId("user-status-dialog")).toBeNull();
    expect(actions.setUserDisabledAction).not.toHaveBeenCalled();
  });
});

describe("RolesEditor", () => {
  const names = { tenant: ["t1", "Alpha"] as [string, string], domain: ["t1-dom", "Alpha Payments"] as [string, string] };

  it("lists each role with the names of its scope, a platform role as Platform, and says so when there is none", () => {
    const { unmount } = render(<RolesEditor userId="u1" roles={[]} scopes={TENANT_ADMIN_SCOPES} />);
    expect(screen.getByText("No roles assigned")).toBeTruthy();
    unmount();
    render(<RolesEditor userId="u1" roles={[listedRole("AUTHOR", names), listedRole("ADMIN", "platform")]} scopes={GLOBAL_ADMIN_SCOPES} />);
    const items = screen.getAllByTestId("role-item");
    expect(items.map((item) => item.getAttribute("data-role"))).toEqual(["AUTHOR", "ADMIN"]);
    expect(within(items[0]).getByTestId("role-scope").textContent).toBe("Alpha / Alpha Payments");
    // (the item itself carries the ids the end-to-end tests read)
    expect(items[0].getAttribute("data-domain-id")).toBe("t1-dom");
    expect(within(items[1]).getByTestId("role-scope").textContent).toBe("Platform");
  });

  it("has no raw domain-id text input any more: the place is chosen from lists", () => {
    render(<RolesEditor userId="u1" roles={[]} scopes={TENANT_ADMIN_SCOPES} />);
    fireEvent.click(screen.getByTestId("role-add-open"));
    expect(screen.queryByTestId("role-add-domain")).toBeNull();
    expect(screen.queryByPlaceholderText("Domain ID")).toBeNull();
    expect(screen.getByTestId("scope-tenant")).toBeTruthy();
  });

  it("assigns a role at the chosen scope: ids as the service takes them, then the list reloads", async () => {
    actions.assignRoleAction.mockResolvedValue({ success: true, data: {} });
    const onChanged = vi.fn();
    render(<RolesEditor userId="u1" roles={[]} scopes={GLOBAL_ADMIN_SCOPES} onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId("role-add-open"));
    fireEvent.change(screen.getByTestId("role-add-select"), { target: { value: "STEWARD" } });
    fireEvent.change(screen.getByTestId("scope-tenant"), { target: { value: "t2" } });
    fireEvent.change(screen.getByTestId("scope-domain"), { target: { value: "t2-dom" } });
    fireEvent.change(screen.getByTestId("scope-product"), { target: { value: "t2-ledger" } });
    fireEvent.click(screen.getByTestId("role-add-submit"));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(actions.assignRoleAction).toHaveBeenCalledWith({ userId: "u1", role: "STEWARD", tenantId: "t2", domainId: "t2-dom", productId: "t2-ledger" });
    expect(screen.queryByTestId("role-add-form")).toBeNull();
  });

  it("the platform scope is offered to a platform administrator and only for ADMIN; a tenant administrator never gets it", () => {
    const { unmount } = render(<RolesEditor userId="u1" roles={[]} scopes={GLOBAL_ADMIN_SCOPES} />);
    fireEvent.click(screen.getByTestId("role-add-open"));
    const tenantOptions = () => within(screen.getByTestId("scope-tenant")).getAllByRole("option").map((o) => o.textContent);
    expect(tenantOptions()).not.toContain("Platform (every tenant)");
    fireEvent.change(screen.getByTestId("role-add-select"), { target: { value: "ADMIN" } });
    expect(tenantOptions()).toContain("Platform (every tenant)");
    fireEvent.change(screen.getByTestId("role-add-select"), { target: { value: "COMPLIANCE_OFFICER" } });
    expect(tenantOptions()).not.toContain("Platform (every tenant)");
    unmount();

    render(<RolesEditor userId="u1" roles={[]} scopes={TENANT_ADMIN_SCOPES} />);
    fireEvent.click(screen.getByTestId("role-add-open"));
    fireEvent.change(screen.getByTestId("role-add-select"), { target: { value: "ADMIN" } });
    expect(tenantOptions()).toEqual(["Choose a tenant…", "Alpha"]);
  });

  it("a role change clears a platform choice the new role cannot take", () => {
    render(<RolesEditor userId="u1" roles={[]} scopes={GLOBAL_ADMIN_SCOPES} />);
    fireEvent.click(screen.getByTestId("role-add-open"));
    fireEvent.change(screen.getByTestId("role-add-select"), { target: { value: "ADMIN" } });
    fireEvent.change(screen.getByTestId("scope-tenant"), { target: { value: "__platform__" } });
    expect(screen.getByTestId("scope-summary").textContent).toContain("Platform");
    fireEvent.change(screen.getByTestId("role-add-select"), { target: { value: "VIEWER" } });
    expect((screen.getByTestId("scope-tenant") as HTMLSelectElement).value).toBe("");
  });

  it("asks where the role applies before calling the server, and shows the service's own message for a refusal", async () => {
    render(<RolesEditor userId="u1" roles={[]} scopes={TENANT_ADMIN_SCOPES} />);
    fireEvent.click(screen.getByTestId("role-add-open"));
    // (a tenant administrator of one tenant has it preselected: take it away to see the question)
    fireEvent.change(screen.getByTestId("scope-tenant"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("role-add-submit"));
    expect(screen.getByTestId("role-error").textContent).toBe("Choose where the role applies.");
    expect(actions.assignRoleAction).not.toHaveBeenCalled();

    actions.assignRoleAction.mockResolvedValue({ error: "User already has VIEWER role for tenant t1" });
    fireEvent.change(screen.getByTestId("scope-tenant"), { target: { value: "t1" } });
    fireEvent.click(screen.getByTestId("role-add-submit"));
    expect((await screen.findByTestId("role-error")).textContent).toBe("User already has VIEWER role for tenant t1");
    expect(screen.getByTestId("role-add-form")).toBeTruthy();
  });

  it("removing asks first, calls the server only when confirmed, then reloads", async () => {
    actions.removeRoleAction.mockResolvedValue({ success: true });
    const onChanged = vi.fn();
    render(<RolesEditor userId="u1" roles={[listedRole("AUTHOR", names)]} scopes={TENANT_ADMIN_SCOPES} onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId("role-remove"));
    expect(actions.removeRoleAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("role-remove-confirm"));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(actions.removeRoleAction).toHaveBeenCalledWith("role-AUTHOR-D:t1-dom");
  });

  it("a role the server would refuse to remove is disabled with the server's reason: your own administrator role, the last platform administrator's", () => {
    const own = listedRole("ADMIN", "platform", { removeBlockedReason: "Cannot remove your own admin role" });
    const last = listedRole("ADMIN", names, { id: "role-2", removeBlockedReason: "Cannot remove the last admin role — at least one admin must remain" });
    render(<RolesEditor userId="u1" roles={[own, last]} scopes={GLOBAL_ADMIN_SCOPES} />);
    const buttons = screen.getAllByTestId("role-remove");
    expect(buttons.map((b) => b.getAttribute("aria-disabled"))).toEqual(["true", "true"]);
    expect(buttons.map((b) => b.getAttribute("title"))).toEqual(["Cannot remove your own admin role", "Cannot remove the last admin role — at least one admin must remain"]);
    fireEvent.click(buttons[0]);
    expect(screen.queryByTestId("role-remove-confirm")).toBeNull();
    expect(actions.removeRoleAction).not.toHaveBeenCalled();
  });

  it("shows the service's own message when a removal is refused after all (a race the screen could not know)", async () => {
    actions.removeRoleAction.mockResolvedValue({ error: "Cannot remove the last admin role — at least one admin must remain" });
    render(<RolesEditor userId="u1" roles={[listedRole("ADMIN", "platform")]} scopes={GLOBAL_ADMIN_SCOPES} />);
    fireEvent.click(screen.getByTestId("role-remove"));
    fireEvent.click(screen.getByTestId("role-remove-confirm"));
    expect((await screen.findByTestId("role-error")).textContent).toBe("Cannot remove the last admin role — at least one admin must remain");
    expect(screen.getByTestId("role-item")).toBeTruthy();
  });

  it("while the places load roles can be read but none added", () => {
    render(<RolesEditor userId="u1" roles={[listedRole("AUTHOR", names)]} scopes={null} />);
    expect((screen.getByTestId("role-add-open") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByTestId("role-item")).toHaveLength(1);
  });
});
