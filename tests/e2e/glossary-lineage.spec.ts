/**
 * The Business Glossary (`/glossary`) and the Lineage Graph (`/lineage`).
 *
 * What the glossary does (each line is a test): a concept (name, domain, definition, synonyms, canonical type, classification, tags) is
 * created through the dialog, which refuses a blank and a duplicate name; it is listed as a card (and kept after a reload) and opens in
 * a detail panel; the list is searched (name, definition) and narrowed by domain; the seeded concepts are there; a concept's linked
 * fields are counted on its card (KD-017: the detail panel never lists them).
 *
 * What the lineage graph does: it draws an entity for every relationship in the tenant being viewed, and an edge for each relationship:
 * a reference field added through the field editor is one (a reference is many-to-one: `N:1`); an entity with none is not drawn; a click
 * on an entity opens its popover (description, fields with type and classification, "Open in Editor"); the domain filter narrows the
 * graph; "Fit" brings the viewport back; the graph of another tenant is not drawn, and a tenant with no relationships says so.
 *
 * NOT AVAILABLE IN THE UI (nothing was invented for it): editing or deleting a concept (the page offers neither: a concept is made and
 * read), the Suggestions widget (GlossarySuggestions is rendered by no page: a unit-tested component nothing mounts), linking a field to
 * a concept (no page offers it: the rows of `field_concept_links` can only be written by the glossary actions nothing calls), an edge
 * for a relationship stored in the entity's metadata (the editor offers no control to make one).
 *
 * Page content is queried inside the center panel (`centerPanel`): a hard load streams the page behind its loading.tsx and Next leaves
 * a hidden copy of the streamed segment in <body>.
 */
import type { Locator, Page } from "@playwright/test";
import {
  createFieldRow,
  createReferenceFieldRow,
  createSecondTenant,
  createEntityInTenant,
  deleteConceptsByName,
  deleteTenantWithDomain,
  disconnectDb,
  keyFieldId,
  linkFieldToConceptRow,
} from "./helpers/db";
import { addReferenceField, openEntityPage } from "./helpers/entity-page";
import { centerPanel } from "./helpers/event-builder";
import { test, expect, unique, createDbWorkspace } from "./helpers/fixtures";
import { waitForHydration } from "./helpers/hydration";

const createdConcepts: string[] = [];

test.afterAll(async () => {
  try {
    await deleteConceptsByName(createdConcepts);
  } catch (error) {
    console.warn(`glossary-lineage.spec cleanup failed: ${String(error)}`);
  } finally {
    await disconnectDb();
  }
});

// ---------------------------------------------------------------------------
// Glossary
// ---------------------------------------------------------------------------

async function openGlossary(page: Page): Promise<void> {
  await page.goto("/glossary");
  await expect(page.getByRole("heading", { name: "Business Glossary", level: 1 })).toBeVisible();
  await waitForHydration(centerPanel(page).getByTestId("glossary-browser"));
  await expect(centerPanel(page).getByText("Loading concepts...")).toHaveCount(0);
}

const card = (page: Page, name: string): Locator => centerPanel(page).locator(`[data-testid="concept-card"][data-name="${name}"]`);
const dialog = (page: Page): Locator => page.getByTestId("concept-dialog");
const searchBox = (page: Page): Locator => centerPanel(page).getByTestId("glossary-search");

interface ConceptInput {
  name: string;
  domain?: string;
  definition?: string;
  synonyms?: string;
  type?: string;
  classification?: string;
  tags?: string;
}

/** Open the dialog and fill it (not submitted). */
async function fillConcept(page: Page, input: ConceptInput): Promise<Locator> {
  await centerPanel(page).getByTestId("glossary-new-concept").click();
  const form = dialog(page);
  await expect(form).toBeVisible();
  await form.getByTestId("concept-name").fill(input.name);
  if (input.domain) await form.getByTestId("concept-domain").selectOption(input.domain);
  if (input.definition) await form.getByTestId("concept-definition").fill(input.definition);
  if (input.synonyms) await form.getByTestId("concept-synonyms").fill(input.synonyms);
  if (input.type) await form.getByTestId("concept-type").selectOption(input.type);
  if (input.classification) await form.getByTestId("concept-classification").selectOption(input.classification);
  if (input.tags) await form.getByTestId("concept-tags").fill(input.tags);
  return form;
}

/** Create a concept through the dialog, wait for its card. */
async function createConcept(page: Page, input: ConceptInput): Promise<void> {
  createdConcepts.push(input.name);
  const form = await fillConcept(page, input);
  await form.getByTestId("concept-submit").click();
  await expect(form).toBeHidden();
  await searchBox(page).fill(input.name);
  await expect(card(page, input.name)).toBeVisible();
}

test.describe("glossary", () => {
  test("a concept is created with all its attributes, listed as a card, kept after a reload, and opens in the detail panel", { tag: ["@regression"] }, async ({
    authedPage: page,
  }) => {
    const name = unique("E2E Concept ");
    await openGlossary(page);
    await createConcept(page, {
      name,
      domain: "Finance",
      definition: "The amount a customer owes after discounts",
      synonyms: "amt_due, amountDue",
      type: "decimal",
      classification: "SENSITIVE",
      tags: "financial, billing",
    });

    const concept = card(page, name);
    await expect(concept).toContainText("The amount a customer owes after discounts");
    await expect(concept).toContainText("decimal");
    await expect(concept).toContainText("SENSITIVE");
    await expect(concept).toContainText("amt_due");
    await expect(concept).toContainText("amountDue");
    await expect(concept).toContainText("#financial");
    await expect(concept).toContainText("#billing");
    await expect(concept).toContainText("0 fields linked");

    await openGlossary(page);
    await searchBox(page).fill(name);
    await expect(card(page, name)).toBeVisible();

    // The detail panel: the same attributes, the linked fields, and a second click (or Close) closes it.
    await card(page, name).click();
    const detail = centerPanel(page).getByTestId("concept-detail-panel");
    await expect(detail.getByRole("heading", { name, level: 2 })).toBeVisible();
    await expect(detail).toContainText("Finance domain");
    await expect(detail).toContainText("The amount a customer owes after discounts");
    await expect(detail).toContainText("amt_due");
    await expect(detail).toContainText("#billing");
    await expect(detail).toContainText("Linked Fields (0 fields across 0 entities)");
    await expect(detail).toContainText("No fields linked to this concept yet.");
    await detail.getByRole("button", { name: "Close" }).click();
    await expect(detail).toHaveCount(0);
    await card(page, name).click();
    await expect(detail).toBeVisible();
    await card(page, name).click();
    await expect(detail).toHaveCount(0);
  });

  test("a blank name is refused in the dialog, a duplicate name is refused by the server, and Cancel creates nothing", { tag: ["@regression"] }, async ({
    authedPage: page,
  }) => {
    const name = unique("E2E Dup ");
    await openGlossary(page);
    await createConcept(page, { name, definition: "first" });

    const blank = await fillConcept(page, { name: "   " });
    await blank.getByTestId("concept-submit").click();
    await expect(blank.getByTestId("concept-error")).toHaveText("Concept name is required");
    await blank.getByRole("button", { name: "Cancel" }).click();
    await expect(blank).toBeHidden();

    const duplicate = await fillConcept(page, { name, definition: "second" });
    await duplicate.getByTestId("concept-submit").click();
    await expect(duplicate.getByTestId("concept-error")).toHaveText(`A concept named "${name}" already exists`);
    await expect(duplicate).toBeVisible();
    await duplicate.getByRole("button", { name: "Cancel" }).click();

    // Cancel (and the refusals) left one concept of that name, still with the first definition.
    await searchBox(page).fill(name);
    await expect(centerPanel(page).getByTestId("concept-card")).toHaveCount(1);
    await expect(card(page, name)).toContainText("first");

    const cancelled = unique("E2E Cancelled ");
    const cancelForm = await fillConcept(page, { name: cancelled });
    await cancelForm.getByRole("button", { name: "Cancel" }).click();
    await searchBox(page).fill(cancelled);
    await expect(centerPanel(page).getByText("No business concepts found.")).toBeVisible();
    await expect(centerPanel(page).getByText("Try adjusting your filters.")).toBeVisible();
  });

  test("the search finds a concept by name or by a word of its definition, case-insensitively, and the domain tabs narrow the list", { tag: ["@regression"] }, async ({
    authedPage: page,
  }) => {
    const finance = unique("E2E Fin ");
    const health = unique("E2E Health ");
    const word = unique("zorbquux").toLowerCase();
    await openGlossary(page);
    await createConcept(page, { name: finance, domain: "Finance", definition: `A balance held in ${word} accounts` });
    await createConcept(page, { name: health, domain: "Healthcare", definition: `A visit that ${word} records` });

    // By a word of the definition: both. By a part of a name, in any case: one.
    await searchBox(page).fill(word.toUpperCase());
    await expect(card(page, finance)).toBeVisible();
    await expect(card(page, health)).toBeVisible();
    await searchBox(page).fill(finance.toUpperCase());
    await expect(card(page, finance)).toBeVisible();
    await expect(card(page, health)).toHaveCount(0);

    // The domain tab: the same search, one domain.
    await searchBox(page).fill(word);
    await centerPanel(page).locator('[data-testid="glossary-domain-tab"][data-domain="Finance"]').click();
    await expect(centerPanel(page).locator('[data-testid="glossary-domain-tab"][data-domain="Finance"]')).toHaveAttribute("aria-pressed", "true");
    await expect(card(page, finance)).toBeVisible();
    await expect(card(page, health)).toHaveCount(0);
    // The tabs are the domains of what is listed (KD-018): with Finance chosen, Healthcare is not a tab until All is.
    await expect(centerPanel(page).locator('[data-testid="glossary-domain-tab"][data-domain="Healthcare"]')).toHaveCount(0);
    await centerPanel(page).locator('[data-testid="glossary-domain-tab"][data-domain="All"]').click();
    await expect(card(page, finance)).toBeVisible();
    await expect(card(page, health)).toBeVisible();
    await centerPanel(page).locator('[data-testid="glossary-domain-tab"][data-domain="Healthcare"]').click();
    await expect(card(page, health)).toBeVisible();
    await expect(card(page, finance)).toHaveCount(0);
  });

  test("the seeded concepts are there: Customer Identifier is an Identity string classified PII with its synonyms", { tag: ["@regression"] }, async ({
    authedPage: page,
  }) => {
    await openGlossary(page);
    await searchBox(page).fill("Customer Identifier");
    const seeded = card(page, "Customer Identifier");
    await expect(seeded).toBeVisible();
    await expect(seeded).toContainText("A unique identifier assigned to each customer across all systems");
    await expect(seeded).toContainText("string");
    await expect(seeded).toContainText("PII");
    await expect(seeded).toContainText("cust_id");
    await expect(seeded).toContainText("#identity");

    await centerPanel(page).locator('[data-testid="glossary-domain-tab"][data-domain="Identity"]').click();
    await expect(seeded).toBeVisible();
    await expect(centerPanel(page).locator('[data-testid="glossary-domain-tab"][data-domain="Identity"]')).toHaveAttribute("aria-pressed", "true");
  });

  test.describe("with a field linked", () => {
    test.use({ workspaceEntities: [unique("GlossEnt")] });

    test("a concept with a field linked counts it on its card", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
      const name = unique("E2E Linked ");
      await openGlossary(page);
      await createConcept(page, { name, definition: "has a link" });
      await linkFieldToConceptRow(await keyFieldId(workspace.entities[0].id), name);

      await openGlossary(page);
      await searchBox(page).fill(name);
      await expect(card(page, name)).toContainText("1 field linked");
    });

    // KD-017: GlossaryBrowser's getUsage returns `fields: []` whatever the concept's links are.
    test.fail("[KD-017 the detail panel lists no linked fields] the detail panel lists the field a concept is linked to", { tag: ["@regression"] }, async ({
      authedPage: page,
      workspace,
    }) => {
      const name = unique("E2E LinkedPanel ");
      await openGlossary(page);
      await createConcept(page, { name, definition: "has a link" });
      await linkFieldToConceptRow(await keyFieldId(workspace.entities[0].id), name);

      await openGlossary(page);
      await searchBox(page).fill(name);
      await expect(card(page, name)).toContainText("1 field linked");
      await card(page, name).click();
      await expect(centerPanel(page).getByTestId("concept-detail-panel")).toContainText("Linked Fields (1 field across 1 entity)");
    });
  });
});

// ---------------------------------------------------------------------------
// Lineage
// ---------------------------------------------------------------------------

async function openLineage(page: Page): Promise<void> {
  await page.goto("/lineage");
  await expect(page.getByRole("heading", { name: "Lineage Graph", level: 1 })).toBeVisible();
}

const node = (page: Page, entityId: string): Locator => centerPanel(page).getByTestId(`lineage-node-${entityId}`);
const edge = (page: Page, fromId: string, toId: string): Locator => centerPanel(page).getByTestId(`rf__edge-${fromId}-${toId}`);
const viewport = (page: Page): Locator => centerPanel(page).locator(".react-flow__viewport");

test.describe("lineage", () => {
  const source = unique("LinSrc");
  const target = unique("LinDst");
  const lone = unique("LinLone");
  test.use({ workspaceEntities: [source, target, lone] });

  test("a reference field added in the field editor draws both entities and an N:1 edge between them; an entity with no relationship is not drawn", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const [from, to, alone] = workspace.entities;
    await openEntityPage(page, from.url, source);
    await addReferenceField(page, "target_ref", { name: target });

    await openLineage(page);
    await expect(node(page, from.id)).toBeVisible();
    await expect(node(page, to.id)).toBeVisible();
    await expect(node(page, from.id)).toContainText(source);
    await expect(node(page, to.id)).toContainText(target);
    await expect(node(page, from.id)).toContainText(workspace.domainName);
    await expect(node(page, from.id)).toContainText("2 fields");
    await expect(node(page, to.id)).toContainText("1 field");

    await expect(edge(page, from.id, to.id)).toBeAttached();
    await expect(edge(page, from.id, to.id)).toContainText("N:1");
    // The direction: from the entity that holds the reference to the one it references.
    await expect(edge(page, to.id, from.id)).toHaveCount(0);

    await expect(node(page, alone.id)).toHaveCount(0);
  });

  test("clicking an entity opens its popover with the fields, their types and classification; Open in Editor opens the entity", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const [from, to] = workspace.entities;
    await createReferenceFieldRow(from.id, { id: to.id, name: target });
    await createFieldRow(from.id, { name: "ssn", classification: "PII", sortOrder: 6 });
    await createFieldRow(from.id, { name: "salary", type: "decimal", classification: "SENSITIVE", sortOrder: 7 });

    await openLineage(page);
    const source_ = node(page, from.id);
    await expect(source_).toBeVisible();
    await expect(source_).toContainText("4 fields");
    await expect(source_).toContainText("1 PII");
    await expect(source_).toContainText("1 SENSITIVE");

    await source_.click();
    const popover = centerPanel(page).getByTestId(`lineage-popover-${from.id}`);
    await expect(popover.getByRole("heading", { name: source, level: 2 })).toBeVisible();
    const rows = popover.getByRole("row");
    await expect(rows.filter({ hasText: "ssn" })).toContainText("string");
    await expect(rows.filter({ hasText: "ssn" })).toContainText("PII");
    await expect(rows.filter({ hasText: "salary" })).toContainText("decimal");
    await expect(rows.filter({ hasText: "salary" })).toContainText("SENSITIVE");
    await expect(rows.filter({ hasText: "target_ref" })).toContainText("reference");
    await expect(rows.filter({ hasText: /^id/ })).toContainText("string");

    // A second click on the entity (and the close button) closes the popover.
    await popover.getByRole("button", { name: "Close popover" }).click();
    await expect(popover).toHaveCount(0);
    await source_.click();
    await expect(popover).toBeVisible();

    await popover.getByTestId(`open-editor-${from.id}`).click();
    await expect(page).toHaveURL(new RegExp(`/schemas/${workspace.domainSlug}/${workspace.productSlug}/${from.slug}$`));
    await expect(centerPanel(page).getByRole("heading", { level: 1, name: source })).toBeVisible();
  });

  test("the domain filter lists the domains of the drawn entities and narrows the graph to one", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
    const other = await createDbWorkspace([unique("LinOtherA"), unique("LinOtherB")]);
    try {
      await createReferenceFieldRow(workspace.entities[0].id, workspace.entities[1]);
      await createReferenceFieldRow(other.entities[0].id, other.entities[1]);

      await openLineage(page);
      const filter = centerPanel(page).getByTestId("domain-filter");
      await expect(node(page, workspace.entities[0].id)).toBeVisible();
      await expect(node(page, other.entities[0].id)).toBeVisible();
      await expect(filter).toContainText(workspace.domainName);
      await expect(filter).toContainText(other.domainName);

      await filter.selectOption({ label: workspace.domainName });
      await expect(node(page, workspace.entities[0].id)).toBeVisible();
      await expect(node(page, workspace.entities[1].id)).toBeVisible();
      await expect(edge(page, workspace.entities[0].id, workspace.entities[1].id)).toBeAttached();
      await expect(node(page, other.entities[0].id)).toHaveCount(0);
      await expect(node(page, other.entities[1].id)).toHaveCount(0);

      await filter.selectOption({ label: other.domainName });
      await expect(node(page, other.entities[0].id)).toBeVisible();
      await expect(node(page, workspace.entities[0].id)).toHaveCount(0);

      await filter.selectOption("all");
      await expect(node(page, workspace.entities[0].id)).toBeVisible();
      await expect(node(page, other.entities[0].id)).toBeVisible();
    } finally {
      await other.cleanup();
    }
  });

  test("'Fit' brings the viewport back after the graph was zoomed", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
    await createReferenceFieldRow(workspace.entities[0].id, workspace.entities[1]);
    await openLineage(page);
    await expect(node(page, workspace.entities[0].id)).toBeVisible();
    // The initial fit runs 50 ms after the graph is ready: the viewport has settled when two reads, 300 ms apart, are the same.
    let fitted = "";
    await expect
      .poll(
        async () => {
          const current = (await viewport(page).getAttribute("style")) ?? "";
          const settled = current !== "" && current === fitted;
          fitted = current;
          return settled;
        },
        { intervals: [300] },
      )
      .toBe(true);

    const pane = centerPanel(page).locator(".react-flow__pane");
    const box = (await pane.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -1500);
    await expect(viewport(page)).not.toHaveAttribute("style", fitted);

    await centerPanel(page).getByTestId("fit-to-view").click();
    // Fitting animates for 300 ms and ends where the first fit did.
    await expect(viewport(page)).toHaveAttribute("style", fitted);
  });

  test("an entity of another tenant, and its references, are not drawn", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
    const other = await createSecondTenant();
    try {
      const a = await createEntityInTenant(other.tenantId, unique("ForeignLinA"));
      const b = await createEntityInTenant(other.tenantId, unique("ForeignLinB"));
      await createReferenceFieldRow(a.id, { id: b.id, name: "ForeignLinB" });
      // This tenant has a pair of its own: it is drawn, which says the page has answered before the other tenant's absence means anything.
      const [from, to] = workspace.entities;
      await createReferenceFieldRow(from.id, to);

      await openLineage(page);
      await expect(node(page, from.id)).toBeVisible();
      await expect(node(page, to.id)).toBeVisible();
      await expect(node(page, a.id)).toHaveCount(0);
      await expect(node(page, b.id)).toHaveCount(0);
      await expect(edge(page, a.id, b.id)).toHaveCount(0);
    } finally {
      await deleteTenantWithDomain(other);
    }
  });

  test("a tenant with no relationships says so instead of drawing an empty graph", { tag: ["@regression"] }, async ({ authedPage: page, baseURL }) => {
    const other = await createSecondTenant();
    try {
      // The tenant the browser is viewing is the `active_tenant` cookie (what the tenant switcher sets).
      await page.context().addCookies([{ name: "active_tenant", value: other.tenantId, url: baseURL! }]);
      await openLineage(page);
      await expect(centerPanel(page).getByTestId("lineage-empty-state")).toBeVisible();
      await expect(centerPanel(page).getByRole("heading", { name: "No entity relationships found" })).toBeVisible();
      await expect(centerPanel(page).getByText("Create references between entities to see the lineage graph.")).toBeVisible();
    } finally {
      await deleteTenantWithDomain(other);
    }
  });
});
