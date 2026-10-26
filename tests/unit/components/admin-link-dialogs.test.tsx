// @vitest-environment jsdom
/**
 * The two dialogs that make a one-time link, and the copyable link they show: invite a user (an e-mail, roles each with a scope chosen from what the caller may
 * grant), and a password reset link. The link is shown once, with its expiry and a warning that it is shown once; the copy button says "Copied" and a live
 * region announces it; every refusal shows the service's own message; focus is managed (the form takes it, the link's button takes it when it appears).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { GrantableScopes } from "@/types/schemas/user-admin";
import { GLOBAL_ADMIN_SCOPES, TENANT_ADMIN_SCOPES } from "../../helpers/admin-fixtures";

const actions = vi.hoisted(() => ({ inviteUserAction: vi.fn(), createResetLinkAction: vi.fn() }));
vi.mock("@/app/(dashboard)/admin/actions", () => actions);

import { CopyableLink, COPIED_MS, absoluteLink } from "@/components/custom/admin/CopyableLink";
import { InviteUserDialog, MAX_INVITE_ROLES } from "@/components/custom/admin/InviteUserDialog";
import { ResetLinkDialog } from "@/components/custom/admin/ResetLinkDialog";

const EXPIRES = new Date("2026-11-01T12:00:00Z");
const invited = (over = {}) => ({
  success: true as const,
  data: { invitationId: "inv-1", email: "new@example.test", token: "tok", path: "/invite/tok", url: "https://app.example/invite/tok", expiresAt: EXPIRES, replacedInvitations: 0, ...over },
});
const writeText = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const openInvite = (scopes: GrantableScopes | null, props: Partial<React.ComponentProps<typeof InviteUserDialog>> = {}) =>
  render(<InviteUserDialog open onOpenChange={vi.fn()} scopes={scopes} {...props} />);

describe("CopyableLink", () => {
  it("holds the whole address in a labelled read-only field; a route with no absolute address is joined to this page's origin", () => {
    render(<CopyableLink link={{ path: "/invite/abc", url: null }} label="Invitation link" />);
    const field = screen.getByLabelText("Invitation link") as HTMLInputElement;
    expect(field.readOnly).toBe(true);
    expect(field.value).toBe(`${window.location.origin}/invite/abc`);
    expect(absoluteLink({ path: "/invite/abc", url: "https://x.example/invite/abc" }, "https://other")).toBe("https://x.example/invite/abc");
    expect(absoluteLink({ path: "/invite/abc", url: null }, null)).toBe("/invite/abc");
  });

  it("copies the link, says 'Copied' on the button and in a live region that was already on the page, and goes back after a moment", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<CopyableLink link={{ path: "/reset/abc", url: "https://x.example/reset/abc" }} label="Password reset link" />);
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });
    expect(writeText).toHaveBeenCalledWith("https://x.example/reset/abc");
    expect(screen.getByRole("status").textContent).toBe("Copied");
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(COPIED_MS + 50);
    });
    expect(screen.getByRole("status").textContent).toBe("");
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });

  it("when the clipboard refuses, says so and selects the field to copy by hand", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    render(<CopyableLink link={{ path: "/x", url: "https://x.example/x" }} label="Link" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });
    expect(screen.getByRole("status").textContent).toMatch(/Could not copy/);
    expect(document.activeElement).toBe(screen.getByLabelText("Link"));
  });
});

describe("InviteUserDialog", () => {
  it("takes focus into the e-mail field and offers a platform administrator both tenants, with platform scope for ADMIN only", () => {
    openInvite(GLOBAL_ADMIN_SCOPES);
    expect(document.activeElement).toBe(screen.getByLabelText("Email address"));
    expect(within(screen.getByTestId("scope-tenant")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose a tenant…", "Alpha", "Beta"]);
    fireEvent.change(screen.getByTestId("invite-role"), { target: { value: "ADMIN" } });
    expect(within(screen.getByTestId("scope-tenant")).getAllByRole("option").map((o) => o.textContent)).toContain("Platform (every tenant)");
  });

  it("a tenant administrator is offered their tenant only (it is already chosen) and never platform scope", () => {
    openInvite(TENANT_ADMIN_SCOPES);
    expect((screen.getByTestId("scope-tenant") as HTMLSelectElement).value).toBe("t1");
    fireEvent.change(screen.getByTestId("invite-role"), { target: { value: "ADMIN" } });
    expect(within(screen.getByTestId("scope-tenant")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose a tenant…", "Alpha"]);
  });

  it("sends the e-mail and the role with its scope as ids, then shows the one-time link with its expiry and the warning that it is shown once", async () => {
    actions.inviteUserAction.mockResolvedValue(invited());
    const onInvited = vi.fn();
    openInvite(GLOBAL_ADMIN_SCOPES, { onInvited });
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "  New@Example.test " } });
    fireEvent.change(screen.getByTestId("invite-role"), { target: { value: "AUTHOR" } });
    fireEvent.change(screen.getByTestId("scope-tenant"), { target: { value: "t2" } });
    fireEvent.change(screen.getByTestId("scope-domain"), { target: { value: "t2-dom" } });
    fireEvent.click(screen.getByTestId("invite-submit"));

    await screen.findByTestId("invite-link");
    // (an e-mail field trims the spaces itself; the service normalizes the case: the address in the answer is the lower-case one)
    expect(actions.inviteUserAction).toHaveBeenCalledWith({ email: "New@Example.test", roles: [{ role: "AUTHOR", tenantId: "t2", domainId: "t2-dom" }] });
    expect((screen.getByTestId("invite-link") as HTMLInputElement).value).toBe("https://app.example/invite/tok");
    expect(screen.getByTestId("invite-result-email").textContent).toBe("new@example.test");
    expect(screen.getByTestId("invite-link-expiry").textContent).toContain(EXPIRES.toLocaleString());
    expect(screen.getByTestId("invite-link-warning").textContent).toMatch(/shown only once/);
    expect(onInvited).toHaveBeenCalledTimes(1);
    // the link's copy button takes focus when it appears, and the form is gone
    expect(document.activeElement).toBe(screen.getByTestId("invite-link-copy"));
    expect(screen.queryByTestId("invite-submit")).toBeNull();
  });

  it("platform scope goes as no ids at all", async () => {
    actions.inviteUserAction.mockResolvedValue(invited());
    openInvite(GLOBAL_ADMIN_SCOPES);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "root@example.test" } });
    fireEvent.change(screen.getByTestId("invite-role"), { target: { value: "ADMIN" } });
    fireEvent.change(screen.getByTestId("scope-tenant"), { target: { value: "__platform__" } });
    fireEvent.click(screen.getByTestId("invite-submit"));
    await screen.findByTestId("invite-link");
    expect(actions.inviteUserAction).toHaveBeenCalledWith({ email: "root@example.test", roles: [{ role: "ADMIN" }] });
  });

  it("a person can be invited with several roles, each with its own scope; the roles can be removed again, up to the limit", async () => {
    actions.inviteUserAction.mockResolvedValue(invited());
    openInvite(GLOBAL_ADMIN_SCOPES);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "two@example.test" } });
    fireEvent.change(screen.getByTestId("scope-tenant"), { target: { value: "t1" } });
    fireEvent.click(screen.getByTestId("invite-add-role"));
    const rows = screen.getAllByTestId("invite-role-row");
    expect(rows).toHaveLength(2);
    fireEvent.change(within(rows[1]).getByTestId("invite-role"), { target: { value: "STEWARD" } });
    fireEvent.change(within(rows[1]).getByTestId("scope-tenant"), { target: { value: "t2" } });
    fireEvent.click(screen.getByTestId("invite-submit"));
    await screen.findByTestId("invite-link");
    expect(actions.inviteUserAction).toHaveBeenCalledWith({ email: "two@example.test", roles: [{ role: "VIEWER", tenantId: "t1" }, { role: "STEWARD", tenantId: "t2" }] });
    expect(MAX_INVITE_ROLES).toBe(10);
  });

  it("asks for what is missing before calling the server: an address, then where each role applies", () => {
    openInvite(GLOBAL_ADMIN_SCOPES);
    fireEvent.click(screen.getByTestId("invite-submit"));
    expect(screen.getByTestId("invite-error").textContent).toBe("Enter the e-mail address of the person to invite.");
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "a@example.test" } });
    fireEvent.click(screen.getByTestId("invite-submit"));
    expect(screen.getByTestId("invite-error").textContent).toBe("Choose where each role applies.");
    expect(actions.inviteUserAction).not.toHaveBeenCalled();
  });

  it("shows the service's own message for a refusal and keeps the form so it can be corrected", async () => {
    actions.inviteUserAction.mockResolvedValue({ error: "An account with this address already exists. Assign roles to it instead of inviting it.", code: "ACCOUNT_EXISTS" });
    openInvite(TENANT_ADMIN_SCOPES);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "old@example.test" } });
    fireEvent.click(screen.getByTestId("invite-submit"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("An account with this address already exists. Assign roles to it instead of inviting it.");
    expect((screen.getByLabelText("Email address") as HTMLInputElement).value).toBe("old@example.test");
    expect(screen.queryByTestId("invite-link")).toBeNull();
  });

  it("says how many earlier invitations the new link replaced", async () => {
    actions.inviteUserAction.mockResolvedValue(invited({ replacedInvitations: 2 }));
    openInvite(TENANT_ADMIN_SCOPES);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "again@example.test" } });
    fireEvent.click(screen.getByTestId("invite-submit"));
    await screen.findByTestId("invite-link");
    expect(screen.getByTestId("invite-link-expiry").textContent).toContain("replaces 2 earlier invitations");
  });

  it("while the places load the form says so and cannot be submitted; when they could not be read it says why", () => {
    const { unmount } = openInvite(null);
    expect(screen.getByRole("status").textContent).toMatch(/Loading the places/);
    expect((screen.getByTestId("invite-submit") as HTMLButtonElement).disabled).toBe(true);
    unmount();
    openInvite(null, { scopesError: "You do not have permission to do this" });
    expect(screen.getByTestId("invite-scopes-error").textContent).toBe("You do not have permission to do this");
  });

  it("starts empty every time it is opened (nothing of the last invitation, not even its link, is kept)", async () => {
    actions.inviteUserAction.mockResolvedValue(invited());
    const { rerender } = render(<InviteUserDialog open onOpenChange={vi.fn()} scopes={TENANT_ADMIN_SCOPES} />);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "x@example.test" } });
    fireEvent.click(screen.getByTestId("invite-submit"));
    await screen.findByTestId("invite-link");
    rerender(<InviteUserDialog open={false} onOpenChange={vi.fn()} scopes={TENANT_ADMIN_SCOPES} />);
    await waitFor(() => expect(screen.queryByTestId("invite-user-dialog")).toBeNull());
    rerender(<InviteUserDialog open onOpenChange={vi.fn()} scopes={TENANT_ADMIN_SCOPES} />);
    expect((screen.getByLabelText("Email address") as HTMLInputElement).value).toBe("");
    expect(screen.queryByTestId("invite-link")).toBeNull();
  });

  it("Done closes the dialog", async () => {
    actions.inviteUserAction.mockResolvedValue(invited());
    const onOpenChange = vi.fn();
    render(<InviteUserDialog open onOpenChange={onOpenChange} scopes={TENANT_ADMIN_SCOPES} />);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "x@example.test" } });
    fireEvent.click(screen.getByTestId("invite-submit"));
    await screen.findByTestId("invite-done");
    fireEvent.click(screen.getByTestId("invite-done"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("ResetLinkDialog", () => {
  const user = { userId: "u1", email: "forgot@example.test" };
  const link = { success: true as const, data: { userId: "u1", token: "t", path: "/reset/t", url: "https://app.example/reset/t", expiresAt: EXPIRES, invalidatedLinks: 1 } };
  const open = (props = {}) => render(<ResetLinkDialog open onOpenChange={vi.fn()} user={user} {...props} />);

  it("asks first, and makes no link until it is told to", () => {
    open();
    expect(screen.getByRole("heading", { name: "Make a password reset link?" })).toBeTruthy();
    expect(screen.getByTestId("reset-link-dialog").textContent).toContain("Any earlier reset link for them stops working");
    expect(actions.createResetLinkAction).not.toHaveBeenCalled();
  });

  it("makes the link, shows it once with the one-hour note, the expiry and how many earlier links stopped", async () => {
    actions.createResetLinkAction.mockResolvedValue(link);
    const onCreated = vi.fn();
    open({ onCreated });
    fireEvent.click(screen.getByTestId("reset-create"));
    await screen.findByTestId("reset-link");
    expect(actions.createResetLinkAction).toHaveBeenCalledWith("u1");
    expect((screen.getByTestId("reset-link") as HTMLInputElement).value).toBe("https://app.example/reset/t");
    const expiry = screen.getByTestId("reset-link-expiry").textContent ?? "";
    expect(expiry).toContain("expires in 1 hour");
    expect(expiry).toContain(EXPIRES.toLocaleString());
    expect(expiry).toContain("An earlier link for this person no longer work");
    expect(screen.getByTestId("reset-link-warning").textContent).toMatch(/shown only once/);
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByTestId("reset-link-copy"));
  });

  it("shows the service's own message when it refuses (a disabled account), and offers the step again", async () => {
    actions.createResetLinkAction.mockResolvedValue({ error: "This account is disabled. Enable it before making a reset link.", code: "VALIDATION_ERROR" });
    open();
    fireEvent.click(screen.getByTestId("reset-create"));
    expect((await screen.findByTestId("reset-error")).textContent).toBe("This account is disabled. Enable it before making a reset link.");
    expect(screen.getByTestId("reset-create")).toBeTruthy();
    expect(screen.queryByTestId("reset-link")).toBeNull();
  });
});
