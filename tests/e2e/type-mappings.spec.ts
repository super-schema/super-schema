/**
 * The Type Mapping Reference (`/schemas/type-mappings`): pick a logical type, read how each technology stores it.
 *
 * What the page does (each line is a test):
 *   - it opens on `int32` and has a row for each technology of the Schemas tab that has a type mapping (the catalog entries with
 *     `enabledInSchemaTab` and mappings: BigQuery, Avro, Spanner, PostgreSQL and Protobuf; docs/testing/known-defects.md KD-013 for
 *     the enabled technologies that have none);
 *   - choosing a logical type re-renders the table for it, with the physical type each technology maps it to: string is `STRING` in
 *     BigQuery, `text` in PostgreSQL, `STRING(MAX)` in Spanner, `string` in Avro (a wiring error between the picker, the matrix and the
 *     catalog shows here as the wrong type in the wrong row);
 *   - a lossy mapping says what is lost (uint64 in BigQuery's signed INT64) and the header counts it as risky;
 *   - the search box narrows the list of logical types by id, label or description, and says so when nothing matches.
 *
 * Read-only: the page changes nothing, so the tests share the one server without any fixture.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./helpers/fixtures";
import { SCHEMA_TARGETS_FOR_TESTS as ENABLED_TARGETS } from "./helpers/targets";

const PATH = "/schemas/type-mappings";

/** The technologies the page tabulates, in catalog order: the enabled ones that have a mapping table (see the header). */
const TABULATED = ["BigQuery DDL", "Avro Schema", "Spanner DDL", "PostgreSQL DDL", "Protobuf (TypeSpec)"] as const;

async function openReference(page: Page): Promise<void> {
  await page.goto(PATH);
  await expect(page.getByRole("heading", { name: "Type Mapping Reference", level: 1 })).toBeVisible();
}

/** The logical-type button in the left list (its name starts with the type's label). */
const typeButton = (page: Page, id: string): Locator => page.getByRole("button", { name: new RegExp(`^${id}\\b`) }).first();

async function chooseType(page: Page, id: string): Promise<void> {
  await typeButton(page, id).click();
  await expect(typeButton(page, id)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("table", { name: `Type mappings for ${id}` })).toBeVisible();
}

/** The row of a technology in the table of a type, and the physical type it says the logical type maps to. */
const rowOf = (page: Page, type: string, technology: string): Locator =>
  page.getByRole("table", { name: `Type mappings for ${type}` }).getByTestId("type-mapping-row").filter({ hasText: technology });
const mapsTo = (page: Page, type: string, technology: string): Locator => rowOf(page, type, technology).getByTestId("mapped-type");

/** The counts under the page title ("4 safe", "1 risky", "0 unmapped"). */
const summary = (page: Page): Locator => page.getByTestId("mapping-summary");

test("it opens on int32 with one row per tabulated technology, in the catalog's order", { tag: ["@regression"] }, async ({ authedPage: page }) => {
  await openReference(page);

  await expect(page.getByRole("heading", { name: "int32", level: 2, exact: true })).toBeVisible();
  await expect(typeButton(page, "int32")).toHaveAttribute("aria-pressed", "true");

  const table = page.getByRole("table", { name: "Type mappings for int32" });
  const technologies = await table
    .getByTestId("type-mapping-row")
    .evaluateAll((rows) => rows.map((row) => row.querySelector("td div")?.textContent?.trim() ?? ""));
  expect(technologies).toEqual([...TABULATED]);

  // Every row is a catalog target the Schemas tab offers: the page cannot invent a technology the app cannot generate.
  const offered = ENABLED_TARGETS.map((target) => target.displayName);
  for (const technology of TABULATED) expect(offered, `${technology} is not a target of the Schemas tab`).toContain(technology);
});

test("string maps to STRING in BigQuery, text in PostgreSQL, STRING(MAX) in Spanner and string in Avro", { tag: ["@regression"] }, async ({ authedPage: page }) => {
  await openReference(page);
  await chooseType(page, "string");

  await expect(page.getByRole("heading", { name: "string", level: 2, exact: true })).toBeVisible();
  await expect(mapsTo(page, "string", "BigQuery DDL")).toHaveText("STRING");
  await expect(mapsTo(page, "string", "PostgreSQL DDL")).toHaveText("text");
  await expect(mapsTo(page, "string", "Spanner DDL")).toHaveText("STRING(MAX)");
  await expect(mapsTo(page, "string", "Avro Schema")).toHaveText("string");
});

test("int32 maps to INT64 in BigQuery and Spanner and to integer in PostgreSQL; choosing another type changes the rows", { tag: ["@regression"] }, async ({
  authedPage: page,
}) => {
  await openReference(page);

  await expect(mapsTo(page, "int32", "BigQuery DDL")).toHaveText("INT64");
  await expect(mapsTo(page, "int32", "Spanner DDL")).toHaveText("INT64");
  await expect(mapsTo(page, "int32", "PostgreSQL DDL")).toHaveText("integer");

  await chooseType(page, "int64");
  await expect(mapsTo(page, "int64", "PostgreSQL DDL")).toHaveText("bigint");
  // The old table is gone: one table is shown, for the chosen type.
  await expect(page.getByRole("table", { name: "Type mappings for int32" })).toHaveCount(0);
});

test("a lossy mapping says what is lost, and the header counts it as risky", { tag: ["@regression"] }, async ({ authedPage: page }) => {
  await openReference(page);

  // string is exact in every tabulated technology: nothing risky or unmapped.
  await chooseType(page, "string");
  await expect(summary(page)).toContainText(`${TABULATED.length} safe`);
  await expect(summary(page)).toContainText("0 risky");
  await expect(summary(page)).toContainText("0 unmapped");
  await expect(rowOf(page, "string", "BigQuery DDL").getByTestId("mapping-health")).toHaveAttribute("data-severity", "safe");

  await chooseType(page, "uint64");
  const bigquery = rowOf(page, "uint64", "BigQuery DDL");
  await expect(bigquery.getByTestId("mapping-health")).not.toHaveAttribute("data-severity", "safe");
  await expect(bigquery).toContainText("uint64 values above 2^63-1 cannot be represented in signed INT64");
  await expect(summary(page)).not.toContainText("0 risky");
});

test("searching narrows the list of logical types and says when nothing matches", { tag: ["@regression"] }, async ({ authedPage: page }) => {
  await openReference(page);
  const search = page.getByRole("searchbox", { name: "Search logical types" });

  await search.fill("plaindate");
  await expect(typeButton(page, "plainDate")).toBeVisible();
  await expect(typeButton(page, "int32")).toHaveCount(0);
  await expect(typeButton(page, "string")).toHaveCount(0);

  // The description is searched too: "Validated URL" is the description of `url`, not part of its id.
  await search.fill("validated url");
  await expect(typeButton(page, "url")).toBeVisible();
  await expect(typeButton(page, "plainDate")).toHaveCount(0);

  await search.fill("no-such-logical-type-xyz");
  await expect(page.getByText("No logical types match that search.")).toBeVisible();

  await search.fill("");
  await expect(typeButton(page, "int32")).toBeVisible();
  await expect(page.getByText("No logical types match that search.")).toHaveCount(0);
});
