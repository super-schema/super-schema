/**
 * User management as an administrator does it (`/admin`, the Users tab), end to end, with the INVITE flow (no second-user helper that registers a role-less
 * visitor): there is no e-mail service, so the administrator copies a one-time link and hands it over, and the person opens it in a browser of their own.
 *
 * What each test is:
 *   - an invitation made in the dialog (a tenant and a domain chosen from the lists, a role) is opened in a fresh browser context; the person sets a name and a
 *     password, is signed in, and sees only the domain they were given: a sibling domain is absent from the explorer and its entity's address is a not-found;
 *   - the administrator disables the person, whose NEXT request is refused (the explorer is gone, the API answers nothing); a disabled account cannot be given a
 *     reset link; enabled again, a reset link lets the person choose a new password and sign in with it (the old one stops working);
 *   - a pending invitation is revoked from its row after a confirmation, and its link then shows the one "not valid" card every dead link shows;
 *   - the last platform administrator cannot be disabled and keeps the platform role: the controls are disabled with the reason, and the SERVER refuses the same
 *     acts when they are POSTed anyway (the page's own server actions, sent again with the administrator's own id);
 *   - a tenant administrator is shown their tenant's people and places only (the platform tabs are absent, the pickers offer one tenant), an AUTHOR has no Admin
 *     link and the no-permission screen on /admin, and the role matrix lists a person by the scope they hold a role at.
 *
 * What it leaves behind: every tenant, domain, entity and role a test made goes in `finally` (the tenant's cascade). An account that accepted an invitation or
 * used a reset link wrote an audit entry that points at it, and audit rows are immutable, so such an account cannot be deleted (a DELETE of it fails and takes
 * the others in its statement with it): those e-mail addresses are kept apart and left, as in auth.spec.ts; the run's database is thrown away.
 */
import { test, expect, unique } from "./helpers/fixtures";
import { TEST_EMAIL } from "./helpers/auth-state";
import {
  accountOf,
  createInvitationRow,
  createIsolatedWorkspaceRows,
  createSiblingDomainRows,
  createUserRow,
  createUserWithPassword,
  deleteInvitationsByEmail,
  deleteIsolatedWorkspaceRows,
  deleteUsersByEmail,
  disconnectDb,
  grantScopedRoleRow,
  pg,
  roleRowsOfUser,
  tenantName,
  userIdByEmail,
  type IsolatedWorkspaceRows,
} from "./helpers/db";
import { centerPanel, leftSidebar } from "./helpers/event-builder";
import { waitForHydration } from "./helpers/hydration";
import {
  captureAction,
  fillNewPassword,
  freshContext,
  inviteViaDialog,
  invitationRowOf,
  openUserPanel,
  openUsersPage,
  pathOf,
  replayAction,
  signInThroughLoginPage,
  userPanel,
  userRowOf,
} from "./helpers/admin-users";

const INVALID_LINK = "This link is not valid or has expired.";
const GOOD_PASSWORD = "tangerine-lantern-orbit-42";
const NEW_PASSWORD = "marble-window-harvest-77";

/** Accounts a test made that can be deleted (they never acted: no audit entry points at them). */
const deletable: string[] = [];
/** Accounts that accepted an invitation or used a reset link: their audit entries pin them (see the header). */
const pinned: string[] = [];
/** Addresses a test made an invitation for. */
const invited: string[] = [];

test.afterAll(async () => {
  try {
    await deleteInvitationsByEmail([...invited, ...pinned]);
    await deleteUsersByEmail(deletable);
  } catch (error) {
    console.warn(`user-management.spec cleanup failed for ${deletable.join(", ")}: ${String(error)}`);
  } finally {
    await disconnectDb();
  }
});

/** A tenant of the test's own with a domain (with an entity, Customer) and a sibling domain (with an entity, Invoice): removed afterwards, with everything under it. */
async function withWorld<T>(body: (world: { rows: IsolatedWorkspaceRows; tenantLabel: string; sibling: Awaited<ReturnType<typeof createSiblingDomainRows>> }) => Promise<T>): Promise<T> {
  const rows = await createIsolatedWorkspaceRows();
  try {
    const sibling = await createSiblingDomainRows(rows.tenantId);
    return await body({ rows, tenantLabel: await tenantName(rows.tenantId), sibling });
  } finally {
    await deleteIsolatedWorkspaceRows(rows);
  }
}

const dashboardUrl = (url: URL) => url.pathname === "/schemas";

test.describe("invitations", () => {
  test("an invitation made on the Users screen is opened in a fresh browser: the person sets a name and a password and sees only the domain they were given", { tag: ["@regression"] }, async ({
    authedPage: page,
    browser,
    baseURL,
  }) => {
    test.setTimeout(240_000);
    const email = `${unique("e2e-invitee-")}@example.com`.toLowerCase();
    pinned.push(email);
    await withWorld(async ({ rows, tenantLabel, sibling }) => {
      await openUsersPage(page);
      const { link, dialog } = await inviteViaDialog(page, { email, role: "AUTHOR", tenantLabel, domainLabel: rows.domain.name });

      // The link is shown once, with when it expires and a plain warning; it is a real one-time link.
      expect(new URL(link).pathname).toMatch(/^\/invite\/[A-Za-z0-9_-]{20,}$/);
      await expect(dialog.getByTestId("invite-link-expiry")).toContainText("expires");
      await expect(dialog.getByTestId("invite-link-warning")).toContainText("shown only once");
      await expect(dialog.getByTestId("invite-link-copy")).toBeFocused();
      expect(await pg().query(`SELECT 1 FROM invitations WHERE "emailLower" = $1 AND "usedAt" IS NULL`, [email])).toHaveProperty("rowCount", 1);
      await dialog.getByTestId("invite-done").click();
      await expect(dialog).toHaveCount(0);

      // The pending invitation is on the list, as an invited row naming the scope it grants.
      const pending = await invitationRowOf(page, email);
      await expect(pending.getByTestId("user-status")).toHaveAttribute("data-status", "invited");
      await expect(pending.getByTestId("user-role-badge")).toContainText(`AUTHOR(${tenantLabel} / ${rows.domain.name})`);

      const context = await freshContext(browser, baseURL);
      try {
        const invitee = await context.newPage();
        await invitee.goto(pathOf(link));
        await waitForHydration(invitee.getByTestId("invite-form"));
        await expect(invitee.getByTestId("invite-email")).toHaveValue(email);
        await invitee.getByTestId("invite-name").fill("Invited Person");
        await fillNewPassword(invitee, GOOD_PASSWORD);
        await invitee.getByTestId("invite-submit").click();
        await expect(invitee).toHaveURL(dashboardUrl, { timeout: 60_000 });

        // Signed in with the role the invitation carried, at the scope it named, and nothing else.
        const id = await userIdByEmail(email);
        expect(await roleRowsOfUser(id)).toEqual([{ role: "AUTHOR", scopeKey: `D:${rows.domain.id}` }]);
        await expect(leftSidebar(invitee).getByTestId("enterprise")).toBeVisible({ timeout: 30_000 });
        await expect(leftSidebar(invitee).getByTestId(`domain-${rows.domain.id}`)).toBeVisible();
        await expect(leftSidebar(invitee).getByTestId(`domain-${sibling.domain.id}`)).toHaveCount(0);
        await expect(centerPanel(invitee).getByText(sibling.domain.name)).toHaveCount(0);

        // The sibling domain's entity is not found at its address, and is not leaked by the not-found page.
        await invitee.goto(sibling.entity.url);
        await expect(invitee.getByTestId("dashboard-not-found")).toBeVisible();
        await expect(invitee.getByText(sibling.entity.name, { exact: true })).toHaveCount(0);
        // Their own domain's entity opens.
        await invitee.goto(`/schemas/${rows.domain.slug}/${rows.product.slug}/${rows.entity.slug}`);
        await expect(centerPanel(invitee).getByRole("heading", { level: 1, name: rows.entity.name })).toBeVisible({ timeout: 30_000 });

        // No Admin link (an AUTHOR administers nothing), and /admin says so instead of showing an empty shell.
        await expect(invitee.getByTestId("nav-admin")).toHaveCount(0);
        await expect(invitee.getByTestId("topbar-admin")).toHaveCount(0);
        await invitee.goto("/admin");
        await expect(invitee.getByTestId("admin-no-permission")).toBeVisible();
        await expect(invitee.getByTestId("user-table")).toHaveCount(0);

        // The link has been used: the same card as for any dead link, for a visitor who is signed in as nobody (a browser of its own: the invitee's
        // session is still being refreshed in theirs, and a signed-in visitor is sent to /schemas before the page is asked).
        const visitorContext = await freshContext(browser, baseURL);
        try {
          const again = await visitorContext.newPage();
          await again.goto(pathOf(link));
          await expect(again.getByTestId("invalid-link")).toBeVisible();
          await expect(again.getByText(INVALID_LINK)).toBeVisible();
        } finally {
          await visitorContext.close();
        }
      } finally {
        await context.close();
      }
    });
  });

  test("the administrator revokes a pending invitation after a confirmation, and its link then shows the one 'not valid' card", { tag: ["@regression"] }, async ({
    authedPage: page,
    browser,
    baseURL,
  }) => {
    test.setTimeout(180_000);
    const email = `${unique("e2e-revoked-")}@example.com`.toLowerCase();
    invited.push(email);
    await withWorld(async ({ rows }) => {
      const { token } = await createInvitationRow({ email, createdById: await userIdByEmail(TEST_EMAIL), roles: [{ role: "VIEWER", scopeKey: `T:${rows.tenantId}` }] });

      // While it is live, the link opens the form.
      const context = await freshContext(browser, baseURL);
      try {
        const visitor = await context.newPage();
        await visitor.goto(`/invite/${token}`);
        await expect(visitor.getByTestId("invite-form")).toBeVisible();

        await openUsersPage(page);
        const row = await invitationRowOf(page, email);
        await row.getByTestId("invitation-revoke").click();
        // Asked first: nothing is revoked until it is confirmed.
        await expect(row.getByTestId("invitation-revoke-confirm")).toBeVisible();
        expect(await pg().query(`SELECT 1 FROM invitations WHERE "emailLower" = $1`, [email])).toHaveProperty("rowCount", 1);
        await row.getByTestId("invitation-revoke-confirm").click();
        await expect(centerPanel(page).locator(`[data-testid="invitation-row"][data-email="${email}"]`)).toHaveCount(0);
        expect(await pg().query(`SELECT 1 FROM invitations WHERE "emailLower" = $1`, [email])).toHaveProperty("rowCount", 0);

        // The revoke is in the audit trail, in the tenant the invitation was for, and carries no address and no token.
        const audit = await pg().query(`SELECT "tenantId", "beforeState"::text AS before, "afterState"::text AS after FROM audit_log WHERE action = 'INVITATION_REVOKED' AND "tenantId" = $1`, [rows.tenantId]);
        expect(audit.rowCount).toBe(1);
        expect(`${audit.rows[0].before}${audit.rows[0].after}`).not.toContain(email);
        expect(`${audit.rows[0].before}${audit.rows[0].after}`).not.toContain(token);

        // The link is dead: the card every dead link shows, and no form.
        await visitor.goto(`/invite/${token}`);
        await expect(visitor.getByTestId("invalid-link")).toBeVisible();
        await expect(visitor.getByText(INVALID_LINK)).toBeVisible();
        await expect(visitor.locator("form")).toHaveCount(0);
      } finally {
        await context.close();
      }
    });
  });
});

test.describe("accounts", () => {
  test("disabling a person refuses their NEXT request; a disabled account gets no reset link; enabled again, a reset link lets them choose a new password and sign in", { tag: ["@regression"] }, async ({
    authedPage: page,
    browser,
    baseURL,
  }) => {
    test.setTimeout(300_000);
    const email = `${unique("e2e-disable-")}@example.com`.toLowerCase();
    pinned.push(email);
    await withWorld(async ({ rows }) => {
      const person = await createUserWithPassword({ email, password: GOOD_PASSWORD, name: "Soon Disabled" });
      await grantScopedRoleRow(person.id, "AUTHOR", { tenantId: rows.tenantId, domainId: rows.domain.id });

      const context = await freshContext(browser, baseURL);
      try {
        const user = await context.newPage();
        await signInThroughLoginPage(user, email, GOOD_PASSWORD);
        await expect(leftSidebar(user).getByTestId("enterprise")).toBeVisible({ timeout: 30_000 });
        expect((await context.request.get("/api/tenants")).ok()).toBe(true);

        // The administrator finds them: active, with the sign-in that just happened.
        await openUsersPage(page);
        const row = await userRowOf(page, email);
        await expect(row.getByTestId("user-status")).toHaveAttribute("data-status", "active");
        await expect(row.getByTestId("user-last-sign-in-cell")).not.toHaveText("Never");
        const panel = await openUserPanel(page, email);

        // Disabling asks first, and says what happens.
        await panel.getByTestId("user-status-toggle").click();
        const dialog = page.getByTestId("user-status-dialog");
        await expect(dialog).toContainText("signed out on their next request");
        expect((await accountOf(email))?.disabled).toBe(false);
        await dialog.getByTestId("user-status-confirm").click();
        await expect(dialog).toHaveCount(0);
        await expect(await userRowOf(page, email)).toHaveAttribute("data-status", "disabled");
        expect((await accountOf(email))?.disabled).toBe(true);

        // Their next request is refused: the dashboard is gone for them and so is the API; no session of theirs works any more.
        await user.goto("/schemas");
        await expect(user).toHaveURL((url) => url.pathname === "/no-access" || url.pathname === "/login", { timeout: 30_000 });
        await expect(user.getByTestId("topbar")).toHaveCount(0);
        expect((await context.request.get("/api/tenants")).ok()).toBe(false);
        const refusedLogin = await freshContext(browser, baseURL);
        try {
          const attempt = await refusedLogin.newPage();
          await attempt.goto("/login");
          await waitForHydration(attempt.getByTestId("login-form"));
          await attempt.getByLabel("Email", { exact: true }).fill(email);
          await attempt.getByLabel("Password", { exact: true }).fill(GOOD_PASSWORD);
          await attempt.getByTestId("login-submit").click();
          await expect(attempt.getByTestId("login-error")).toHaveText("Invalid email or password");
        } finally {
          await refusedLogin.close();
        }

        // A disabled account gets no reset link: the control says why, and the dialog is not offered.
        const disabledPanel = await openUserPanel(page, email);
        const reset = disabledPanel.getByTestId("user-reset-link");
        await expect(reset).toHaveAttribute("aria-disabled", "true");
        await expect(reset).toHaveAttribute("title", "Enable the account before making a reset link.");
        // (`force`: Playwright does not click what is aria-disabled; a person can, and nothing must happen)
        await reset.click({ force: true });
        await expect(page.getByTestId("reset-link-dialog")).toHaveCount(0);

        // Enabled again (with a confirmation), the account is active and the person is let in on their next request.
        await disabledPanel.getByTestId("user-status-toggle").click();
        await expect(page.getByTestId("user-status-dialog")).toContainText("can sign in again");
        await page.getByTestId("user-status-confirm").click();
        await expect(page.getByTestId("user-status-dialog")).toHaveCount(0);
        await expect(await userRowOf(page, email)).toHaveAttribute("data-status", "active");
        await user.goto("/schemas");
        await expect(leftSidebar(user).getByTestId("enterprise")).toBeVisible({ timeout: 30_000 });

        // A reset link: asked for first, one hour, shown once, copyable.
        const activePanel = await openUserPanel(page, email);
        await activePanel.getByTestId("user-reset-link").click();
        const resetDialog = page.getByTestId("reset-link-dialog");
        await expect(resetDialog).toContainText("Any earlier reset link for them stops working");
        await resetDialog.getByTestId("reset-create").click();
        const resetLink = await resetDialog.getByTestId("reset-link").inputValue();
        expect(new URL(resetLink).pathname).toMatch(/^\/reset\//);
        await expect(resetDialog.getByTestId("reset-link-expiry")).toContainText("expires in 1 hour");
        await expect(resetDialog.getByTestId("reset-link-warning")).toContainText("shown only once");
        await resetDialog.getByTestId("reset-done").click();
        await expect(resetDialog).toHaveCount(0);
        const audit = await pg().query(`SELECT "beforeState"::text AS before, "afterState"::text AS after FROM audit_log WHERE action = 'PASSWORD_RESET_ISSUED' AND "entityId" = $1`, [person.id]);
        expect(audit.rowCount).toBe(1);
        expect(`${audit.rows[0].before}${audit.rows[0].after}`).not.toContain(new URL(resetLink).pathname.split("/").pop());

        // The person opens it in a browser of their own and chooses a new password; nobody is signed in by it.
        const resetting = await freshContext(browser, baseURL);
        try {
          const visitor = await resetting.newPage();
          await visitor.goto(pathOf(resetLink));
          await waitForHydration(visitor.getByTestId("reset-form"));
          await fillNewPassword(visitor, NEW_PASSWORD);
          await visitor.getByTestId("reset-submit").click();
          await expect(visitor).toHaveURL((url) => url.pathname === "/login", { timeout: 60_000 });
          await expect(visitor.getByTestId("login-notice")).toContainText("Your password was changed");

          // The old password no longer works, the new one does, and the roles the person held are still theirs.
          await waitForHydration(visitor.getByTestId("login-form"));
          await visitor.getByLabel("Email", { exact: true }).fill(email);
          await visitor.getByLabel("Password", { exact: true }).fill(GOOD_PASSWORD);
          await visitor.getByTestId("login-submit").click();
          await expect(visitor.getByTestId("login-error")).toHaveText("Invalid email or password");
          await visitor.getByLabel("Password", { exact: true }).fill(NEW_PASSWORD);
          await visitor.getByTestId("login-submit").click();
          await expect(visitor).toHaveURL(dashboardUrl, { timeout: 60_000 });
          await expect(leftSidebar(visitor).getByTestId(`domain-${rows.domain.id}`)).toBeVisible({ timeout: 30_000 });

          // The link has been used: dead.
          const dead = await freshContext(browser, baseURL);
          try {
            const deadPage = await dead.newPage();
            await deadPage.goto(pathOf(resetLink));
            await expect(deadPage.getByTestId("invalid-link")).toBeVisible();
          } finally {
            await dead.close();
          }
        } finally {
          await resetting.close();
        }
      } finally {
        await context.close();
      }
    });
  });

  test("the last platform administrator cannot be disabled and keeps the platform role: the controls say why, and the server refuses the same acts when they are posted anyway", { tag: ["@regression"] }, async ({
    authedPage: page,
  }) => {
    test.setTimeout(240_000);
    const throwaway = `${unique("e2e-throwaway-")}@example.com`.toLowerCase();
    deletable.push(throwaway);
    await withWorld(async ({ rows }) => {
      const adminId = await userIdByEmail(TEST_EMAIL);
      const person = await createUserRow({ email: throwaway, name: "Throwaway" });
      await grantScopedRoleRow(person.id, "VIEWER", { tenantId: rows.tenantId });

      await openUsersPage(page);
      const mine = await openUserPanel(page, TEST_EMAIL);

      // The controls are disabled, for a reason a person can read; activating them does nothing.
      const toggle = mine.getByTestId("user-status-toggle");
      await expect(toggle).toHaveAttribute("aria-disabled", "true");
      await expect(toggle).toHaveAttribute("title", /last platform administrator|your own account/);
      await toggle.click({ force: true });
      await expect(page.getByTestId("user-status-dialog")).toHaveCount(0);
      const ownAdminRole = mine.locator('[data-testid="role-item"][data-role="ADMIN"]', { hasText: "Platform" });
      const remove = ownAdminRole.getByTestId("role-remove");
      await expect(remove).toHaveAttribute("aria-disabled", "true");
      await expect(remove).toHaveAttribute("title", /last admin role|your own admin role/);
      await remove.click({ force: true });
      await expect(ownAdminRole.getByTestId("role-remove-confirm")).toHaveCount(0);

      // The page's own server actions, taken from a harmless use on the throwaway account and sent again with the administrator's own ids.
      const throwawayPanel = await openUserPanel(page, throwaway);
      const disable = await captureAction(page, async () => {
        await throwawayPanel.getByTestId("user-status-toggle").click();
        await page.getByTestId("user-status-confirm").click();
      }, person.id);
      await expect(await userRowOf(page, throwaway)).toHaveAttribute("data-status", "disabled");

      const roleOfThrowaway = (await pg().query(`SELECT id FROM user_roles WHERE "userId" = $1`, [person.id])).rows[0].id as string;
      const removeCall = await captureAction(page, async () => {
        const panel = await openUserPanel(page, throwaway);
        await panel.getByTestId("role-remove").click();
        await panel.getByTestId("role-remove-confirm").click();
      }, roleOfThrowaway);
      await expect(userPanel(page).getByText("No roles assigned")).toBeVisible();

      const selfDisable = await replayAction(page, disable, disable.body.replace(person.id, adminId));
      expect(selfDisable.text).toContain("You cannot disable your own account");
      const adminRoleId = (await pg().query(`SELECT id FROM user_roles WHERE "userId" = $1 AND "scopeKey" = 'G'`, [adminId])).rows[0].id as string;
      const selfRemove = await replayAction(page, removeCall, removeCall.body.replace(roleOfThrowaway, adminRoleId));
      expect(selfRemove.text).toMatch(/Cannot remove (your own admin role|the last admin role)/);

      // Nothing changed: the administrator is enabled and still holds the platform role.
      expect((await accountOf(TEST_EMAIL))?.disabled).toBe(false);
      expect(await roleRowsOfUser(adminId)).toContainEqual({ role: "ADMIN", scopeKey: "G" });
    });
  });
});

test.describe("who sees what", () => {
  test("a tenant administrator is shown their tenant's people and places only, with no platform tab", { tag: ["@regression"] }, async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const stamp = unique("e2e-tadmin-");
    const adminEmail = `${stamp}-admin@example.com`.toLowerCase();
    const memberEmail = `${stamp}-member@example.com`.toLowerCase();
    const outsiderEmail = `${stamp}-outsider@example.com`.toLowerCase();
    deletable.push(adminEmail, memberEmail, outsiderEmail);
    await withWorld(async ({ rows, tenantLabel }) => {
      const other = await createIsolatedWorkspaceRows();
      try {
        const otherLabel = await tenantName(other.tenantId);
        const tenantAdmin = await createUserWithPassword({ email: adminEmail, password: GOOD_PASSWORD });
        await grantScopedRoleRow(tenantAdmin.id, "ADMIN", { tenantId: rows.tenantId });
        const member = await createUserRow({ email: memberEmail });
        await grantScopedRoleRow(member.id, "AUTHOR", { tenantId: rows.tenantId, domainId: rows.domain.id });
        const outsider = await createUserRow({ email: outsiderEmail });
        await grantScopedRoleRow(outsider.id, "VIEWER", { tenantId: other.tenantId });

        const context = await freshContext(browser, baseURL);
        try {
          const page = await context.newPage();
          await signInThroughLoginPage(page, adminEmail, GOOD_PASSWORD);
          await expect(page.getByTestId("nav-admin")).toBeVisible();
          await expect(page.getByTestId("topbar-admin")).toBeVisible();
          await openUsersPage(page);

          // The tabs: the tenant's own, no platform ones.
          for (const id of ["settings", "users", "domains"]) await expect(page.getByTestId(`admin-tab-${id}`)).toBeVisible();
          for (const id of ["emitters", "health", "classifications"]) await expect(page.getByTestId(`admin-tab-${id}`)).toHaveCount(0);

          // The people: their tenant's, with the scope each holds, and nobody of the other tenant.
          await expect(await userRowOf(page, memberEmail)).toBeVisible();
          await expect((await userRowOf(page, memberEmail)).getByTestId("user-role-badge")).toContainText(`AUTHOR(${tenantLabel} / ${rows.domain.name})`);
          await centerPanel(page).getByTestId("user-filter").fill(outsiderEmail);
          await expect(centerPanel(page).getByText("No users match your filter.")).toBeVisible();
          await centerPanel(page).getByTestId("user-filter").fill("");
          await expect(centerPanel(page).getByText(otherLabel)).toHaveCount(0);

          // The places: the invitation dialog offers their tenant and no other, and never the platform.
          await centerPanel(page).getByTestId("invite-user-open").click();
          const dialog = page.getByTestId("invite-user-dialog");
          await dialog.getByTestId("invite-role").selectOption("ADMIN");
          const tenants = dialog.getByTestId("scope-tenant").getByRole("option");
          await expect(tenants).toHaveText(["Choose a tenant…", tenantLabel]);
          await expect(dialog.getByTestId("scope-tenant")).toHaveValue(rows.tenantId);
          await page.keyboard.press("Escape");
          await expect(dialog).toHaveCount(0);

          // The role matrix: their tenant, the member's role in the domain's column.
          await centerPanel(page).getByTestId("admin-view-matrix").click();
          const matrix = centerPanel(page).getByTestId("role-matrix-table");
          await expect(matrix).toBeVisible();
          await expect(centerPanel(page).getByTestId("role-matrix-tenant")).toHaveCount(0);
          const memberRow = matrix.locator(`[data-testid="matrix-row"][data-email="${memberEmail}"]`);
          await expect(memberRow.locator(`[data-testid="matrix-cell"][data-scope-key="D:${rows.domain.id}"]`).getByTestId("matrix-role")).toHaveText("Author");
          await expect(memberRow.locator(`[data-testid="matrix-cell"][data-scope-key="T:${rows.tenantId}"]`)).toContainText("No role");
          await expect(matrix.locator(`[data-testid="matrix-row"][data-email="${outsiderEmail}"]`)).toHaveCount(0);

          // A platform tab typed into the address bar is the no-permission screen, and the admin of the platform is not them.
          await page.goto("/admin/emitters");
          await expect(page.getByTestId("admin-no-permission")).toBeVisible();
        } finally {
          await context.close();
        }
      } finally {
        await deleteIsolatedWorkspaceRows(other);
      }
    });
  });

  test("an AUTHOR has no Admin link, and /admin is the no-permission screen with their own settings still reachable", { tag: ["@regression"] }, async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    const email = `${unique("e2e-author-")}@example.com`.toLowerCase();
    deletable.push(email);
    await withWorld(async ({ rows }) => {
      const author = await createUserWithPassword({ email, password: GOOD_PASSWORD });
      await grantScopedRoleRow(author.id, "AUTHOR", { tenantId: rows.tenantId });
      const context = await freshContext(browser, baseURL);
      try {
        const page = await context.newPage();
        await signInThroughLoginPage(page, email, GOOD_PASSWORD);
        await expect(page.getByTestId("topbar")).toBeVisible();
        await expect(page.getByTestId("nav-schemas")).toBeVisible();
        await expect(page.getByTestId("nav-admin")).toHaveCount(0);
        await expect(page.getByTestId("topbar-admin")).toHaveCount(0);

        await page.goto("/admin");
        await expect(page.getByTestId("admin-no-permission")).toBeVisible();
        await expect(page.getByRole("heading", { name: "You do not have permission to use this page" })).toBeVisible();
        await expect(page.getByTestId("user-table")).toHaveCount(0);
        // Only personal settings are theirs.
        await expect(page.getByTestId("admin-tab-settings")).toBeVisible();
        for (const id of ["users", "domains", "emitters", "health", "classifications"]) await expect(page.getByTestId(`admin-tab-${id}`)).toHaveCount(0);
        await page.getByRole("link", { name: "Go to your settings" }).click();
        await expect(page).toHaveURL((url) => url.pathname === "/admin/settings");
        await expect(centerPanel(page).getByRole("heading", { name: "Settings", level: 2 })).toBeVisible();
      } finally {
        await context.close();
      }
    });
  });
});
