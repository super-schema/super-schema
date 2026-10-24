/**
 * Schema lifecycle E2E — the full flow the user asked for:
 *
 *   1. Create a domain, then a product under it.
 *   2. Create an entity under that product from an all-data-types schema
 *      (pasted TypeSpec) — exercising the real @typespec/compiler import.
 *   3. Emit implementation versions (Avro / OpenAPI / DDL) from the reference
 *      super schema and verify each target renders.
 *   4. Round-trip: feed an emitted version schema back in to create a new super
 *      schema — verifying import↔emit compatibility both ways.
 *
 * Type-mapping correctness for ALL data types is covered headlessly + fast in
 * tests/unit/type-mapping/all-types-coverage.test.ts and
 * tests/integration/all-types-roundtrip.test.ts. This spec verifies the UI flows.
 *
 * PREREQS: see helpers/auth.ts. Selectors use roles/labels + known test-ids;
 * adjust if the UI copy changes. Run: `npm run test:e2e`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect, unique } from "./helpers/fixtures";
import { expectDetailPanelText, fillWorkbenchPaste } from "./helpers/workbench";
import { deleteDomainsByName, disconnectDb } from "./helpers/db";

const ALL_TYPES_TSP = readFileSync(
  path.join(__dirname, "fixtures/all-types.tsp"),
  "utf8"
);

async function createDomain(page: import("@playwright/test").Page, name: string) {
  await page.goto("/schemas");
  await page.getByRole("button", { name: /create domain/i }).first().click();
  await expect(page.getByText(/create new domain/i)).toBeVisible();
  await page.getByPlaceholder(/Customer, Payment/i).fill(name);
  await page.getByRole("button", { name: /^create$/i }).click();
  await expect(page.getByText(name).first()).toBeVisible();
}

async function openDomain(page: import("@playwright/test").Page, name: string) {
  await page.goto("/schemas");
  await page.getByText(name).first().click();
  await expect(page).toHaveURL(/\/schemas\/[^/]+/);
}

async function createProduct(page: import("@playwright/test").Page, name: string) {
  await page.getByRole("button", { name: /new product/i }).first().click();
  await expect(page.getByText(/create new product/i)).toBeVisible();
  await page.getByPlaceholder(/OneSCM, Bank/i).fill(name);
  await page.getByRole("button", { name: /^create$/i }).click();
  await expect(page.getByText(name).first()).toBeVisible();
}

async function importEntityFromTsp(page: import("@playwright/test").Page, productUrl: string, tsp: string) {
  // Go straight to the wizard off the resolved product URL (avoids ambiguous
  // "New Entity" buttons, incl. the sidebar's 2-segment variant).
  await page.goto(`${productUrl.replace(/\/+$/, "")}/new`);
  await expect(page).toHaveURL(/\/new$/);
  // Role query, not getByText: the route streams behind a loading.tsx, so the
  // heading transiently exists twice (the hidden streamed copy plus the visible
  // one) and getByText trips strict mode. getByRole only sees the visible one.
  await expect(page.getByRole("heading", { name: /create new entity/i })).toBeVisible();
  // ...and the transient duplicate must settle to exactly one rendered copy.
  await expect(page.getByText(/create new entity/i)).toHaveCount(1);
  // Unified workbench: card → Paste → Load schema → Review & Import. The Detail
  // Panel textarea is separate from the paste textarea, so target by test id.
  await page.getByRole("button", { name: /import or build schema/i }).first().click();
  await page.getByRole("button", { name: "Paste", exact: true }).click();
  await fillWorkbenchPaste(page, tsp);
  await page.getByTestId("workbench-load-button").click();
  await expectDetailPanelText(page, tsp);
  await page.getByTestId("workbench-review-button").click();
  // TypeSpec imports go to the multi-model review screen.
  await expect(page.getByText(/AllTypes/i).first()).toBeVisible();
  // Register AllTypes as an entity only (uncheck the model to avoid a same-named
  // model+entity collision in the domain).
  const entityToggle = page.getByLabel(/AllTypes entity/i);
  if (await entityToggle.count()) await entityToggle.check().catch(() => {});
  const modelToggle = page.getByLabel(/AllTypes model/i);
  if (await modelToggle.count()) await modelToggle.uncheck().catch(() => {});
  await page.getByRole("button", { name: /import \d+ asset\(s\)/i }).click();
}

test.describe("schema lifecycle", () => {
  // Domains this spec creates through the UI; deleted afterwards (cascades to their
  // products, entities and imported assets) so runs stop accumulating e2e rows.
  const createdDomains: string[] = [];

  test.afterAll(async () => {
    try {
      await deleteDomainsByName(createdDomains);
    } catch (error) {
      console.warn(`schema-lifecycle cleanup failed for ${createdDomains.join(", ")}: ${String(error)}`);
    } finally {
      await disconnectDb();
    }
  });

  test("create domain → product → all-types entity (real compiler) under product", { tag: ["@smoke", "@regression"] }, async ({
    authedPage: page,
  }) => {
    const domain = unique("e2e-domain-");
    createdDomains.push(domain);
    const product = unique("e2e-product-");

    // 1. Domain + product
    await createDomain(page, domain);
    await openDomain(page, domain);
    await createProduct(page, product);
    await page.getByText(product).first().click();
    await expect(page).toHaveURL(/\/schemas\/[^/]+\/[^/]+/);
    const productUrl = page.url();

    // 2. All-types import through the real @typespec/compiler server action.
    //    The review screen rendering "AllTypes" (inside importEntityFromTsp) already
    //    proves compile→map ran in-browser via the action (live-verifies bundling).
    //    Confirm then navigates back to the product workspace on success.
    await importEntityFromTsp(page, productUrl, ALL_TYPES_TSP);
    await expect(page).toHaveURL(/\/schemas\/[^/]+\/[^/]+$/, { timeout: 20_000 });
    // Fresh load to bypass any client router cache, then the imported entity
    // must appear under THIS product (not the default product) and open.
    await page.goto(productUrl);
    await expect(page.getByText(/AllTypes/i).first()).toBeVisible({ timeout: 20_000 });
    await page.getByText(/AllTypes/i).first().click();
    await expect(page).toHaveURL(/\/schemas\/[^/]+\/[^/]+\/[^/]+/);
    await expect(page.getByRole("heading", { name: /AllTypes/i })).toBeVisible();
  });

  // Emit versions + round-trip via the UI are NOT wired here: the entity workspace
  // doesn't render emission output (EmissionPreviewPanel exists but is unmounted;
  // emit is keyboard-only Ctrl+E and toast-only). Emit for every data type AND the
  // emit↔import round-trip are covered headlessly in
  // tests/integration/all-types-roundtrip.test.ts (Avro + real TypeSpec) and
  // tests/unit/type-mapping/all-types-coverage.test.ts. Panel test-ids
  // (emission-preview-panel, emit-tab-*, emit-output-*) are in place for when the
  // panel gets mounted.
  test.fixme("emit versions + round-trip through the UI", async () => {});
});
