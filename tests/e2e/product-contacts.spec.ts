/**
 * Product contacts E2E (events-completion WP-C): a product page's "Edit contacts" dialog.
 *
 * A product with no contacts gets an Engineering Lead, a Manager and team addresses through the dialog; the header shows them as
 * mailto links and a reload keeps them. Editing again opens prefilled, changes the lead and the team addresses and keeps the
 * manager. An invalid address keeps the dialog open with the field's message. Clearing a field really clears it. None of this
 * touches the product's other fields (the breadcrumb still names the product).
 *
 * The domain and the product are fixtures (helpers/db.ts); `deleteNavFixtures` removes them in `afterAll`. The tests share the
 * one product and build on each other, so they run serially.
 *
 * PREREQS: see helpers/auth.ts and helpers/db.ts (PostgreSQL provider, seeded admin, app on :3000).
 *
 * NOT RUN by the work package that wrote it (no Playwright in that worktree): if a step fails on a locator, adjust the `ID`
 * table below, not the flow.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./helpers/auth";
import { createNavFixtures, deleteNavFixtures, disconnectDb, type NavFixtures } from "./helpers/db";

// First visits compile routes in dev.
test.use({ navigationTimeout: 60_000, actionTimeout: 30_000, screenshot: "only-on-failure", trace: "retain-on-failure" });

/** Test ids (EditProductContactsDialog, ProductContactFields, MailboxChipInput, ProductContacts) and the toast copy. */
const ID = {
  editButton: "edit-product-contacts",
  dialog: "edit-product-contacts-dialog",
  save: "edit-product-contacts-save",
  cancel: "edit-product-contacts-cancel",
  formError: "edit-product-contacts-error",
  lead: "product-engineering-lead-input",
  leadError: "product-engineering-lead-error",
  manager: "product-manager-input",
  team: "product-team-emails-input",
  teamChip: "product-team-emails-chip",
  teamRemove: "product-team-emails-remove",
  contacts: "product-contacts",
  shownLead: "product-contact-engineering-lead",
  shownManager: "product-contact-manager",
  shownTeam: "product-contact-team",
  toast: "Contacts updated",
};

let fixtures: NavFixtures | undefined;

test.beforeAll(async () => {
  fixtures = await createNavFixtures();
});

test.afterAll(async () => {
  try {
    await deleteNavFixtures(fixtures);
  } finally {
    await disconnectDb();
  }
});

const need = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`${what} fixture was not created`);
  return value;
};

/*
 * Page content is queried inside the center panel: a hard load (`goto` / `reload`) streams the page behind its loading.tsx and
 * Next leaves the streamed segment's hidden copy in <body>, so a bare `page.getByTestId(...)` can resolve to two elements and trip
 * strict mode. The dialog and the toast render in portals outside the center panel and are queried on `page`.
 */
const centerPanel = (page: Page): Locator => page.getByTestId("center-panel");

const dialogOf = (page: Page): Locator => page.getByTestId(ID.dialog);

const productUrl = () => {
  const f = need(fixtures, "navigation");
  return `/schemas/${f.domain.slug}/${f.product.slug}`;
};

async function openProduct(page: Page): Promise<void> {
  await page.goto(productUrl());
  await expect(centerPanel(page).getByTestId(ID.editButton)).toBeVisible();
}

/** Click Edit contacts and wait for the dialog. */
async function openDialog(page: Page): Promise<Locator> {
  await centerPanel(page).getByTestId(ID.editButton).click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Save and wait until the dialog is gone and the success toast has shown. */
async function saveAndClose(page: Page, dialog: Locator): Promise<void> {
  await dialog.getByTestId(ID.save).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(ID.toast).first()).toBeVisible();
}

/** Type an address into the team chip input and commit it with Enter. */
async function addTeamAddress(dialog: Locator, address: string): Promise<void> {
  const input = dialog.getByTestId(ID.team);
  await input.fill(address);
  await input.press("Enter");
}

test.describe("edit a product's contacts", () => {
  test.describe.configure({ mode: "serial" });

  test("a product without contacts shows none; the dialog adds a lead, a manager and team addresses, and a reload keeps them", async ({ authedPage: page }) => {
    await openProduct(page);
    const main = centerPanel(page);
    await expect(main.getByTestId(ID.contacts)).toHaveCount(0);

    const dialog = await openDialog(page);
    await expect(dialog.getByTestId(ID.lead)).toHaveValue("");
    await expect(dialog.getByTestId(ID.manager)).toHaveValue("");
    await expect(dialog.getByTestId(ID.teamChip)).toHaveCount(0);

    await dialog.getByTestId(ID.lead).fill("Jane Doe <jane@acme.com>");
    await dialog.getByTestId(ID.manager).fill("mo@acme.com");
    await addTeamAddress(dialog, "platform@acme.com");
    await addTeamAddress(dialog, "oncall@acme.com");
    await expect(dialog.getByTestId(ID.teamChip)).toHaveCount(2);
    await saveAndClose(page, dialog);

    // The page refreshes in place.
    await expect(main.getByTestId(ID.shownLead).getByRole("link", { name: "Jane Doe" })).toHaveAttribute("href", "mailto:jane@acme.com");

    await page.reload();
    await expect(main.getByTestId(ID.shownLead).getByRole("link", { name: "Jane Doe" })).toHaveAttribute("href", "mailto:jane@acme.com");
    await expect(main.getByTestId(ID.shownManager).getByRole("link", { name: "mo@acme.com" })).toBeVisible();
    await expect(main.getByTestId(ID.shownTeam).getByRole("link", { name: "platform@acme.com" })).toBeVisible();
    await expect(main.getByTestId(ID.shownTeam).getByRole("link", { name: "oncall@acme.com" })).toBeVisible();
  });

  test("Edit contacts opens prefilled; changing the lead and the team addresses saves them, keeps the manager, and a reload shows them", async ({ authedPage: page }) => {
    const f = need(fixtures, "navigation");
    await openProduct(page);
    const main = centerPanel(page);

    const dialog = await openDialog(page);
    await expect(dialog.getByTestId(ID.lead)).toHaveValue("Jane Doe <jane@acme.com>");
    await expect(dialog.getByTestId(ID.manager)).toHaveValue("mo@acme.com");
    await expect(dialog.getByTestId(ID.teamChip)).toHaveCount(2);

    await dialog.getByTestId(ID.lead).fill('  "Jane Doe"   <jane.doe@acme.com> '); // saved in its canonical form
    await dialog.getByRole("button", { name: "Remove oncall@acme.com" }).click();
    await addTeamAddress(dialog, "ops@acme.com");
    await saveAndClose(page, dialog);

    await page.reload();
    const lead = main.getByTestId(ID.shownLead);
    await expect(lead.getByRole("link", { name: "Jane Doe" })).toHaveAttribute("href", "mailto:jane.doe@acme.com");
    await expect(lead).not.toContainText("jane@acme.com");
    const team = main.getByTestId(ID.shownTeam);
    await expect(team.getByRole("link", { name: "platform@acme.com" })).toBeVisible();
    await expect(team.getByRole("link", { name: "ops@acme.com" })).toBeVisible();
    await expect(team.getByRole("link", { name: "oncall@acme.com" })).toHaveCount(0);
    await expect(main.getByTestId(ID.shownManager).getByRole("link", { name: "mo@acme.com" })).toBeVisible();

    // Nothing but the contacts changed: the product is still the same one.
    await expect(main.getByRole("navigation", { name: "Breadcrumb" })).toContainText(f.product.name);
  });

  test("an invalid address keeps the dialog open with the field's message; fixing it saves", async ({ authedPage: page }) => {
    await openProduct(page);
    const dialog = await openDialog(page);

    await dialog.getByTestId(ID.lead).fill("jane");
    await dialog.getByTestId(ID.save).click();

    await expect(dialog.getByTestId(ID.leadError)).toContainText("jane");
    await expect(dialog).toBeVisible();
    await expect(page.getByText(ID.toast)).toHaveCount(0);

    await dialog.getByTestId(ID.lead).fill("jane.doe@acme.com");
    await expect(dialog.getByTestId(ID.leadError)).toHaveCount(0);
    await saveAndClose(page, dialog);

    await page.reload();
    await expect(centerPanel(page).getByTestId(ID.shownLead).getByRole("link", { name: "jane.doe@acme.com" })).toBeVisible();
  });

  test("Cancel discards the edits", async ({ authedPage: page }) => {
    await openProduct(page);
    const dialog = await openDialog(page);

    await dialog.getByTestId(ID.lead).fill("someone.else@acme.com");
    await dialog.getByTestId(ID.cancel).click();
    await expect(dialog).toBeHidden();

    await expect(centerPanel(page).getByTestId(ID.shownLead)).not.toContainText("someone.else@acme.com");
    const reopened = await openDialog(page);
    await expect(reopened.getByTestId(ID.lead)).toHaveValue("jane.doe@acme.com");
  });

  test("clearing a field really clears it; clearing them all removes the contacts from the page", async ({ authedPage: page }) => {
    await openProduct(page);
    const main = centerPanel(page);

    // The manager only.
    let dialog = await openDialog(page);
    await dialog.getByTestId(ID.manager).fill("");
    await saveAndClose(page, dialog);
    await page.reload();
    await expect(main.getByTestId(ID.shownManager)).toHaveCount(0);
    await expect(main.getByTestId(ID.shownLead)).toBeVisible();
    await expect(main.getByTestId(ID.shownTeam)).toBeVisible();

    // Everything.
    dialog = await openDialog(page);
    await expect(dialog.getByTestId(ID.manager)).toHaveValue("");
    await dialog.getByTestId(ID.lead).fill("");
    while ((await dialog.getByTestId(ID.teamChip).count()) > 0) {
      await dialog.getByTestId(ID.teamRemove).first().click();
    }
    await saveAndClose(page, dialog);
    await page.reload();
    await expect(main.getByTestId(ID.contacts)).toHaveCount(0);
    await expect(main.getByTestId(ID.editButton)).toBeVisible();
  });
});
