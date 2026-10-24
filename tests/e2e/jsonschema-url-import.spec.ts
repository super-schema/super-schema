/**
 * JSON Schema import by URL (plan Task 13): the workbench's "From URL" mode through the real UI.
 *
 * Only the refusal path is exercised: a loopback URL is blocked by the server action's SSRF guard, and the UI must show the
 * sanitized error (role="alert") and stay usable. A successful fetch needs a reachable https host and is not covered here; the
 * resolver / action behaviour is covered by the unit and integration tests of Tasks 6-8.
 *
 * PREREQS: see helpers/auth.ts. Creates a domain and product; cleanup needs DATABASE_URL (see helpers/db.ts), skipped with a
 * warning on PGlite.
 */

import { test, expect, unique } from "./helpers/fixtures";
import { deleteDomainsByName, disconnectDb } from "./helpers/db";

type Page = import("@playwright/test").Page;

async function createDomain(page: Page, name: string) {
  await page.goto("/schemas");
  await page.getByRole("button", { name: /create domain/i }).first().click();
  await page.getByPlaceholder(/Customer, Payment/i).fill(name);
  await page.getByRole("button", { name: /^create$/i }).click();
  await expect(page.getByText(name).first()).toBeVisible();
}

async function createProduct(page: Page, domain: string, name: string): Promise<string> {
  await page.goto("/schemas");
  await page.getByText(domain).first().click();
  await expect(page).toHaveURL(/\/schemas\/[^/]+/);
  await page.getByRole("button", { name: /new product/i }).first().click();
  await page.getByPlaceholder(/OneSCM, Bank/i).fill(name);
  await page.getByRole("button", { name: /^create$/i }).click();
  await expect(page.getByText(name).first()).toBeVisible();
  await page.getByText(name).first().click();
  await expect(page).toHaveURL(/\/schemas\/[^/]+\/[^/]+/);
  return page.url();
}

test.describe("JSON Schema import by URL", () => {
  const createdDomains: string[] = [];

  test.afterAll(async () => {
    try {
      await deleteDomainsByName(createdDomains);
    } catch (error) {
      console.warn(`jsonschema-url-import cleanup failed for ${createdDomains.join(", ")}: ${String(error)}`);
    } finally {
      await disconnectDb().catch(() => undefined);
    }
  });

  test("a blocked URL shows the sanitized error and the form stays usable", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    const domain = unique("e2e-url-domain-");
    createdDomains.push(domain);
    await createDomain(page, domain);
    const productUrl = await createProduct(page, domain, unique("e2e-url-product-"));

    await page.goto(`${productUrl.replace(/\/+$/, "")}/new`);
    await page.getByRole("button", { name: /import or build schema/i }).first().click();
    await page.getByRole("button", { name: "From URL", exact: true }).click();

    const input = page.getByTestId("workbench-url-input");
    const fetchButton = page.getByTestId("workbench-url-fetch-button");
    await expect(input).toBeVisible();

    // Client-side check: nothing is sent for an obviously bad value.
    await fetchButton.click();
    await expect(page.getByTestId("workbench-url-error")).toBeVisible();

    // The server refuses a loopback address.
    await input.fill("http://127.0.0.1:9/x.json");
    await fetchButton.click();
    const error = page.getByTestId("workbench-url-error");
    await expect(error).toHaveAttribute("role", "alert");
    // The refusal is the server's: the scheme guard's message, not the client-side "enter the URL" one.
    await expect(error).toContainText(/could not be loaded/i, { timeout: 30_000 });
    await expect(fetchButton).toBeEnabled();
    // Still on the workbench: no review screen, no crash.
    await expect(page.getByTestId("typespec-import-review")).toHaveCount(0);
  });
});
