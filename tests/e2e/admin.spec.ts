/**
 * The Administration pages (`/admin`): Users, Domains, Emitters, Health, Classifications and Settings, each a tab of the page.
 *
 * What each tab does (each line is a test):
 *   - Users     lists the users of the database with their status, roles (by the names of their scopes) and last sign-in (the seeded
 *               admin, a user who registers, a user the test inserts); a name is edited; a tenant-level role (COMPLIANCE_OFFICER) or a
 *               role scoped to a domain (VIEWER) is assigned from the scope pickers (no id is typed) and removed with a confirmation; a
 *               role needs a place; a duplicate is refused; the admin cannot remove their own ADMIN role (the control is disabled with
 *               the reason); a visitor without a role is turned away (invitations, disabling, reset links, the tenant administrator's
 *               and an AUTHOR's views of the screen: user-management.spec.ts);
 *   - Domains   lists the domains of the tenant being viewed (the seeded Public and Playground, the domains of the other specs), with
 *               their entity count and template status; a domain made here is a real domain: the explorer lists it (also without a
 *               reload), it is still there after one; blank, duplicate, over-long and reserved names are refused;
 *   - Emitters  lists the seeded emitter configs; the Enabled toggle is saved;
 *   - Health    shows the service statuses (the same words as GET /api/v1/health), the metrics, and runs the check again;
 *   - Classifications  lists the four system levels; adding a level and the duplicate check (KD-014: the page keeps its levels in
 *               its own state: they are gone after a reload, and Edit / Delete do nothing);
 *   - Settings  theme, font size and language: applied at once and kept after a reload (localStorage of the browser).
 *
 * NOT AVAILABLE IN THE UI (nothing was invented for it): editing or deleting a domain from the Domains tab (the service has update and
 * delete, with the system-domain protections: tests/unit/services/domain-admin.service.test.ts; the UI has neither button), editing an
 * emitter's version / format / description or its configuration, testing an emitter, deleting a user (accounts are disabled, never
 * deleted), changing a user's e-mail, a Roles column in the Domains tab, editing or deleting a classification level (KD-014).
 *
 * Page content is queried inside the center panel (`centerPanel`) and the explorer through `leftSidebar`: a hard load streams the page
 * behind its loading.tsx and Next leaves a hidden copy of the streamed segment in <body>.
 */
import type { Locator, Page } from "@playwright/test";
import { TEST_EMAIL } from "./helpers/auth-state";
import { activeTenantId, createUserRow, deleteDomainsByName, deleteUsersByEmail, disconnectDb, pg, rolesOfUser, roleRowsOfUser, tenantName, userIdByEmail } from "./helpers/db";
import { afterServerAction } from "./helpers/entity-page";
import { centerPanel, leftSidebar } from "./helpers/event-builder";
import { test, expect, unique } from "./helpers/fixtures";
import { waitForHydration } from "./helpers/hydration";
import { registerThroughTheForm, signInThroughTheForm } from "./helpers/second-user";

const ID = {
  tab: (name: string) => `admin-tab-${name}`,
  userFilter: "user-filter",
  userTable: "user-table",
  userRow: "user-row",
  roleBadge: "user-role-badge",
  panel: "user-detail-panel",
  panelClose: "user-detail-close",
  nameInput: "user-name-input",
  nameSave: "user-name-save",
  roleItem: "role-item",
  roleAddOpen: "role-add-open",
  roleAddSelect: "role-add-select",
  scopeTenant: "scope-tenant",
  scopeDomain: "scope-domain",
  roleAddSubmit: "role-add-submit",
  roleRemove: "role-remove",
  roleRemoveConfirm: "role-remove-confirm",
  roleError: "role-error",
  domainFilter: "domain-filter",
  domainRow: "domain-row",
  domainCreateOpen: "domain-create-open",
  domainDialog: "domain-create-dialog",
  domainName: "domain-create-name",
  domainDescription: "domain-create-description",
  domainSubmit: "domain-create-submit",
  domainError: "domain-create-error",
  emitterCard: "emitter-card",
  emitterToggle: "emitter-toggle",
  emitterStatus: "emitter-status",
  healthService: "health-service",
  healthUsage: "health-usage",
  healthRun: "health-run-check",
  classificationRow: "classification-row",
  classificationOpen: "classification-add-open",
  classificationName: "classification-name",
  classificationDescription: "classification-description",
  classificationCreate: "classification-create",
  classificationError: "classification-error",
  settingsPanel: "settings-panel",
  localeSelect: "locale-select",
} as const;

/** Users the tests inserted, domains and users they made through the UI: removed in `afterAll`, by their unique names. */
const createdDomains: string[] = [];
const createdUsers: string[] = [];

test.afterAll(async () => {
  try {
    await deleteDomainsByName(createdDomains);
    await deleteUsersByEmail(createdUsers);
  } catch (error) {
    console.warn(`admin.spec cleanup failed: ${String(error)}`);
  } finally {
    await disconnectDb();
  }
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

async function openUsers(page: Page): Promise<void> {
  await page.goto("/admin");
  await expect(centerPanel(page).getByRole("heading", { name: "Users", level: 2 })).toBeVisible();
  await expect(centerPanel(page).getByText("Loading users…")).toHaveCount(0);
}

/** Narrow the table to the e-mail (the table lists every user of the database), and the row of that user. */
async function userRow(page: Page, email: string): Promise<Locator> {
  await centerPanel(page).getByTestId(ID.userFilter).fill(email);
  const row = centerPanel(page).locator(`[data-testid="${ID.userRow}"][data-email="${email}"]`);
  await expect(row).toBeVisible();
  return row;
}

const panel = (page: Page): Locator => centerPanel(page).getByTestId(ID.panel);

/** Open the user's detail panel (a click on the row). */
async function openUser(page: Page, email: string): Promise<Locator> {
  await (await userRow(page, email)).click();
  await expect(panel(page)).toHaveAttribute("data-email", email);
  return panel(page);
}

/**
 * Assign a role from the open detail panel, at a scope chosen from the pickers (a tenant by its name, optionally one of its domains by name); resolves when
 * the form has been submitted (the panel then lists the role, or says why not). With no scope the pickers are left as they are.
 */
async function assignRole(page: Page, role: string, scope?: { tenantLabel: string; domainLabel?: string }): Promise<void> {
  const detail = panel(page);
  await detail.getByTestId(ID.roleAddOpen).click();
  await detail.getByTestId(ID.roleAddSelect).selectOption(role);
  if (scope) {
    await detail.getByTestId(ID.scopeTenant).selectOption({ label: scope.tenantLabel });
    if (scope.domainLabel) await detail.getByTestId(ID.scopeDomain).selectOption({ label: scope.domainLabel });
  }
  await detail.getByTestId(ID.roleAddSubmit).click();
}

test.describe("users", () => {
  test("the seeded admin is listed with its name, its status, its sign-in and its platform-level ADMIN role", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    await openUsers(page);
    const row = await userRow(page, TEST_EMAIL);

    await expect(row.getByRole("cell").nth(1)).toHaveText("Admin");
    await expect(row.getByTestId(ID.roleBadge)).toHaveText(["ADMIN(Platform)"]);
    // Email, Name, Status, Roles, Last sign-in: the status is the account's real one (the admin is active, and has signed in: the run's login set it).
    await expect(centerPanel(page).getByTestId(ID.userTable).getByRole("columnheader")).toHaveText(["Email", "Name", "Status", "Roles", "Last sign-in"]);
    await expect(row.getByTestId("user-status")).toHaveAttribute("data-status", "active");
    await expect(row.getByTestId("user-last-sign-in-cell")).not.toHaveText("Never");
  });

  // Open-mode registration signs nobody in (it answers the same to a new and to a known address) and gives the account no role (access-control Task 4): the user is
  // listed as active with nothing assigned, and what they see once they sign in themselves is the "no access yet" page (the rule itself: access-matrix.spec.ts).
  test("a user who registers is listed as active, with no roles and no name; registering signed them in nowhere, and signing in themselves lands on /no-access", { tag: ["@regression"] }, async ({
    authedPage: page,
    browser,
    baseURL,
  }) => {
    const registered = await registerThroughTheForm(browser, baseURL);
    createdUsers.push(registered.email);
    try {
      await openUsers(page);
      const row = await userRow(page, registered.email);
      await expect(row.getByRole("cell").nth(1)).toHaveText("—");
      await expect(row.getByTestId("user-status")).toHaveAttribute("data-status", "active");
      await expect(row.getByTestId(ID.roleBadge)).toHaveCount(0);

      await row.click();
      await expect(panel(page).getByText("No roles assigned")).toBeVisible();

      // The register page left them on the login page with a notice: no session. Signing in themselves takes them to the page that says they have no role.
      await registered.page.goto("/schemas");
      await expect(registered.page).toHaveURL((url) => url.pathname === "/login");
      await signInThroughTheForm(registered.page, registered.email, registered.password, "no-access");
      await expect(registered.page.getByTestId("no-access")).toBeVisible();
    } finally {
      await registered.context.close();
    }
  });

  test("a user's name is edited, saved and listed after a reload; Save waits for a change", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    const email = `${unique("e2e-name-")}@example.com`;
    createdUsers.push(email);
    const { id: userId } = await createUserRow({ email, name: "Before Rename" });

    await openUsers(page);
    const detail = await openUser(page, email);
    await expect(detail.getByTestId(ID.nameInput)).toHaveValue("Before Rename");
    await expect(detail.getByTestId(ID.nameSave)).toBeDisabled();

    await detail.getByTestId(ID.nameInput).fill("After Rename");
    await afterServerAction(page, () => detail.getByTestId(ID.nameSave).click(), { body: "After Rename" });
    await expect((await userRow(page, email)).getByRole("cell").nth(1)).toHaveText("After Rename");

    await openUsers(page);
    await expect((await userRow(page, email)).getByRole("cell").nth(1)).toHaveText("After Rename");

    // The change is in the audit trail: who made it, and the name as it was.
    const audit = await pg().query(
      `SELECT "userId", "beforeState"->>'name' AS before FROM audit_log WHERE action = 'UPDATE' AND "entityType" = 'User' AND "entityId" = $1`,
      [userId],
    );
    expect(audit.rows).toEqual([{ userId: await userIdByEmail(TEST_EMAIL), before: "Before Rename" }]);
  });

  test("a tenant-level role is assigned from the pickers, shown on the row, kept after a reload, and removed after a confirmation", { tag: ["@regression"] }, async ({
    authedPage: page,
  }) => {
    const email = `${unique("e2e-role-")}@example.com`;
    createdUsers.push(email);
    const { id } = await createUserRow({ email, name: "Role Test" });
    const tenantId = await activeTenantId();
    const tenantLabel = await tenantName(tenantId);

    await openUsers(page);
    const detail = await openUser(page, email);
    await expect(detail.getByText("No roles assigned")).toBeVisible();

    await assignRole(page, "COMPLIANCE_OFFICER", { tenantLabel });
    await expect(detail.getByTestId(ID.roleItem)).toHaveAttribute("data-role", "COMPLIANCE_OFFICER");
    await expect(detail.getByTestId(ID.roleItem)).toContainText(tenantLabel);
    await expect((await userRow(page, email)).getByTestId(ID.roleBadge)).toHaveText([`COMPLIANCE_OFFICER(${tenantLabel})`]);
    expect(await roleRowsOfUser(id)).toEqual([{ role: "COMPLIANCE_OFFICER", scopeKey: `T:${tenantId}` }]);

    await openUsers(page);
    await expect((await userRow(page, email)).getByTestId(ID.roleBadge)).toHaveText([`COMPLIANCE_OFFICER(${tenantLabel})`]);

    // Removing asks first: Cancel-ing is not offered, but nothing is removed until Confirm.
    const reopened = await openUser(page, email);
    await reopened.getByTestId(ID.roleRemove).click();
    await expect(reopened.getByTestId(ID.roleItem)).toBeVisible();
    expect(await rolesOfUser(id)).toHaveLength(1);
    await reopened.getByTestId(ID.roleRemoveConfirm).click();
    await expect(reopened.getByText("No roles assigned")).toBeVisible();
    expect(await rolesOfUser(id)).toEqual([]);

    await openUsers(page);
    await expect((await userRow(page, email)).getByTestId(ID.roleBadge)).toHaveCount(0);
  });

  test("a role needs a place, names its domain on the row once given one, and is kept after a reload; the platform is offered for ADMIN only", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const email = `${unique("e2e-domrole-")}@example.com`;
    createdUsers.push(email);
    const { id } = await createUserRow({ email });
    const tenantId = await activeTenantId();
    const tenantLabel = await tenantName(tenantId);

    await openUsers(page);
    const detail = await openUser(page, email);

    // No place chosen: the form says so and asks the server for nothing.
    await detail.getByTestId(ID.roleAddOpen).click();
    await detail.getByTestId(ID.roleAddSelect).selectOption("VIEWER");
    await expect(detail.getByTestId(ID.scopeTenant).getByRole("option", { name: "Platform (every tenant)" })).toHaveCount(0);
    // (when only one tenant exists it is preselected for the person: take it away, so the test does not depend on how many tenants the run has made)
    await detail.getByTestId(ID.scopeTenant).selectOption("");
    await detail.getByTestId(ID.roleAddSubmit).click();
    await expect(detail.getByTestId(ID.roleError)).toHaveText("Choose where the role applies.");
    expect(await rolesOfUser(id)).toEqual([]);
    // The platform scope is offered for the platform role (ADMIN) and not for the others.
    await detail.getByTestId(ID.roleAddSelect).selectOption("ADMIN");
    await expect(detail.getByTestId(ID.scopeTenant).getByRole("option", { name: "Platform (every tenant)" })).toHaveCount(1);
    await detail.getByTestId(ID.roleAddSelect).selectOption("VIEWER");

    // A domain of the tenant, chosen by its name from the list (no id is typed any more).
    await detail.getByTestId(ID.scopeTenant).selectOption({ label: tenantLabel });
    await detail.getByTestId(ID.scopeDomain).selectOption({ label: workspace.domainName });
    await detail.getByTestId(ID.roleAddSubmit).click();
    await expect(detail.getByTestId(ID.roleItem)).toHaveAttribute("data-role", "VIEWER");
    await expect(detail.getByTestId(ID.roleItem)).toContainText(workspace.domainName);
    await expect((await userRow(page, email)).getByTestId(ID.roleBadge)).toContainText(`VIEWER(${tenantLabel} / ${workspace.domainName})`);
    expect(await rolesOfUser(id)).toEqual([{ role: "VIEWER", domainId: workspace.domainId }]);

    await openUsers(page);
    await expect((await userRow(page, email)).getByTestId(ID.roleBadge)).toContainText(`VIEWER(${tenantLabel} / ${workspace.domainName})`);
  });

  test("the same role at the same place twice is refused with the service's message", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    const email = `${unique("e2e-dup-")}@example.com`;
    createdUsers.push(email);
    const { id } = await createUserRow({ email });
    const tenantId = await activeTenantId();
    const tenantLabel = await tenantName(tenantId);

    await openUsers(page);
    const detail = await openUser(page, email);

    await assignRole(page, "COMPLIANCE_OFFICER", { tenantLabel });
    await expect(detail.getByTestId(ID.roleItem)).toHaveCount(1);

    await assignRole(page, "COMPLIANCE_OFFICER", { tenantLabel });
    await expect(detail.getByTestId(ID.roleError)).toHaveText(`User already has COMPLIANCE_OFFICER role for tenant ${tenantId}`);
    await expect(detail.getByTestId(ID.roleError)).not.toContainText(/prisma|foreign key|violates|P20\d\d/i);
    await expect(detail.getByTestId(ID.roleItem)).toHaveCount(1);
    expect(await roleRowsOfUser(id)).toEqual([{ role: "COMPLIANCE_OFFICER", scopeKey: `T:${tenantId}` }]);
  });

  test("the admin cannot remove their own ADMIN role: the control is disabled with the reason, and nothing happens", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    const adminId = await userIdByEmail(TEST_EMAIL);
    await openUsers(page);
    const detail = await openUser(page, TEST_EMAIL);

    const remove = detail.getByTestId(ID.roleRemove);
    await expect(remove).toHaveAttribute("aria-disabled", "true");
    await expect(remove).toHaveAttribute("title", /your own admin role|last admin role/);
    await remove.click({ force: true });

    // No confirmation is offered, no request is made, and the role stands (the server refuses it as well: user-management.spec.ts posts it anyway).
    await expect(detail.getByTestId(ID.roleRemoveConfirm)).toHaveCount(0);
    await expect(detail.getByTestId(ID.roleItem)).toHaveAttribute("data-role", "ADMIN");
    expect(await rolesOfUser(adminId)).toContainEqual({ role: "ADMIN", domainId: null });
  });

  // Before the access-control work a signed-in visitor with no role saw each admin tab with "Requires ADMIN role"; now the dashboard answers a user with no role at the
  // door: every page, the admin ones included, is the "no access yet" page (and /api/* answers nothing: access-matrix.spec.ts).
  test("a visitor with no role is sent to /no-access from the Users, Domains, Emitters and Health tabs, and sees none of their data", { tag: ["@regression"] }, async ({
    browser,
    baseURL,
  }) => {
    const visitor = await registerThroughTheForm(browser, baseURL);
    createdUsers.push(visitor.email);
    try {
      const page = visitor.page;
      await signInThroughTheForm(page, visitor.email, visitor.password, "no-access");
      await expect(page.getByTestId("no-access-email")).toContainText(visitor.email);
      for (const path of ["/admin", "/admin/domains", "/admin/emitters", "/admin/health"]) {
        await page.goto(path);
        await expect(page).toHaveURL((url) => url.pathname === "/no-access");
        await expect(page.getByTestId("no-access")).toBeVisible();
        // No user, domain or emitter of the workspace is on the page, and the admin shell is not there.
        await expect(page.getByTestId(ID.userRow)).toHaveCount(0);
        await expect(page.getByTestId(ID.domainRow)).toHaveCount(0);
        await expect(page.getByTestId(ID.emitterCard)).toHaveCount(0);
        await expect(page.getByTestId(ID.tab("users"))).toHaveCount(0);
      }
    } finally {
      await visitor.context.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

async function openDomains(page: Page): Promise<void> {
  await page.goto("/admin/domains");
  await expect(centerPanel(page).getByRole("heading", { name: "Domains", level: 2 })).toBeVisible();
  await expect(centerPanel(page).getByText("Loading domains…")).toHaveCount(0);
}

const domainRow = (page: Page, name: string): Locator => centerPanel(page).locator(`[data-testid="${ID.domainRow}"][data-name="${name}"]`);

/** Open the create dialog, fill it, and press Create (the dialog may stay open with an error). */
async function submitDomain(page: Page, name: string, description?: string): Promise<Locator> {
  await centerPanel(page).getByTestId(ID.domainCreateOpen).click();
  const dialog = page.getByTestId(ID.domainDialog);
  await expect(dialog).toBeVisible();
  await dialog.getByTestId(ID.domainName).fill(name);
  if (description !== undefined) await dialog.getByTestId(ID.domainDescription).fill(description);
  await dialog.getByTestId(ID.domainSubmit).click();
  return dialog;
}

/** The domain in the explorer (the left sidebar). */
const explorerDomain = (page: Page, name: string): Locator => leftSidebar(page).locator('[data-testid^="domain-"]').filter({ hasText: name });

test.describe("domains", () => {
  test("the seeded system domains are listed, and so are a domain's entity count and its template status", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    await openDomains(page);

    for (const name of ["Public", "Playground"]) {
      const row = domainRow(page, name);
      await expect(row).toBeVisible();
      await expect(row.getByRole("cell").nth(1)).not.toHaveText("");
    }
    await expect(domainRow(page, "Public").getByRole("cell").nth(3)).toHaveText("No template");

    // The workspace fixture holds no entity: the count is 0. (Its domain was made in the database: the tab lists what the database holds.)
    await centerPanel(page).getByTestId(ID.domainFilter).fill(workspace.domainName);
    await expect(domainRow(page, workspace.domainName)).toBeVisible();
    await expect(domainRow(page, workspace.domainName).getByRole("cell").nth(2)).toHaveText("0");
    await expect(centerPanel(page).getByTestId(ID.domainRow)).toHaveCount(1);

    await centerPanel(page).getByTestId(ID.domainFilter).fill("no-domain-has-this-name-xyz");
    await expect(centerPanel(page).getByText("No matching domains")).toBeVisible();
  });

  test("a domain made in the admin tab is listed, is in the explorer without a reload, and is still there after one", { tag: ["@regression"] }, async ({
    authedPage: page,
  }) => {
    const name = unique("e2e-admin-dom-");
    createdDomains.push(name);

    await openDomains(page);
    await submitDomain(page, name, "Made in the admin tab");
    await expect(page.getByTestId(ID.domainDialog)).toBeHidden();

    await centerPanel(page).getByTestId(ID.domainFilter).fill(name);
    const row = domainRow(page, name);
    await expect(row).toBeVisible();
    await expect(row.getByRole("cell").nth(1)).toHaveText("Made in the admin tab");
    await expect(row.getByRole("cell").nth(2)).toHaveText("0");
    await expect(row.getByRole("cell").nth(3)).toHaveText("No template");

    // The explorer of the page that is open: no reload.
    await expect(explorerDomain(page, name)).toBeVisible();

    // A restart of the page (and, in effect, of every in-memory copy the app might have kept): the database has the domain.
    await openDomains(page);
    await centerPanel(page).getByTestId(ID.domainFilter).fill(name);
    await expect(domainRow(page, name)).toBeVisible();
    await page.goto("/schemas");
    await expect(explorerDomain(page, name)).toBeVisible();
    await expect(centerPanel(page).getByText(name).first()).toBeVisible();
    const { rows } = await pg().query(`SELECT slug, "isSystem" FROM domains WHERE name = $1`, [name]);
    expect(rows).toEqual([{ slug: name, isSystem: false }]);

    // And it is in the audit trail, made by the admin who clicked Create (the Compliance Audit Trail tab lists it from here).
    const audit = await pg().query(
      `SELECT "userId", "afterState"->>'name' AS name FROM audit_log WHERE action = 'CREATE' AND "entityType" = 'Domain' AND "afterState"->>'name' = $1`,
      [name],
    );
    expect(audit.rows).toEqual([{ userId: await userIdByEmail(TEST_EMAIL), name }]);
  });

  test("the domain's page opens from the explorer entry the admin tab made", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    const name = unique("e2e-admin-open-");
    createdDomains.push(name);
    await openDomains(page);
    await submitDomain(page, name);
    await expect(page.getByTestId(ID.domainDialog)).toBeHidden();

    await page.goto(`/schemas/${name}`);
    await expect(centerPanel(page).getByRole("heading", { name, level: 1 })).toBeVisible();
  });

  test("a blank, a duplicate (any case), an over-long and a reserved name are refused with a message, and nothing is created", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    await openDomains(page);

    const blank = await submitDomain(page, "   ");
    await expect(blank.getByTestId(ID.domainError)).toHaveText("Domain name is required");

    await blank.getByTestId(ID.domainName).fill(workspace.domainName.toUpperCase());
    await blank.getByTestId(ID.domainSubmit).click();
    await expect(blank.getByTestId(ID.domainError)).toHaveText(`A domain named "${workspace.domainName.toUpperCase()}" already exists`);

    await blank.getByTestId(ID.domainName).fill("x".repeat(65));
    await blank.getByTestId(ID.domainSubmit).click();
    await expect(blank.getByTestId(ID.domainError)).toHaveText("Domain name must be 64 characters or less");

    await blank.getByTestId(ID.domainName).fill("Type Mappings");
    await blank.getByTestId(ID.domainSubmit).click();
    await expect(blank.getByTestId(ID.domainError)).toHaveText('"type-mappings" is reserved for a schemas utility page');

    await blank.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId(ID.domainDialog)).toBeHidden();
    const { rows } = await pg().query(`SELECT count(*)::int AS n FROM domains WHERE lower(name) IN ($1, 'type mappings', $2)`, [workspace.domainName.toLowerCase(), "x".repeat(65)]);
    expect(rows[0].n).toBe(1);
  });
});

test.describe("domains with entities", () => {
  test.use({ workspaceEntities: ["CountOne", "CountTwo"] });

  test("a domain's entity count is the number of its entities", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
    await openDomains(page);
    await centerPanel(page).getByTestId(ID.domainFilter).fill(workspace.domainName);
    await expect(domainRow(page, workspace.domainName).getByRole("cell").nth(2)).toHaveText("2");
  });
});

// ---------------------------------------------------------------------------
// Emitters
// ---------------------------------------------------------------------------

async function openEmitters(page: Page): Promise<void> {
  await page.goto("/admin/emitters");
  await expect(centerPanel(page).getByRole("heading", { name: "Emitters", level: 2 })).toBeVisible();
  await expect(centerPanel(page).getByText("Loading emitters…")).toHaveCount(0);
}

const emitterCard = (page: Page, name: string): Locator => centerPanel(page).locator(`[data-testid="${ID.emitterCard}"][data-emitter="${name}"]`);

test.describe("emitters", () => {
  // The toggle test flips the SEEDED `openapi` row to Disabled for a few seconds (and puts it back in a `finally`); the list test reads
  // the same row as Enabled. Not at the same time: one worker, one after the other.
  test.describe.configure({ mode: "serial" });

  test("the seeded emitter configs are listed with their version, format and description", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    await openEmitters(page);

    for (const [name, format] of [
      ["bigquery", "SQL"],
      ["avro", "JSON"],
      ["openapi", "YAML"],
    ] as const) {
      const card = emitterCard(page, name);
      await expect(card).toBeVisible();
      await expect(card).toContainText("v1.0.0");
      await expect(card).toContainText(format);
      await expect(card.getByTestId(ID.emitterStatus)).toHaveText("Enabled");
    }
    await expect(emitterCard(page, "bigquery")).toContainText("Google BigQuery");
  });

  test("the Enabled toggle is saved: it reads Disabled after a reload, and enabling restores it", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    await openEmitters(page);
    const card = emitterCard(page, "openapi");
    try {
      await afterServerAction(page, () => card.getByTestId(ID.emitterToggle).click(), { body: "openapi" });
      await expect(card.getByTestId(ID.emitterStatus)).toHaveText("Disabled");
      await expect(card.getByTestId(ID.emitterToggle)).toHaveAttribute("aria-pressed", "false");

      await openEmitters(page);
      await expect(emitterCard(page, "openapi").getByTestId(ID.emitterStatus)).toHaveText("Disabled");
    } finally {
      // Whatever happened above, leave the seeded config as it was found.
      await pg().query(`UPDATE emitter_configs SET enabled = true WHERE "emitterName" = 'openapi'`);
    }
    await openEmitters(page);
    await expect(emitterCard(page, "openapi").getByTestId(ID.emitterStatus)).toHaveText("Enabled");
  });
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

test.describe("health", () => {
  test("it shows the three services in the words of GET /api/v1/health, and the metrics", { tag: ["@regression"] }, async ({ authedPage: page, request }) => {
    await page.goto("/admin/health");
    await expect(centerPanel(page).getByRole("heading", { name: "System Health", level: 2 })).toBeVisible();

    const services = centerPanel(page).getByTestId(ID.healthService);
    await expect(services).toHaveCount(3);
    await expect(services.first()).not.toHaveAttribute("data-status", "unhealthy");

    const response = await request.get("/api/v1/health");
    const body = (await response.json()) as { status: string; components: Record<string, { status: string; message?: string }> };
    // A database that answers in 500 ms or more is "degraded" (HTTP 200), not "unhealthy": the status code follows the words.
    expect(["healthy", "degraded"]).toContain(body.status);
    expect(response.status()).toBe(200);

    for (const key of ["database", "compiler", "emitters"] as const) {
      const card = centerPanel(page).locator(`[data-testid="${ID.healthService}"][data-service="${key}"]`);
      const shown = await card.getAttribute("data-status");
      expect(["healthy", "degraded"], `${key} on the page`).toContain(shown);
      expect(["healthy", "degraded"], `${key} in the API`).toContain(body.components[key].status);
    }
    // The compiler and emitter checks do not depend on the load of the machine: both sources agree.
    for (const key of ["compiler", "emitters"] as const) {
      await expect(centerPanel(page).locator(`[data-testid="${ID.healthService}"][data-service="${key}"]`)).toHaveAttribute("data-status", body.components[key].status);
    }
    // Each status comes with the sentence that explains it.
    const database = centerPanel(page).locator(`[data-testid="${ID.healthService}"][data-service="database"]`);
    const status = await database.getAttribute("data-status");
    await expect(database).toContainText(status === "healthy" ? /Connection OK \(\d+ms\)/ : /Slow answer \(\d+ms\)/);

    // The metrics are the database's counts: at least the seeded admin, and the two system domains.
    const value = async (metric: string) => Number((await centerPanel(page).locator(`[data-testid="${ID.healthUsage}"][data-metric="${metric}"] p`).first().innerText()).trim());
    expect(await value("Total Users")).toBeGreaterThanOrEqual(1);
    expect(await value("Total Domains")).toBeGreaterThanOrEqual(2);
    expect(Number.isInteger(await value("Total Entities"))).toBe(true);
  });

  test("'Run Health Check' asks the server again", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    await page.goto("/admin/health");
    const services = centerPanel(page).getByTestId(ID.healthService);
    await expect(services).toHaveCount(3);
    await expect(centerPanel(page).getByTestId(ID.healthRun)).toBeEnabled();

    await afterServerAction(page, () => centerPanel(page).getByTestId(ID.healthRun).click());

    await expect(centerPanel(page).getByTestId(ID.healthRun)).toBeEnabled();
    await expect(services).toHaveCount(3);
    await expect(services.first()).not.toHaveAttribute("data-status", "unhealthy");
  });
});

// ---------------------------------------------------------------------------
// Classifications
// ---------------------------------------------------------------------------

async function openClassifications(page: Page): Promise<void> {
  await page.goto("/admin/classifications");
  await expect(centerPanel(page).getByRole("heading", { name: "Classifications", level: 2 })).toBeVisible();
  await waitForHydration(centerPanel(page).getByTestId(ID.classificationOpen));
}

const classificationRow = (page: Page, name: string): Locator =>
  centerPanel(page).locator(`[data-testid="${ID.classificationRow}"][data-name="${name}"]`);

async function addClassification(page: Page, name: string, description: string): Promise<void> {
  await centerPanel(page).getByTestId(ID.classificationOpen).click();
  await centerPanel(page).getByTestId(ID.classificationName).fill(name);
  await centerPanel(page).getByTestId(ID.classificationDescription).fill(description);
  await centerPanel(page).getByTestId(ID.classificationCreate).click();
}

test.describe("classifications", () => {
  test("the four system levels are listed, marked System, and cannot be deleted", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    await openClassifications(page);

    for (const [name, description] of [
      ["PII", "Personally Identifiable Information"],
      ["SENSITIVE", "Sensitive business data"],
      ["INTERNAL", "Internal use only"],
      ["PUBLIC", "Public data"],
    ] as const) {
      const row = classificationRow(page, name);
      await expect(row).toBeVisible();
      await expect(row).toHaveAttribute("data-system", "true");
      await expect(row).toContainText(description);
      await expect(row).toContainText("System");
      await expect(row.getByTitle("Delete classification")).toHaveCount(0);
    }
  });

  test("a level is added (its name in capitals, after the system levels, deletable) and a duplicate name is refused", { tag: ["@regression"] }, async ({
    authedPage: page,
  }) => {
    await openClassifications(page);
    const name = unique("E2E").toUpperCase();

    await addClassification(page, name.toLowerCase(), "Added by the test");
    const row = classificationRow(page, name);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-system", "false");
    await expect(row).toContainText("Added by the test");
    await expect(row.getByTitle("Delete classification")).toBeVisible();
    await expect(centerPanel(page).getByTestId(ID.classificationRow).last()).toHaveAttribute("data-name", name);

    await addClassification(page, "pii", "again");
    await expect(centerPanel(page).getByTestId(ID.classificationError)).toHaveText('Classification "PII" already exists');
    await expect(classificationRow(page, "PII")).toHaveCount(1);
  });

  // KD-014: ClassificationList keeps its levels in component state, seeded from constants; the persisted levels (the service, the tRPC
  // router, the seeded rows) are never read or written by the page.
  test.fail("[KD-014 the Classifications tab keeps its levels in page state] a level that was added is still listed after a reload", { tag: ["@regression"] }, async ({
    authedPage: page,
  }) => {
    await openClassifications(page);
    const name = unique("E2E").toUpperCase();
    await addClassification(page, name, "Should be saved");
    await expect(classificationRow(page, name)).toBeVisible();

    await openClassifications(page);
    // The page has rendered after the reload (a level that is always there is listed) before the added one is expected: the pin can only
    // fail because the added level is gone.
    await expect(classificationRow(page, "PII")).toBeVisible();
    await expect(classificationRow(page, name)).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function openSettings(page: Page): Promise<void> {
  await page.goto("/admin/settings");
  await expect(centerPanel(page).getByRole("heading", { name: "Settings", level: 2 })).toBeVisible();
  await waitForHydration(centerPanel(page).getByTestId(ID.settingsPanel));
}

const html = (page: Page): Locator => page.locator("html");
const storedTheme = (page: Page) => page.evaluate(() => window.localStorage.getItem("theme"));

test.describe("settings", () => {
  test("the theme is applied at once, kept after a reload, and 'system' follows the browser's colour scheme", { tag: ["@regression"] }, async ({
    authedPage: page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await openSettings(page);
    const settings = centerPanel(page);

    await settings.getByTestId("theme-light").click();
    await expect(html(page)).toHaveClass(/\blight\b/);
    await expect(html(page)).not.toHaveClass(/\bdark\b/);
    await expect(html(page)).toHaveCSS("color-scheme", "light");
    expect(await storedTheme(page)).toBe("light");
    await expect(settings.getByTestId("theme-light")).toHaveAttribute("aria-pressed", "true");

    await openSettings(page);
    await expect(html(page)).toHaveClass(/\blight\b/);
    await expect(centerPanel(page).getByTestId("theme-light")).toHaveAttribute("aria-pressed", "true");

    await centerPanel(page).getByTestId("theme-dark").click();
    await expect(html(page)).toHaveClass(/\bdark\b/);
    await expect(html(page)).not.toHaveClass(/\blight\b/);
    expect(await storedTheme(page)).toBe("dark");

    // "System" is not a colour of its own: it is the browser's.
    await centerPanel(page).getByTestId("theme-system").click();
    await expect(html(page)).toHaveClass(/\bdark\b/);
    await page.emulateMedia({ colorScheme: "light" });
    await expect(html(page)).toHaveClass(/\blight\b/);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(html(page)).toHaveClass(/\bdark\b/);
    expect(await storedTheme(page)).toBe("system");
  });

  test("the font size changes the root's computed font size (14, 16 and 18 px) and is kept after a reload", { tag: ["@regression"] }, async ({
    authedPage: page,
  }) => {
    await openSettings(page);
    const settings = centerPanel(page);
    await expect(html(page)).toHaveCSS("font-size", "16px");
    await expect(settings.getByTestId("font-medium")).toHaveAttribute("aria-pressed", "true");

    await settings.getByTestId("font-small").click();
    await expect(html(page)).toHaveCSS("font-size", "14px");
    await expect(settings.getByTestId("font-small")).toHaveAttribute("aria-pressed", "true");

    await settings.getByTestId("font-large").click();
    await expect(html(page)).toHaveCSS("font-size", "18px");

    await openSettings(page);
    await expect(html(page)).toHaveCSS("font-size", "18px");
    await expect(centerPanel(page).getByTestId("font-large")).toHaveAttribute("aria-pressed", "true");

    await centerPanel(page).getByTestId("font-medium").click();
    await expect(html(page)).toHaveCSS("font-size", "16px");
  });

  test("the language is applied to the page and kept after a reload", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    await openSettings(page);

    await centerPanel(page).getByTestId(ID.localeSelect).click();
    await page.getByRole("option", { name: "Espanol" }).click();
    await expect(centerPanel(page).getByRole("heading", { name: "Configuracion", level: 2 })).toBeVisible();
    await expect(centerPanel(page).getByText("Apariencia", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.localStorage.getItem("super-schema:locale"))).toBe("es");

    await page.goto("/admin/settings");
    await expect(centerPanel(page).getByRole("heading", { name: "Configuracion", level: 2 })).toBeVisible();

    await centerPanel(page).getByTestId(ID.localeSelect).click();
    await page.getByRole("option", { name: "English" }).click();
    await expect(centerPanel(page).getByRole("heading", { name: "Settings", level: 2 })).toBeVisible();
  });
});
