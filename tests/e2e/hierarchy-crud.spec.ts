/**
 * The hierarchy of the schema editor, driven through the UI: Domain > Product > Entity, and the tenant-level (Enterprise) entity.
 *
 *   @smoke       the create path: a domain (name + description), a product in it, a blank entity with a field from the wizard; each
 *                shows in its grid, in the explorer, and opens its page;
 *   @regression  what the forms refuse (blank, duplicate and reserved names; Cancel creates nothing, checked after a reload), deleting a
 *                domain through the DomainDeletionDialog (its impact counts before the confirmation; entities and Events assets block
 *                it), deleting a product and an entity (a confirmation dialog each, Cancel keeps it), the blank wizard, the inline
 *                editing of an entity's description, tags and owner, and the Enterprise entity at /schemas/enterprise/new.
 *
 * What a test needs to exist BEFORE the operation it is about (the domain it deletes, the product it refuses a duplicate of) comes from
 * the `workspace` fixture (straight in the database, removed afterwards); everything under test is done through the UI. A domain or an
 * Enterprise entity a test makes through the UI is removed in `afterAll` by its (unique) name.
 *
 * NOT AVAILABLE IN THE UI (so not tested; nothing was invented for it): renaming or editing a domain (name, description), editing a
 * product's name / description / tier / owner team (only its contacts: product-contacts.spec.ts), renaming an entity (its name is
 * fixed at creation; its description, tags and owner are editable and tested here), deleting a domain from anywhere but the Domains
 * grid.
 *
 * Page content is queried inside the center panel and the explorer through `leftSidebar`: a hard load streams the page behind its
 * loading.tsx and Next leaves a hidden copy of the streamed segment in <body>. Dialogs and toasts are portals, queried on `page`.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect, unique } from "./helpers/fixtures";
import { centerPanel, leftSidebar } from "./helpers/event-builder";
import { deleteDomainsByName, deleteTenantEntitiesByName, createEventSpecInProduct, createProductInDomain, disconnectDb } from "./helpers/db";
import { waitForHydration } from "./helpers/hydration";
import { fieldName } from "./helpers/lifecycle";

/** Test ids of the domain grid, the product grid, the entity cards, the deletion dialogs and the entity wizard. */
const ID = {
  createDomain: "create-domain-button",
  domainForm: "create-domain-form",
  domainName: "domain-name-input",
  domainDescription: "domain-description-input",
  domainSubmit: "create-domain-submit",
  domainCancel: "create-domain-cancel",
  domainError: "create-domain-error",
  domainCard: "domain-card",
  domainCardDelete: "domain-card-delete",
  deletionDialog: "domain-deletion-dialog",
  deletionBlocked: "domain-deletion-blocked",
  deletionWarning: "domain-deletion-warning",
  deletionImpact: "domain-deletion-impact",
  deletionImpactOf: (key: string) => `domain-deletion-impact-${key}`,
  deletionConfirm: "domain-deletion-confirm",
  deletionCancel: "domain-deletion-cancel",
  newProduct: "new-product-button",
  productForm: "create-product-form",
  productName: "product-name-input",
  productDescription: "product-description-input",
  productSubmit: "create-product-submit",
  productCancel: "create-product-cancel",
  productError: "create-product-error",
  productCard: "product-card",
  productCardDelete: "product-card-delete",
  deleteProductDialog: "delete-product-dialog",
  deleteProductConfirm: "delete-product-confirm",
  deleteProductCancel: "delete-product-cancel",
  entityCard: "entity-card",
  entityCardDelete: "entity-card-delete",
  emptyStartBlank: "entity-empty-start-blank",
  deleteEntityDialog: "delete-entity-dialog",
  deleteEntityConfirm: "delete-entity-confirm",
  deleteEntityCancel: "delete-entity-cancel",
  methodBlank: "creation-method-blank",
  methodAi: "creation-method-natural-language",
  methodStandards: "creation-method-standards",
  methodSchema: "creation-method-schema",
  wizardName: "wizard-entity-name",
  wizardDescription: "wizard-entity-description",
  wizardAddField: "wizard-add-field",
  wizardNewFieldName: "wizard-new-field-name",
  wizardFieldRow: "wizard-field-row",
  wizardFieldName: "wizard-field-name",
  wizardCreate: "wizard-create-entity",
  wizardBack: "wizard-back",
  wizardRemoveField: "wizard-remove-field",
  entityMeta: "inline-entity-meta",
  addDescription: "entity-add-description",
  descriptionInput: "entity-description-input",
  descriptionSave: "entity-description-save",
  description: "entity-description",
  addTag: "add-tag-button",
  tagInput: "inline-tag-input",
  tag: "inline-tag",
  ownerButton: "inline-owner-button",
  ownerInput: "inline-owner-input",
  metaSaveControls: "meta-save-controls",
  metaSave: "meta-save-btn",
  metaDiscard: "meta-discard-btn",
  notFound: "dashboard-not-found",
} as const;

/** Domains and Enterprise entities that tests made through the UI; removed (with everything under them) after the tests of the worker. */
const createdDomains: string[] = [];
const createdTenantEntities: string[] = [];

test.afterAll(async () => {
  try {
    await deleteDomainsByName(createdDomains);
    await deleteTenantEntitiesByName(createdTenantEntities);
  } catch (error) {
    console.warn(`hierarchy-crud cleanup failed for ${[...createdDomains, ...createdTenantEntities].join(", ")}: ${String(error)}`);
  } finally {
    await disconnectDb();
  }
});

// ------------------------------------------------------------------------------------------------------------------------------
// What the pages show
// ------------------------------------------------------------------------------------------------------------------------------

const domainCard = (page: Page, name: string): Locator =>
  centerPanel(page).getByTestId(ID.domainCard).filter({ has: page.getByRole("heading", { name, exact: true }) });

const productCard = (page: Page, name: string): Locator =>
  centerPanel(page).getByTestId(ID.productCard).filter({ has: page.getByRole("heading", { name, exact: true }) });

const entityCard = (page: Page, name: string): Locator =>
  centerPanel(page).getByTestId(ID.entityCard).filter({ has: page.getByRole("heading", { name, exact: true }) });

/** The explorer's rows. A row is `domain-<id>` / `product-<id>` / `entity-<id>`; its category rows carry no name. */
const explorerDomain = (page: Page, name: string): Locator => leftSidebar(page).locator('[data-testid^="domain-"]').filter({ hasText: name });
const explorerProduct = (page: Page, name: string): Locator => leftSidebar(page).locator('[data-testid^="product-"]').filter({ hasText: name });
const explorerEntity = (page: Page, name: string): Locator => leftSidebar(page).locator('[data-testid^="entity-"]').filter({ hasText: name });

const successToast = (page: Page, text: string): Locator =>
  page.locator('[data-sonner-toast][data-type="success"]').filter({ hasText: text });

/** The Domains page, with the "Create Domain" button ready to be clicked (hydrated). */
async function openDomains(page: Page): Promise<void> {
  await page.goto("/schemas");
  await expect(centerPanel(page).getByRole("heading", { name: "Domains", level: 1 })).toBeVisible();
  await waitForHydration(centerPanel(page).getByTestId(ID.createDomain));
}

/** A domain's page (its Products tab), with "New Product" ready. */
async function openDomain(page: Page, slug: string): Promise<void> {
  await page.goto(`/schemas/${slug}`);
  await expect(centerPanel(page).getByTestId(ID.newProduct).first()).toBeVisible();
  await waitForHydration(centerPanel(page).getByTestId(ID.newProduct).first());
}

async function openDomainForm(page: Page): Promise<Locator> {
  await centerPanel(page).getByTestId(ID.createDomain).click();
  const form = centerPanel(page).getByTestId(ID.domainForm);
  await expect(form).toBeVisible();
  return form;
}

async function openProductForm(page: Page): Promise<Locator> {
  await centerPanel(page).getByTestId(ID.newProduct).first().click();
  const form = centerPanel(page).getByTestId(ID.productForm);
  await expect(form).toBeVisible();
  return form;
}

/** Create a domain through the Domains page's form and wait until its form has closed (the domain was accepted). */
async function submitDomainForm(page: Page, name: string, description: string): Promise<void> {
  const form = await openDomainForm(page);
  await form.getByTestId(ID.domainName).fill(name);
  if (description) await form.getByTestId(ID.domainDescription).fill(description);
  await form.getByTestId(ID.domainSubmit).click();
  await expect(form).toBeHidden();
}

/** Create a product through a domain page's form; it opens the new product's page. */
async function submitProductForm(page: Page, name: string, description: string): Promise<void> {
  const form = await openProductForm(page);
  await form.getByTestId(ID.productName).fill(name);
  if (description) await form.getByTestId(ID.productDescription).fill(description);
  await form.getByTestId(ID.productSubmit).click();
}

/** The entity wizard of `path`'s `/new`: the "Create New Entity" page, with the method cards ready. */
async function openWizard(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(centerPanel(page).getByRole("heading", { name: "Create New Entity" })).toBeVisible();
  await waitForHydration(centerPanel(page).getByTestId(ID.methodBlank));
}

/** Wizard, "Start Blank": the review step with the entity name and one field per name, nothing created yet. */
async function startBlankEntity(page: Page, entityName: string, fieldNames: readonly string[]): Promise<void> {
  const main = centerPanel(page);
  await main.getByTestId(ID.methodBlank).click();
  await expect(main.getByRole("heading", { name: "Review Entity" })).toBeVisible();
  await main.getByTestId(ID.wizardName).fill(entityName);
  for (const [index, name] of fieldNames.entries()) {
    // The first click opens the add row; the row stays open after Enter, so the next name goes into the same input.
    if (index === 0) await main.getByTestId(ID.wizardAddField).click();
    await main.getByTestId(ID.wizardNewFieldName).fill(name);
    await main.getByTestId(ID.wizardNewFieldName).press("Enter");
    await expect(main.getByTestId(ID.wizardFieldRow)).toHaveCount(index + 1);
  }
}

const productUrlPattern = (domainSlug: string): RegExp => new RegExp(`^/schemas/${domainSlug}/[^/]+$`);

// ------------------------------------------------------------------------------------------------------------------------------
// @smoke: the create path
// ------------------------------------------------------------------------------------------------------------------------------

test.describe("create a domain, a product and an entity", () => {
  test("a domain, a product in it and a blank entity with a field: each shows in its grid, the explorer and on its page", { tag: ["@smoke", "@regression"] }, async ({
    authedPage: page,
  }) => {
    test.setTimeout(120_000);
    const domainName = unique("e2e-domain-");
    const domainDescription = `The ${domainName} domain`;
    const productName = unique("e2e-product-");
    const productDescription = `The ${productName} product`;
    const entityName = unique("Order");
    createdDomains.push(domainName);
    const main = centerPanel(page);

    // 1. The domain: in the grid with its description and no entities, and in the explorer.
    await openDomains(page);
    await submitDomainForm(page, domainName, domainDescription);
    const card = domainCard(page, domainName);
    await expect(card).toBeVisible();
    await expect(card).toContainText(domainDescription);
    await expect(card).toContainText("0 entities");
    await expect(explorerDomain(page, domainName)).toBeVisible();
    const domainSlug = (await card.getAttribute("data-domain-slug")) ?? "";
    expect(domainSlug, "the domain card has no slug").not.toBe("");

    // Its page: the name and the description, and no product yet.
    await card.getByRole("heading", { name: domainName }).click();
    await expect(page).toHaveURL((url) => url.pathname === `/schemas/${domainSlug}`);
    await expect(main.getByRole("heading", { name: domainName, level: 1 })).toBeVisible();
    await expect(main.getByText(domainDescription)).toBeVisible();
    await expect(main.getByRole("heading", { name: "Create your first product" })).toBeVisible();

    // 2. The product: it opens on its own page, is in the explorer under the domain, and is a card with its description on the domain page.
    await waitForHydration(main.getByTestId(ID.newProduct).first());
    await submitProductForm(page, productName, productDescription);
    await expect(page).toHaveURL((url) => productUrlPattern(domainSlug).test(url.pathname));
    const productPath = new URL(page.url()).pathname;
    await expect(main.getByRole("navigation", { name: "Breadcrumb" })).toContainText(productName);
    await expect(explorerProduct(page, productName)).toBeVisible();

    await main.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: domainName }).click();
    await expect(page).toHaveURL((url) => url.pathname === `/schemas/${domainSlug}`);
    const pCard = productCard(page, productName);
    await expect(pCard).toBeVisible();
    await expect(pCard).toContainText(productDescription);
    await expect(pCard).toContainText("0 entities");
    await pCard.getByRole("heading", { name: productName }).click();
    await expect(page).toHaveURL((url) => url.pathname === productPath);

    // 3. The entity: "Start Blank" of the empty product leads to the wizard; the entity is created with its one field.
    await expect(main.getByRole("heading", { name: "Create your first entity" })).toBeVisible();
    await waitForHydration(main.getByTestId(ID.emptyStartBlank));
    await main.getByTestId(ID.emptyStartBlank).click();
    await expect(page).toHaveURL((url) => url.pathname === `${productPath}/new`);
    await expect(main.getByRole("heading", { name: "Create New Entity" })).toBeVisible();
    await waitForHydration(main.getByTestId(ID.methodBlank));
    await startBlankEntity(page, entityName, ["orderId"]);
    await expect(main.getByTestId(ID.wizardFieldName)).toHaveValue("orderId");
    await main.getByTestId(ID.wizardCreate).click();

    // Back on the product page: the entity is a card with its field count, and a row in the explorer.
    await expect(page).toHaveURL((url) => url.pathname === productPath);
    const eCard = entityCard(page, entityName);
    await expect(eCard).toBeVisible();
    await expect(eCard.getByText("1 field", { exact: true }), "the card says '1 field', not '1 fields'").toBeVisible();
    await expect(explorerEntity(page, entityName)).toBeVisible();

    // Its page shows the name and the field.
    await eCard.getByRole("heading", { name: entityName }).click();
    await expect(page).toHaveURL((url) => url.pathname.startsWith(`${productPath}/`) && !url.pathname.endsWith("/new"));
    await expect(main.getByRole("heading", { name: entityName, level: 1 })).toBeVisible();
    await expect(fieldName(page, "orderId")).toBeVisible();
  });
});

// ------------------------------------------------------------------------------------------------------------------------------
// The domain form, and deleting a domain
// ------------------------------------------------------------------------------------------------------------------------------

test.describe("domains", () => {
  test("the create form: Cancel creates nothing; a blank, a reserved and a duplicate name are refused with a message", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const main = centerPanel(page);
    await openDomains(page);

    // Cancel: the form closes and nothing was made.
    let form = await openDomainForm(page);
    const cancelled = unique("e2e-cancelled-");
    await form.getByTestId(ID.domainName).fill(cancelled);
    await form.getByTestId(ID.domainCancel).click();
    await expect(form).toBeHidden();
    // What the server holds, not what the page remembers: after a reload the cancelled name is nowhere.
    await page.reload();
    await expect(centerPanel(page).getByRole("heading", { name: "Domains", level: 1 })).toBeVisible();
    await expect(domainCard(page, workspace.domainName)).toBeVisible();
    await expect(domainCard(page, cancelled)).toHaveCount(0);
    await expect(explorerDomain(page, cancelled)).toHaveCount(0);
    await waitForHydration(centerPanel(page).getByTestId(ID.createDomain));

    // A name of blanks passes the browser's `required` and is refused by the server.
    form = await openDomainForm(page);
    await form.getByTestId(ID.domainName).fill("   ");
    await form.getByTestId(ID.domainSubmit).click();
    await expect(form.getByTestId(ID.domainError)).toHaveText("Domain name is required");

    // A name whose URL is reserved for a schemas utility page.
    await form.getByTestId(ID.domainName).fill("Enterprise");
    await form.getByTestId(ID.domainSubmit).click();
    await expect(form.getByTestId(ID.domainError)).toHaveText('"enterprise" is reserved for a schemas utility page');

    // A name that is taken: the message names it, and there is still exactly one such domain.
    await form.getByTestId(ID.domainName).fill(workspace.domainName);
    await form.getByTestId(ID.domainSubmit).click();
    await expect(form.getByTestId(ID.domainError)).toHaveText(`A domain named "${workspace.domainName}" already exists`);
    await expect(form).toBeVisible();
    await expect(domainCard(page, workspace.domainName)).toHaveCount(1);
    await expect(main.getByText(/prisma|violates|duplicate key/i)).toHaveCount(0);
  });

  test("deleting an empty domain: the dialog counts what goes with it, Cancel keeps it, Delete Domain removes it everywhere", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    // A domain with two products and nothing else: the impact the dialog must count.
    await createProductInDomain(workspace.domainId);
    await openDomains(page);
    const card = domainCard(page, workspace.domainName);
    await expect(card).toContainText("0 entities");
    await expect(explorerDomain(page, workspace.domainName)).toBeVisible();

    // The dialog names the domain and counts its contents BEFORE anything is confirmed.
    await waitForHydration(card.getByTestId(ID.domainCardDelete));
    await card.getByTestId(ID.domainCardDelete).click();
    const dialog = page.getByTestId(ID.deletionDialog);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Delete domain", { exact: true })).toBeVisible();
    await expect(dialog).toContainText(workspace.domainName);
    await expect(dialog.getByTestId(ID.deletionWarning)).toContainText("The domain, its products, and every asset listed below");
    await expect(dialog.getByTestId(ID.deletionWarning)).toContainText("This action cannot be undone.");
    await expect(dialog.getByTestId(ID.deletionImpact).getByRole("listitem")).toHaveCount(1);
    await expect(dialog.getByTestId(ID.deletionImpactOf("products"))).toHaveText("2 products");
    await expect(dialog.getByTestId(ID.deletionConfirm)).toBeEnabled();

    // Cancel: the dialog closes and the domain is untouched.
    await dialog.getByTestId(ID.deletionCancel).click();
    await expect(dialog).toBeHidden();
    await expect(card).toBeVisible();
    await expect(explorerDomain(page, workspace.domainName)).toBeVisible();

    // Confirm: the card and the explorer row go, and a reload and a direct visit agree.
    await card.getByTestId(ID.domainCardDelete).click();
    await expect(dialog).toBeVisible();
    await dialog.getByTestId(ID.deletionConfirm).click();
    await expect(dialog).toBeHidden();
    await expect(domainCard(page, workspace.domainName)).toHaveCount(0);
    await expect(explorerDomain(page, workspace.domainName)).toHaveCount(0);
    await page.reload();
    await expect(centerPanel(page).getByRole("heading", { name: "Domains", level: 1 })).toBeVisible();
    await expect(domainCard(page, workspace.domainName)).toHaveCount(0);
    await page.goto(`/schemas/${workspace.domainSlug}`);
    await expect(page.getByTestId(ID.notFound)).toBeVisible();
  });

  test("a domain that holds an event and no entity can be asked about: the dialog is the blocked one ('Delete or move all Events assets first'), Delete Domain is disabled", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    // The grid's delete button looks at entities only, so it is enabled; the dialog it opens counts Events assets too.
    await createEventSpecInProduct(workspace.domainId, workspace.productId);
    await openDomains(page);
    const card = domainCard(page, workspace.domainName);
    await expect(card).toContainText("0 entities");
    await expect(card.getByTestId(ID.domainCardDelete)).toBeEnabled();
    await waitForHydration(card.getByTestId(ID.domainCardDelete));

    await card.getByTestId(ID.domainCardDelete).click();
    const dialog = page.getByTestId(ID.deletionDialog);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId(ID.deletionBlocked)).toContainText("Delete or move all Events assets first.");
    await expect(dialog.getByTestId(ID.deletionBlocked)).toContainText("This domain currently contains 1 event.");
    await expect(dialog.getByTestId(ID.deletionImpactOf("eventSpecs"))).toHaveText("1 event");
    await expect(dialog.getByTestId(ID.deletionImpactOf("products"))).toHaveText("1 product");
    await expect(dialog.getByTestId(ID.deletionConfirm)).toBeDisabled();

    // Nothing can be confirmed, and Cancel leaves everything as it was.
    await dialog.getByTestId(ID.deletionCancel).click();
    await expect(dialog).toBeHidden();
    await page.reload();
    await expect(domainCard(page, workspace.domainName)).toBeVisible();
  });

  test.describe("a domain that holds entities", () => {
    test.use({ workspaceEntities: [unique("Customer"), unique("Invoice")] });

    test("cannot be deleted: its card's delete button is disabled and says why, and the domain stays", { tag: ["@regression"] }, async ({
      authedPage: page,
      workspace,
    }) => {
      // The button is there (an admin is signed in), disabled until the entities are deleted or moved: the dialog is never opened for a
      // domain with entities (its blocked form is a guard against a race, covered by the component's unit test).
      await openDomains(page);
      const card = domainCard(page, workspace.domainName);
      await expect(card).toContainText("2 entities");
      await expect(card.getByTestId(ID.domainCardDelete)).toBeDisabled();
      await expect(card.getByTestId(ID.domainCardDelete)).toHaveAttribute("title", "Delete entities in this domain before removing it");
      await expect(page.getByTestId(ID.deletionDialog)).toHaveCount(0);

      // Still there after a reload, with its products and entities in the explorer.
      await page.reload();
      await expect(domainCard(page, workspace.domainName)).toBeVisible();
      await expect(explorerDomain(page, workspace.domainName)).toBeVisible();
    });
  });
});

// ------------------------------------------------------------------------------------------------------------------------------
// Products
// ------------------------------------------------------------------------------------------------------------------------------

test.describe("products", () => {
  test("the create form: Cancel creates nothing; a blank and a duplicate name are refused with a message", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    await openDomain(page, workspace.domainSlug);
    await expect(productCard(page, workspace.productName)).toBeVisible();

    // Cancel.
    let form = await openProductForm(page);
    const cancelled = unique("e2e-cancelled-");
    await form.getByTestId(ID.productName).fill(cancelled);
    await form.getByTestId(ID.productCancel).click();
    await expect(form).toBeHidden();
    // What the server holds, not what the page remembers: after a reload the cancelled name is nowhere.
    await page.reload();
    await expect(productCard(page, workspace.productName)).toBeVisible();
    await expect(productCard(page, cancelled)).toHaveCount(0);
    await expect(explorerProduct(page, cancelled)).toHaveCount(0);
    await waitForHydration(centerPanel(page).getByTestId(ID.newProduct).first());

    // A blank name (checked in the browser before anything is sent).
    form = await openProductForm(page);
    await form.getByTestId(ID.productSubmit).click();
    await expect(form.getByTestId(ID.productError)).toHaveText("Product name is required");

    // A name that is taken in this domain.
    await form.getByTestId(ID.productName).fill(workspace.productName);
    await form.getByTestId(ID.productSubmit).click();
    await expect(form.getByTestId(ID.productError)).toHaveText(`A product named "${workspace.productName}" already exists in this domain`);
    await expect(form).toBeVisible();
    await expect(productCard(page, workspace.productName)).toHaveCount(1);
  });

  test("an empty product is deleted through a confirmation: Cancel keeps it, Delete removes the card, the explorer row and the page", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    await openDomain(page, workspace.domainSlug);
    await expect(explorerProduct(page, workspace.productName)).toBeVisible();
    const card = productCard(page, workspace.productName);
    await expect(card).toContainText("0 entities");
    await expect(card.getByTestId(ID.productCardDelete)).toBeEnabled();
    await waitForHydration(card.getByTestId(ID.productCardDelete));

    // Asked first: the dialog names the product and says it cannot be undone; nothing is deleted yet.
    await card.getByTestId(ID.productCardDelete).click();
    const dialog = page.getByTestId(ID.deleteProductDialog);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: `Delete \u201c${workspace.productName}\u201d?` })).toBeVisible();
    await expect(dialog).toContainText("This permanently deletes this product. This action cannot be undone.");
    await expect(successToast(page, "deleted")).toHaveCount(0);

    // Cancel: nothing is deleted, here and on the server.
    await dialog.getByTestId(ID.deleteProductCancel).click();
    await expect(dialog).toBeHidden();
    await expect(card).toBeVisible();
    await page.reload();
    await expect(productCard(page, workspace.productName)).toBeVisible();
    await expect(explorerProduct(page, workspace.productName)).toBeVisible();
    await waitForHydration(productCard(page, workspace.productName).getByTestId(ID.productCardDelete));

    // Confirm: a toast tells it, the card and the explorer row go, and the page of the product is gone.
    await productCard(page, workspace.productName).getByTestId(ID.productCardDelete).click();
    await expect(dialog).toBeVisible();
    await dialog.getByTestId(ID.deleteProductConfirm).click();
    await expect(successToast(page, `"${workspace.productName}" deleted`)).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(productCard(page, workspace.productName)).toHaveCount(0);
    await expect(centerPanel(page).getByRole("heading", { name: "Create your first product" })).toBeVisible();
    await expect(explorerProduct(page, workspace.productName)).toHaveCount(0);

    await page.goto(workspace.productUrl);
    await expect(page.getByTestId(ID.notFound)).toBeVisible();
  });

  test.describe("a product that holds an entity", () => {
    test.use({ workspaceEntities: [unique("Account")] });

    test("cannot be deleted: the card's button is disabled and says why, and the product stays", { tag: ["@regression"] }, async ({
      authedPage: page,
      workspace,
    }) => {
      await openDomain(page, workspace.domainSlug);
      const card = productCard(page, workspace.productName);
      await expect(card).toContainText("1 entity");
      await expect(card.getByTestId(ID.productCardDelete)).toBeDisabled();
      await expect(card.getByTestId(ID.productCardDelete)).toHaveAttribute("title", /entit/i);
      await expect(explorerProduct(page, workspace.productName)).toBeVisible();
    });
  });
});

// ------------------------------------------------------------------------------------------------------------------------------
// Entities
// ------------------------------------------------------------------------------------------------------------------------------

test.describe("entities", () => {
  test("the blank wizard: Create needs a name; fields are added and removed; Back returns to the methods", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const main = centerPanel(page);
    await openWizard(page, `${workspace.productUrl}/new`);
    // Every method is offered at product level, the AI one included.
    for (const method of [ID.methodStandards, ID.methodAi, ID.methodSchema, ID.methodBlank]) await expect(main.getByTestId(method)).toBeVisible();

    await startBlankEntity(page, "", ["first", "second"]);
    // No name: no entity.
    await expect(main.getByTestId(ID.wizardCreate)).toBeDisabled();
    await main.getByTestId(ID.wizardName).fill(unique("Draft"));
    await expect(main.getByTestId(ID.wizardCreate)).toBeEnabled();

    // Remove the first field: one is left, and it is the second.
    await main.getByTestId(ID.wizardFieldRow).first().hover();
    await main.getByTestId(ID.wizardFieldRow).first().getByTestId(ID.wizardRemoveField).click();
    await expect(main.getByTestId(ID.wizardFieldRow)).toHaveCount(1);
    await expect(main.getByTestId(ID.wizardFieldName)).toHaveValue("second");
    await expect(main.getByText("1 field", { exact: true })).toBeVisible();

    // Back: the methods again, with nothing created.
    await main.getByTestId(ID.wizardBack).click();
    await expect(main.getByRole("heading", { name: "Create New Entity" })).toBeVisible();
    await expect(main.getByTestId(ID.methodBlank)).toBeVisible();
    await page.goto(workspace.productUrl);
    await expect(centerPanel(page).getByRole("heading", { name: "Create your first entity" })).toBeVisible();
  });

  test.describe("deleting", () => {
    test.use({ workspaceEntities: [unique("Customer")] });

    test("the dialog asks first, Cancel keeps the entity, Delete removes it from the product page, the explorer and the address", { tag: ["@regression"] }, async ({
      authedPage: page,
      workspace,
    }) => {
      const entity = workspace.entities[0];
      await page.goto(workspace.productUrl);
      const card = entityCard(page, entity.name);
      await expect(card).toBeVisible();
      await expect(explorerEntity(page, entity.name)).toBeVisible();
      await waitForHydration(card.getByTestId(ID.entityCardDelete));

      // Asked first: the dialog names the entity; Cancel changes nothing.
      await card.getByTestId(ID.entityCardDelete).click();
      const dialog = page.getByTestId(ID.deleteEntityDialog);
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("heading", { name: `Delete “${entity.name}”?` })).toBeVisible();
      await expect(dialog).toContainText("This permanently deletes this entity and all its data. This action cannot be undone.");
      await dialog.getByTestId(ID.deleteEntityCancel).click();
      await expect(dialog).toBeHidden();
      await expect(card).toBeVisible();
      await expect(explorerEntity(page, entity.name)).toBeVisible();

      // Confirmed: it is gone from the page and the explorer, and the product is empty again.
      await card.getByTestId(ID.entityCardDelete).click();
      await expect(dialog).toBeVisible();
      await dialog.getByTestId(ID.deleteEntityConfirm).click();
      await expect(successToast(page, "Entity deleted")).toBeVisible();
      await expect(dialog).toBeHidden();
      await expect(entityCard(page, entity.name)).toHaveCount(0);
      await expect(explorerEntity(page, entity.name)).toHaveCount(0);
      await expect(centerPanel(page).getByRole("heading", { name: "Create your first entity" })).toBeVisible();

      // A reload and its old address agree.
      await page.reload();
      await expect(centerPanel(page).getByRole("heading", { name: "Create your first entity" })).toBeVisible();
      await page.goto(entity.url);
      await expect(page.getByTestId(ID.notFound)).toBeVisible();
    });
  });
});

test.describe("entity details", () => {
  test.use({ workspaceEntities: [unique("Payment")] });

  test("description, tags and owner are edited inline, saved, and are still there after a reload; Discard drops an edit", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const entity = workspace.entities[0];
    const main = centerPanel(page);
    const meta = main.getByTestId(ID.entityMeta);
    const description = `What a ${entity.name} is for`;
    await page.goto(entity.url);
    await expect(meta).toBeVisible();
    await waitForHydration(meta.getByTestId(ID.addTag));
    await expect(meta.getByTestId(ID.tag)).toHaveCount(0);
    await expect(meta.getByTestId(ID.ownerButton)).toHaveText("Add owner");

    // The description saves by itself.
    await meta.getByTestId(ID.addDescription).click();
    await meta.getByTestId(ID.descriptionInput).fill(description);
    await meta.getByTestId(ID.descriptionSave).click();
    await expect(meta.getByTestId(ID.description)).toHaveText(description);

    // Tags and the owner are edited, then saved together (the entity says "Unsaved" until then). A tag is stored lower-case.
    await meta.getByTestId(ID.addTag).click();
    await meta.getByTestId(ID.tagInput).fill("Payments");
    await meta.getByTestId(ID.tagInput).press("Enter");
    await meta.getByTestId(ID.addTag).click();
    await meta.getByTestId(ID.tagInput).fill("pii-review");
    await meta.getByTestId(ID.tagInput).press("Enter");
    await meta.getByTestId(ID.ownerButton).click();
    await meta.getByTestId(ID.ownerInput).fill("Payments Platform");
    await meta.getByTestId(ID.ownerInput).press("Enter");
    await expect(meta.getByTestId(ID.tag)).toHaveText(["payments", "pii-review"]);
    await expect(meta.getByTestId(ID.ownerButton)).toHaveText("Payments Platform");
    await expect(meta.getByTestId(ID.metaSaveControls)).toContainText("Unsaved");
    await meta.getByTestId(ID.metaSave).click();
    await expect(meta.getByTestId(ID.metaSaveControls)).toHaveCount(0);

    // After a reload the server's copy is shown.
    await page.reload();
    await expect(meta).toBeVisible();
    await expect(meta.getByTestId(ID.description)).toHaveText(description);
    await expect(meta.getByTestId(ID.tag)).toHaveText(["payments", "pii-review"]);
    await expect(meta.getByTestId(ID.ownerButton)).toHaveText("Payments Platform");
    await expect(meta.getByTestId(ID.metaSaveControls)).toHaveCount(0);

    // Discard: an edit that is not saved goes, and nothing was written.
    await waitForHydration(meta.getByTestId(ID.addTag));
    await meta.getByTestId(ID.addTag).click();
    await meta.getByTestId(ID.tagInput).fill("scratch");
    await meta.getByTestId(ID.tagInput).press("Enter");
    await expect(meta.getByTestId(ID.tag)).toHaveCount(3);
    await meta.getByTestId(ID.metaDiscard).click();
    await expect(meta.getByTestId(ID.tag)).toHaveText(["payments", "pii-review"]);
    await expect(meta.getByTestId(ID.metaSaveControls)).toHaveCount(0);

    // Removing a tag and saving removes it for good.
    await meta.getByRole("button", { name: "Remove tag payments" }).click();
    await expect(meta.getByTestId(ID.tag)).toHaveText(["pii-review"]);
    await meta.getByTestId(ID.metaSave).click();
    await expect(meta.getByTestId(ID.metaSaveControls)).toHaveCount(0);
    await page.reload();
    await expect(meta.getByTestId(ID.tag)).toHaveText(["pii-review"]);
    await expect(meta.getByTestId(ID.ownerButton)).toHaveText("Payments Platform");
    await expect(meta.getByTestId(ID.description)).toHaveText(description);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------
// The Enterprise (tenant-level) entity
// ------------------------------------------------------------------------------------------------------------------------------

test.describe("enterprise entity", () => {
  test("is created at /schemas/enterprise/new and appears under the Enterprise section of the explorer and on its page", { tag: ["@regression"] }, async ({
    authedPage: page,
  }) => {
    test.setTimeout(120_000);
    const entityName = unique("EnterpriseParty");
    createdTenantEntities.push(entityName);
    const main = centerPanel(page);

    await openWizard(page, "/schemas/enterprise/new");
    // The breadcrumb is Enterprise > New Entity, and the AI method (it reads a domain's entities) is not offered at this level.
    await expect(main.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Enterprise");
    await expect(main.getByTestId(ID.methodAi)).toHaveCount(0);
    for (const method of [ID.methodStandards, ID.methodSchema, ID.methodBlank]) await expect(main.getByTestId(method)).toBeVisible();

    await startBlankEntity(page, entityName, ["partyId"]);
    await main.getByTestId(ID.wizardCreate).click();

    // It opens on its own Enterprise page: no domain, no product in the address.
    await expect(page).toHaveURL((url) => /^\/schemas\/enterprise\/entities\/[^/]+$/.test(url.pathname));
    await expect(main.getByRole("heading", { name: entityName, level: 1 })).toBeVisible();
    await expect(fieldName(page, "partyId")).toBeVisible();

    // Under Enterprise > Entities in the explorer ...
    await expect(leftSidebar(page).getByTestId("enterprise-entities")).toBeVisible();
    await expect(explorerEntity(page, entityName)).toBeVisible();

    // ... and on the Enterprise page, as a card.
    await page.goto("/schemas/enterprise");
    await expect(main.getByRole("heading", { name: "Enterprise", level: 1 })).toBeVisible();
    const card = entityCard(page, entityName);
    await expect(card).toBeVisible();
    await expect(card.getByText("1 field", { exact: true })).toBeVisible();
  });
});
