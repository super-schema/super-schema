/**
 * The assets a domain, a product and the Enterprise own besides their entities: Data Types (shared enums, custom scalars, unions), APIs
 * (services with operations) and Properties (message property sets, "traits"), each in a tab of the level's page.
 *
 * What each tab does (each line is a test):
 *   - Data Types  a New Enum / Scalar / Union form creates the type, listed as a card under its sub-tab (the sub-tab's count follows) and
 *                 kept after a reload; an enum's values and a union's members are added and removed in place (saved at once); a type is
 *                 deleted after a confirmation (Cancel keeps it); a duplicate name is refused; a type of a broader level is listed in
 *                 the narrower one, read-only, under its source's name.
 *   - APIs        New Service (name, base path; entity-scoped where the page offers entities) creates a service; Add Operation (method,
 *                 path, name) adds an operation; each is deleted at once from its trash button; the summary counts follow.
 *   - Properties  New Message Properties creates a set and opens its editor; the editor renames it (kept after a reload) and deletes it
 *                 after a confirmation; an Enterprise set is listed on the domain's tab, read-only, and its own page is the same editor.
 *
 * NOT AVAILABLE IN THE UI (nothing was invented for it): renaming a data type or editing a scalar's base type, format or pattern (only an
 * enum's values and a union's members are editable), editing a service or an operation (name, path, parameters and responses are shown
 * and cannot be changed: delete and add again), a product's own Properties tab (Properties live on domains and the Enterprise; a
 * product's `?tab=traits` is the Events list: events-builder.spec.ts), adding properties to a set from this page's spec (the properties
 * table is the Events builder's control: events-builder.spec.ts).
 *
 * Page content is queried inside the center panel (`centerPanel`): a hard load streams the page behind its loading.tsx and Next leaves
 * a hidden copy of the streamed segment in <body>. Toasts are portals, queried on `page`.
 */
import type { Locator, Page } from "@playwright/test";
import { disconnectDb, pg } from "./helpers/db";
import { centerPanel } from "./helpers/event-builder";
import { test, expect, unique } from "./helpers/fixtures";
import { waitForHydration } from "./helpers/hydration";

/** Enterprise-level rows a test made (a tenant-level enum or property set outlives its test's workspace): removed by name afterwards. */
const enterpriseNames: { enums: string[]; traits: string[] } = { enums: [], traits: [] };

test.afterAll(async () => {
  try {
    if (enterpriseNames.enums.length > 0) await pg().query(`DELETE FROM shared_enums WHERE name = ANY($1::text[])`, [enterpriseNames.enums]);
    if (enterpriseNames.traits.length > 0) await pg().query(`DELETE FROM traits WHERE name = ANY($1::text[])`, [enterpriseNames.traits]);
  } catch (error) {
    console.warn(`domain-assets.spec cleanup failed: ${String(error)}`);
  } finally {
    await disconnectDb();
  }
});

const toast = (page: Page, text: string | RegExp): Locator => page.locator("[data-sonner-toast]").filter({ hasText: text });

// ---------------------------------------------------------------------------
// Data Types
// ---------------------------------------------------------------------------

async function openTypes(page: Page, url: string): Promise<Locator> {
  await page.goto(`${url}?tab=data-types`);
  const tab = centerPanel(page).getByTestId("domain-types-tab");
  await expect(tab).toBeVisible();
  await waitForHydration(tab.getByTestId("data-type-subtab").first());
  return tab;
}

const subtab = (tab: Locator, id: "enums" | "scalars" | "unions"): Locator => tab.locator(`[data-testid="data-type-subtab"][data-subtab="${id}"]`);
const typeCard = (tab: Locator, name: string): Locator => tab.locator(`[data-testid="data-type-card"][data-name="${name}"]`);

async function chooseSubtab(tab: Locator, id: "enums" | "scalars" | "unions"): Promise<void> {
  await subtab(tab, id).click();
  await expect(subtab(tab, id)).toHaveAttribute("aria-pressed", "true");
}

/** Delete a type from its card: the trash button (hover), then the confirmation. */
async function deleteType(page: Page, tab: Locator, name: string): Promise<void> {
  const card = typeCard(tab, name);
  await card.hover();
  await card.getByTestId("data-type-delete").click();
  const dialog = page.getByTestId("data-type-delete-dialog");
  await expect(dialog).toContainText(`Delete "${name}"?`);
  await dialog.getByTestId("data-type-delete-confirm").click();
  await expect(card).toHaveCount(0);
}

test.describe("data types of a domain", () => {
  test("a new domain has none; tabs open from the page's tab bar and keep the address in step", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
    await page.goto(`/schemas/${workspace.domainSlug}`);
    await expect(centerPanel(page).getByRole("heading", { name: workspace.domainName, level: 1 })).toBeVisible();
    const tabs = centerPanel(page).getByRole("tablist", { name: `${workspace.domainName} sections` });
    await waitForHydration(tabs.getByRole("tab", { name: "Data Types" }));

    await tabs.getByRole("tab", { name: "Data Types" }).click();
    await expect(page).toHaveURL(/[?&]tab=data-types\b/);
    const tab = centerPanel(page).getByTestId("domain-types-tab");
    await expect(tab).toBeVisible();
    for (const id of ["enums", "scalars", "unions"] as const) await expect(subtab(tab, id).getByTestId("data-type-subtab-count")).toHaveText("0");
    await expect(tab.getByText('No shared enums — click "New Enum" to create one')).toBeVisible();
    await chooseSubtab(tab, "scalars");
    await expect(tab.getByText('No custom scalars — click "New Scalar" to create one')).toBeVisible();
    await chooseSubtab(tab, "unions");
    await expect(tab.getByText('No union types — click "New Union" to create one')).toBeVisible();

    await tabs.getByRole("tab", { name: "APIs" }).click();
    await expect(page).toHaveURL(/[?&]tab=apis\b/);
    await expect(centerPanel(page).getByTestId("domain-apis-tab")).toBeVisible();
    await tabs.getByRole("tab", { name: /properties/i }).click();
    await expect(page).toHaveURL(/[?&]tab=traits\b/);
    await expect(centerPanel(page).getByTestId("traits-tab")).toBeVisible();
    await tabs.getByRole("tab", { name: "Products" }).click();
    await expect(page).not.toHaveURL(/[?&]tab=/);
  });

  test("an enum is created with its values, listed, kept after a reload; its values are added and removed in place; Cancel keeps it and Delete removes it", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const name = unique("Status");
    const url = `/schemas/${workspace.domainSlug}`;
    let tab = await openTypes(page, url);

    await tab.getByTestId("data-type-new-enum").click();
    const form = tab.getByTestId("data-type-form-enum");
    await expect(tab.getByTestId("data-type-new-enum")).toBeDisabled();
    await expect(form.getByTestId("data-type-create")).toBeDisabled();
    await form.getByTestId("data-type-name").fill(name);
    await form.getByTestId("data-type-members").fill("ACTIVE, INACTIVE");
    await form.getByTestId("data-type-create").click();
    await expect(toast(page, `Enum "${name}" created`)).toBeVisible();

    await expect(subtab(tab, "enums").getByTestId("data-type-subtab-count")).toHaveText("1");
    const card = typeCard(tab, name);
    await expect(card).toContainText("2 values");
    await expect(card.getByTestId("data-type-member")).toHaveText(["ACTIVE", "INACTIVE"]);

    tab = await openTypes(page, url);
    await expect(typeCard(tab, name).getByTestId("data-type-member")).toHaveText(["ACTIVE", "INACTIVE"]);

    // A value is added (Enter commits it) and another removed: each is saved at once.
    await typeCard(tab, name).getByRole("button", { name: "Add value" }).click();
    await typeCard(tab, name).getByRole("textbox", { name: "New value" }).fill("PENDING");
    await page.keyboard.press("Enter");
    await expect(typeCard(tab, name).getByTestId("data-type-member")).toHaveText(["ACTIVE", "INACTIVE", "PENDING"]);
    await expect(typeCard(tab, name)).toContainText("3 values");
    await typeCard(tab, name).getByRole("button", { name: "Remove INACTIVE" }).click();
    await expect(typeCard(tab, name).getByTestId("data-type-member")).toHaveText(["ACTIVE", "PENDING"]);
    await expect.poll(async () => (await pg().query(`SELECT "values" FROM shared_enums WHERE name = $1`, [name])).rows[0]?.values).toEqual(["ACTIVE", "PENDING"]);

    tab = await openTypes(page, url);
    await expect(typeCard(tab, name).getByTestId("data-type-member")).toHaveText(["ACTIVE", "PENDING"]);

    // Cancel in the confirmation keeps the enum; Delete removes it, with its toast, and the count goes.
    await typeCard(tab, name).hover();
    await typeCard(tab, name).getByTestId("data-type-delete").click();
    await page.getByTestId("data-type-delete-cancel").click();
    await expect(page.getByTestId("data-type-delete-dialog")).toHaveCount(0);
    await expect(typeCard(tab, name)).toBeVisible();
    await deleteType(page, tab, name);
    await expect(toast(page, `Enum "${name}" deleted`)).toBeVisible();
    await expect(subtab(tab, "enums").getByTestId("data-type-subtab-count")).toHaveText("0");

    tab = await openTypes(page, url);
    await expect(typeCard(tab, name)).toHaveCount(0);
  });

  test("a scalar and a union are created, listed under their sub-tabs, kept after a reload, and the union's members are edited in place", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const scalar = unique("Money");
    const union = unique("Payment");
    const url = `/schemas/${workspace.domainSlug}`;
    let tab = await openTypes(page, url);

    await chooseSubtab(tab, "scalars");
    await tab.getByTestId("data-type-new-scalar").click();
    const scalarForm = tab.getByTestId("data-type-form-scalar");
    await scalarForm.getByTestId("data-type-name").fill(scalar);
    await scalarForm.getByTestId("data-type-base").selectOption("decimal");
    await scalarForm.getByTestId("data-type-create").click();
    await expect(toast(page, `Scalar "${scalar}" created`)).toBeVisible();
    await expect(typeCard(tab, scalar)).toContainText("extends");
    await expect(typeCard(tab, scalar)).toContainText("decimal");
    await expect(subtab(tab, "scalars").getByTestId("data-type-subtab-count")).toHaveText("1");

    await chooseSubtab(tab, "unions");
    await tab.getByTestId("data-type-new-union").click();
    const unionForm = tab.getByTestId("data-type-form-union");
    await unionForm.getByTestId("data-type-name").fill(union);
    await unionForm.getByTestId("data-type-members").fill("Card | Cash");
    await unionForm.getByTestId("data-type-create").click();
    await expect(toast(page, `Union "${union}" created`)).toBeVisible();
    await expect(typeCard(tab, union).getByTestId("data-type-member")).toHaveText(["Card", "Cash"]);
    await expect(subtab(tab, "unions").getByTestId("data-type-subtab-count")).toHaveText("1");

    tab = await openTypes(page, url);
    await chooseSubtab(tab, "scalars");
    await expect(typeCard(tab, scalar)).toContainText("decimal");
    await chooseSubtab(tab, "unions");
    await typeCard(tab, union).getByRole("button", { name: "Add member" }).click();
    await typeCard(tab, union).getByRole("textbox", { name: "New member" }).fill("Transfer");
    await page.keyboard.press("Enter");
    await expect(typeCard(tab, union).getByTestId("data-type-member")).toHaveText(["Card", "Cash", "Transfer"]);
    await typeCard(tab, union).getByRole("button", { name: "Remove Cash" }).click();
    await expect(typeCard(tab, union).getByTestId("data-type-member")).toHaveText(["Card", "Transfer"]);
    await expect.poll(async () => (await pg().query(`SELECT "memberTypes" FROM union_types WHERE name = $1`, [union])).rows[0]?.memberTypes).toEqual(["Card", "Transfer"]);

    await deleteType(page, tab, union);
    await expect(toast(page, `Union "${union}" deleted`)).toBeVisible();
    await chooseSubtab(tab, "scalars");
    await deleteType(page, tab, scalar);
    await expect(toast(page, `Scalar "${scalar}" deleted`)).toBeVisible();
  });

  test("a name that is already a type of the domain is refused with a message, and the list keeps the one", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const name = unique("Dup");
    const tab = await openTypes(page, `/schemas/${workspace.domainSlug}`);
    for (const attempt of [1, 2]) {
      await tab.getByTestId("data-type-new-enum").click();
      const form = tab.getByTestId("data-type-form-enum");
      await form.getByTestId("data-type-name").fill(name);
      await form.getByTestId("data-type-members").fill("A, B");
      await form.getByTestId("data-type-create").click();
      if (attempt === 1) await expect(toast(page, `Enum "${name}" created`)).toBeVisible();
    }
    await expect(page.locator('[data-sonner-toast][data-type="error"]')).toBeVisible();
    await expect(page.locator('[data-sonner-toast][data-type="error"]')).not.toContainText(/prisma|violates|unique constraint|P20\d\d/i);
    await expect(typeCard(tab, name)).toHaveCount(1);
  });
});

test.describe("data types of a product and the Enterprise", () => {
  test("a product has its own; the domain's are listed in it read-only, and the product's are not in the domain's", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const domainEnum = unique("DomainStatus");
    const productEnum = unique("ProductStatus");

    let domainTab = await openTypes(page, `/schemas/${workspace.domainSlug}`);
    await domainTab.getByTestId("data-type-new-enum").click();
    await domainTab.getByTestId("data-type-form-enum").getByTestId("data-type-name").fill(domainEnum);
    await domainTab.getByTestId("data-type-form-enum").getByTestId("data-type-members").fill("D1, D2");
    await domainTab.getByTestId("data-type-form-enum").getByTestId("data-type-create").click();
    await expect(typeCard(domainTab, domainEnum)).toBeVisible();

    const productTab = await openTypes(page, workspace.productUrl);
    await expect(typeCard(productTab, domainEnum)).toHaveCount(0);
    await productTab.getByTestId("data-type-new-enum").click();
    await productTab.getByTestId("data-type-form-enum").getByTestId("data-type-name").fill(productEnum);
    await productTab.getByTestId("data-type-form-enum").getByTestId("data-type-members").fill("P1");
    await productTab.getByTestId("data-type-form-enum").getByTestId("data-type-create").click();
    await expect(toast(page, `Enum "${productEnum}" created`)).toBeVisible();
    await expect(typeCard(productTab, productEnum)).toContainText("1 value");

    // The domain's enum is shown in the product, in a read-only section with a link to where it lives.
    const inherited = productTab.getByTestId("inherited-data-types");
    await expect(inherited).toContainText("Read-only");
    await expect(inherited).toContainText(domainEnum);
    await expect(inherited.getByRole("link").first()).toHaveAttribute("href", new RegExp(`/schemas/${workspace.domainSlug}`));
    await expect(inherited.getByTestId("data-type-delete")).toHaveCount(0);

    domainTab = await openTypes(page, `/schemas/${workspace.domainSlug}`);
    await expect(typeCard(domainTab, domainEnum)).toBeVisible();
    await expect(typeCard(domainTab, productEnum)).toHaveCount(0);
  });

  test("an Enterprise enum is created on the Enterprise page and is listed read-only in a domain", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
    const name = unique("EnterpriseStatus");
    enterpriseNames.enums.push(name);
    const enterprise = await openTypes(page, "/schemas/enterprise");
    await enterprise.getByTestId("data-type-new-enum").click();
    await enterprise.getByTestId("data-type-form-enum").getByTestId("data-type-name").fill(name);
    await enterprise.getByTestId("data-type-form-enum").getByTestId("data-type-members").fill("E1, E2");
    await enterprise.getByTestId("data-type-form-enum").getByTestId("data-type-create").click();
    await expect(toast(page, `Enum "${name}" created`)).toBeVisible();
    await expect(typeCard(enterprise, name)).toBeVisible();

    const domainTab = await openTypes(page, `/schemas/${workspace.domainSlug}`);
    // Read-only in the domain: listed in the inherited section, not as one of its own cards.
    await expect(typeCard(domainTab, name)).toHaveCount(0);
    await expect(domainTab.getByTestId("inherited-data-types").filter({ hasText: name })).toContainText("Read-only");

    const again = await openTypes(page, "/schemas/enterprise");
    await deleteType(page, again, name);
    await expect(toast(page, `Enum "${name}" deleted`)).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// APIs
// ---------------------------------------------------------------------------

async function openApis(page: Page, url: string): Promise<Locator> {
  await page.goto(`${url}?tab=apis`);
  const tab = centerPanel(page).getByTestId("domain-apis-tab");
  await expect(tab).toBeVisible();
  await waitForHydration(tab.getByRole("button", { name: "New Service" }));
  return tab;
}

const serviceHeader = (tab: Locator, name: string): Locator => tab.getByRole("button", { name: new RegExp(`^${name}\\b`) });

test.describe("APIs", () => {
  test("a service is created with its base path, an operation is added and deleted, then the service; each is kept after a reload", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const service = unique("UserApi");
    const url = `/schemas/${workspace.domainSlug}`;
    let tab = await openApis(page, url);
    await expect(tab).toContainText("0 services with 0 operations");
    await expect(tab.getByText("No API services defined yet")).toBeVisible();

    await tab.getByRole("button", { name: "New Service" }).click();
    await expect(tab.getByRole("button", { name: "Create Service" })).toBeDisabled();
    await tab.getByPlaceholder("Service name").fill(service);
    await tab.getByPlaceholder("/base-path").fill("/users");
    await tab.getByRole("button", { name: "Create Service" }).click();

    await expect(serviceHeader(tab, service)).toBeVisible();
    await expect(serviceHeader(tab, service)).toContainText("/users");
    await expect(serviceHeader(tab, service)).toContainText("0 ops");
    await expect(tab).toContainText("1 service with 0 operations");
    await expect(tab.getByRole("heading", { name: "Domain APIs" })).toBeVisible();

    tab = await openApis(page, url);
    await expect(serviceHeader(tab, service)).toContainText("/users");
    await serviceHeader(tab, service).click();
    await expect(tab.getByText("No operations")).toBeVisible();
    await tab.getByRole("button", { name: "Add Operation" }).click();
    await tab.locator("select").last().selectOption("POST");
    await tab.getByPlaceholder("/path").fill("/users");
    await tab.getByPlaceholder("operationName").fill("createUser");
    await tab.getByRole("button", { name: "Add", exact: true }).click();

    const operation = tab.getByRole("button", { name: /POST\s*\/users\s*createUser/ });
    await expect(operation).toBeVisible();
    await expect(operation).toContainText("0p / 0r");
    await expect(tab).toContainText("1 service with 1 operation");
    await expect(serviceHeader(tab, service)).toContainText("1 op");

    tab = await openApis(page, url);
    await serviceHeader(tab, service).click();
    await expect(tab.getByRole("button", { name: /POST\s*\/users\s*createUser/ })).toBeVisible();
    await tab.getByTitle("Delete operation").click();
    await expect(tab.getByRole("button", { name: /createUser/ })).toHaveCount(0);
    await expect(tab).toContainText("1 service with 0 operations");

    await tab.getByTitle("Delete service").click();
    await expect(serviceHeader(tab, service)).toHaveCount(0);
    await expect(tab.getByText("No API services defined yet")).toBeVisible();
    tab = await openApis(page, url);
    await expect(serviceHeader(tab, service)).toHaveCount(0);
  });

  test.describe("in a product with an entity", () => {
    const entityName = unique("ApiEntity");
    test.use({ workspaceEntities: [entityName] });

    test("a product offers entity-scoped services: it is listed under Entity APIs with its entity", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
      const service = unique("EntityApi");
      const tab = await openApis(page, workspace.productUrl);

      await tab.getByRole("button", { name: "New Service" }).click();
      await tab.getByPlaceholder("Service name").fill(service);
      const scope = tab.locator("select").first();
      await expect(scope.locator("option")).toHaveText(["Product-scoped", "Entity-scoped"]);
      await scope.selectOption("ENTITY");
      await expect(tab.locator("select").nth(1).locator("option")).toHaveText([entityName]);
      await tab.getByPlaceholder("/base-path").fill("/entities");
      await tab.getByRole("button", { name: "Create Service" }).click();

      await expect(serviceHeader(tab, service)).toBeVisible();
      await expect(serviceHeader(tab, service)).toContainText(entityName);
      await expect(serviceHeader(tab, service)).toContainText("entity");
      // Under its own heading: the "Entity APIs" group (its heading, then its services) holds the service, the domain group does not.
      await expect(tab.getByRole("heading", { name: "Entity APIs" })).toBeVisible();
      await expect(tab.locator("div").filter({ has: page.getByRole("heading", { name: "Entity APIs" }) }).filter({ hasText: service }).last()).toBeVisible();

      await tab.getByTitle("Delete service").click();
      await expect(serviceHeader(tab, service)).toHaveCount(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Properties (traits)
// ---------------------------------------------------------------------------

async function openProperties(page: Page, url: string): Promise<Locator> {
  await page.goto(`${url}?tab=traits`);
  const tab = centerPanel(page).getByTestId("traits-tab");
  await expect(tab).toBeVisible();
  await waitForHydration(tab.getByTestId("traits-new"));
  return tab;
}

/** New Message Properties: the form, then the editor page it lands on. Resolves to the new set's id. */
async function createPropertySet(page: Page, tab: Locator, name: string, description?: string): Promise<string> {
  await tab.getByTestId("traits-new").click();
  const form = tab.getByTestId("new-trait-form");
  await form.getByLabel("Name", { exact: true }).fill(name);
  if (description) await form.getByLabel("Description", { exact: true }).fill(description);
  await form.getByRole("button", { name: /^create/i }).click();
  await expect(page).toHaveURL(/\/traits\/[^/?]+/, { timeout: 30_000 });
  await expect(centerPanel(page).getByRole("heading", { level: 1, name: new RegExp(name) })).toBeVisible();
  return new URL(page.url()).pathname.split("/traits/")[1];
}

test.describe("properties of a domain", () => {
  test("an empty domain says so; a set is created (and opens its editor), renamed and saved, kept after a reload, listed on the tab, and deleted after a confirmation", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const name = unique("Audit");
    const renamed = unique("AuditRenamed");
    const url = `/schemas/${workspace.domainSlug}`;
    let tab = await openProperties(page, url);
    await expect(tab.getByTestId("traits-empty")).toHaveText("No message properties at this level yet.");

    const id = await createPropertySet(page, tab, name, "Headers every audited message carries");
    expect(new URL(page.url()).pathname).toBe(`/schemas/${workspace.domainSlug}/traits/${id}`);
    await expect(centerPanel(page).getByTestId("trait-editor-name")).toHaveValue(name);
    await expect(centerPanel(page).getByTestId("trait-editor-badge")).toBeVisible();
    await expect(centerPanel(page).getByTestId("trait-editor-builtin-badge")).toHaveCount(0);

    await centerPanel(page).getByTestId("trait-editor-name").fill(renamed);
    await centerPanel(page).getByTestId("trait-save").click();
    await expect(toast(page, "Message properties saved")).toBeVisible();

    await page.reload();
    await expect(centerPanel(page).getByTestId("trait-editor-name")).toHaveValue(renamed);
    await expect(centerPanel(page).getByRole("heading", { level: 1, name: new RegExp(renamed) })).toBeVisible();

    // More details: collapsed by default, with a count of what it holds, opens a region.
    await centerPanel(page).getByTestId("trait-editor-more-toggle").click();
    await expect(centerPanel(page).getByTestId("trait-editor-more")).toBeVisible();

    tab = await openProperties(page, url);
    const card = tab.getByTestId(`trait-card-${id}`);
    await expect(card).toContainText(renamed);
    // A set with no properties shows no count (the card counts what it brings); the cards of sets that bring some say how many.
    await expect(tab.getByTestId(`trait-card-${id}-count`)).toHaveCount(0);
    await expect(tab.getByTestId("traits-empty")).toHaveCount(0);
    await card.click();
    await expect(page).toHaveURL(new RegExp(`/traits/${id}$`));

    // Delete asks first (a browser confirm): dismissing it keeps the set.
    page.once("dialog", (dialog) => void dialog.dismiss());
    await centerPanel(page).getByTestId("trait-delete").click();
    await expect(centerPanel(page).getByTestId("trait-editor-name")).toHaveValue(renamed);
    page.once("dialog", (dialog) => void dialog.accept());
    await centerPanel(page).getByTestId("trait-delete").click();
    await expect(page).toHaveURL(new RegExp(`/schemas/${workspace.domainSlug}\\?tab=traits`));
    await expect(centerPanel(page).getByTestId("traits-empty")).toBeVisible();
  });

  test("an operation set has its own fields (title, summary, description) and is kept", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
    const name = unique("OpSet");
    const tab = await openProperties(page, `/schemas/${workspace.domainSlug}`);
    await tab.getByTestId("traits-new").click();
    const form = tab.getByTestId("new-trait-form");
    await form.getByLabel("Name", { exact: true }).fill(name);
    await form.getByLabel("Applies to").selectOption("OPERATION");
    await form.getByRole("button", { name: /^create/i }).click();
    await expect(page).toHaveURL(/\/traits\/[^/?]+/, { timeout: 30_000 });

    const editor = centerPanel(page).getByTestId("trait-editor-form");
    await expect(editor).toBeVisible();
    await expect(editor.getByTestId("trait-editor-title")).toBeVisible();
    await expect(editor.getByTestId("trait-editor-summary")).toBeVisible();
    await editor.getByTestId("trait-editor-summary").fill("Marks a call as audited");
    await centerPanel(page).getByTestId("trait-save").click();
    await expect(toast(page, "Operation properties saved")).toBeVisible();

    await page.reload();
    await expect(centerPanel(page).getByTestId("trait-editor-form").getByTestId("trait-editor-summary")).toHaveValue("Marks a call as audited");
  });

  test("a blank name is refused and nothing is created", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
    const tab = await openProperties(page, `/schemas/${workspace.domainSlug}`);
    await tab.getByTestId("traits-new").click();
    const form = tab.getByTestId("new-trait-form");
    await form.getByLabel("Name", { exact: true }).fill("   ");
    await form.getByRole("button", { name: /^create/i }).click();
    await expect(form.getByRole("alert")).toBeVisible();
    await expect(page).not.toHaveURL(/\/traits\//);
    await expect(tab.getByTestId("traits-empty")).toBeVisible();
  });
});

test.describe("Enterprise properties", () => {
  test("an Enterprise set is created on the Enterprise page, opens in the same editor, is listed read-only on a domain's tab, and is deleted", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const name = unique("EnterpriseAudit");
    enterpriseNames.traits.push(name);
    const tab = await openProperties(page, "/schemas/enterprise");
    const id = await createPropertySet(page, tab, name);
    expect(new URL(page.url()).pathname).toBe(`/schemas/enterprise/traits/${id}`);
    await expect(centerPanel(page).getByTestId("trait-editor-name")).toHaveValue(name);

    // On a domain: listed under the Enterprise heading, as a link to the set's own page, with no way to create or edit it there.
    const domainTab = await openProperties(page, `/schemas/${workspace.domainSlug}`);
    await expect(domainTab.getByTestId("traits-empty")).toBeVisible();
    const card = domainTab.getByTestId(`trait-card-${id}`);
    await expect(card).toContainText(name);
    await expect(card).toHaveAttribute("href", `/schemas/enterprise/traits/${id}`);
    await card.click();
    await expect(page).toHaveURL(new RegExp(`/schemas/enterprise/traits/${id}$`));

    page.once("dialog", (dialog) => void dialog.accept());
    await centerPanel(page).getByTestId("trait-delete").click();
    await expect(page).toHaveURL(/\/schemas\/enterprise\?tab=traits/);
    await expect(centerPanel(page).getByTestId(`trait-card-${id}`)).toHaveCount(0);
  });
});
