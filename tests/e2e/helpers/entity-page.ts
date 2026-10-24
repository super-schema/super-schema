/**
 * Plain helpers for the specs that work on ONE entity page (`/schemas/<domain>/<product>/<entity>`): open it, add a field, publish
 * it, read what the header and the Versions tab say. They drive the real UI; a helper never decides what a spec asserts (it waits for
 * the page to show the result of what it did, and returns what the page said).
 *
 * Everything on the page is queried inside the center panel (`centerPanel`, helpers/event-builder.ts): a hard load streams the page
 * behind its loading.tsx and Next leaves the streamed segment's hidden copy in <body>, so a bare `page.getByTestId(...)` can match
 * two elements. Dialogs and toasts render in portals outside the center panel and are queried on `page`.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { centerPanel } from "./event-builder";

/** The row of a field in the editor list (the name cell carries `title=<name>`). */
export const fieldRow = (page: Page, name: string): Locator => centerPanel(page).locator(`span[title="${name}"]`);

/**
 * Run `trigger` (a click, a keystroke) and resolve when the server action IT starts has been answered: for a save the page does not
 * announce (the entity's description), or one whose indicator is gone with the refresh that follows it. Navigating away before that
 * would read the entity as it was.
 *
 * The REQUEST that is waited for is the first server action request made after the trigger began whose body contains `body`: other
 * server actions run all the time (the explorer's data, refreshed after every save), and one of them must not be taken for the save. Name
 * what only the save's body holds (the id of the field it writes, the text typed). A request that was already in flight when the
 * trigger ran was sent earlier, so its answer is never taken for this one's.
 */
export async function afterServerAction(page: Page, trigger: () => Promise<void>, match: { body?: string } = {}): Promise<void> {
  const started = page.waitForRequest(
    (request) => request.method() === "POST" && "next-action" in request.headers() && (match.body === undefined || (request.postData() ?? "").includes(match.body)),
  );
  await trigger();
  const request = await started;
  const response = await request.response();
  if (!response) throw new Error(`the server action ${request.headers()["next-action"]} got no response: ${request.failure()?.errorText ?? "unknown"}`);
}

/** A success toast (sonner) whose text matches. */
export const successToast = (page: Page, text: RegExp | string): Locator =>
  page.locator('[data-sonner-toast][data-type="success"]').filter({ hasText: text });

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Open the entity page and wait for the field editor to be there. */
export async function openEntityPage(page: Page, url: string, name: string): Promise<void> {
  await page.goto(url);
  await expect(centerPanel(page).getByRole("heading", { level: 1, name })).toBeVisible({ timeout: 30_000 });
  await expect(centerPanel(page).getByRole("heading", { name: /^Fields \(\d+\)$/ })).toBeVisible({ timeout: 30_000 });
}

/** The header's Draft + Publish line: "Never published", "Published · v1.0", "Draft · unpublished changes · latest v1.0". */
export const versionState = (page: Page): Locator => centerPanel(page).getByTestId("entity-version-state");

/**
 * Type a name in the new-field form. A name the autocomplete knows ("amount") opens its suggestion list right under the input, over the
 * buttons below it. Escape would close the whole form (it is the form's own shortcut), so the input is left instead: the list closes
 * on blur (after 200 ms: the assertion below waits for that, it is not a sleep).
 */
async function typeNewFieldName(page: Page, name: string): Promise<void> {
  const form = centerPanel(page).getByTestId("new-field-form");
  await form.getByPlaceholder("field_name").fill(name);
  await form.getByRole("heading", { name: "New Field" }).click();
  await expect(form.getByTestId("autocomplete-suggestions")).toHaveCount(0);
  await expect(form.getByPlaceholder("field_name")).toHaveValue(name);
}

/** "Add Field" then "Quick Create": a plain string field with the name. Resolves when the row is in the list. */
export async function addFieldQuick(page: Page, name: string): Promise<void> {
  const main = centerPanel(page);
  await main.getByTestId("field-add-button").click();
  await typeNewFieldName(page, name);
  await main.getByTestId("new-field-form").getByRole("button", { name: "Quick Create" }).click();
  await expect(fieldRow(page, name)).toBeVisible();
}

/**
 * "Add Field" with the type picker's reference prompt: a field named `name` that references the entity `target` (picked from the
 * list, so it is written with the target's id), then Quick Create. Resolves when the row is in the list. `target.name` must be unique
 * among the tenant's entities (the prompt lists all of them).
 */
export async function addReferenceField(page: Page, name: string, target: { name: string }): Promise<void> {
  const main = centerPanel(page);
  await main.getByTestId("field-add-button").click();
  const form = main.getByTestId("new-field-form");
  await typeNewFieldName(page, name);
  await form.getByTestId("type-picker-trigger").click();
  await page.getByPlaceholder("Search types...").fill("reference");
  await page.getByRole("option", { name: /^reference\b/i }).first().click();
  await page.getByPlaceholder("Search or type entity name...").fill(target.name);
  await page.getByTestId("reference-prompt-candidate").filter({ hasText: target.name }).click();
  await page.getByRole("button", { name: `Confirm ref(${target.name})` }).click();
  await expect(form.getByTestId("new-field-reference-target")).toContainText(target.name);
  await form.getByRole("button", { name: "Quick Create" }).click();
  await expect(fieldRow(page, name)).toBeVisible();
}

/** Delete a field from the list with its trash button (shown on hover). Resolves when the row is gone. */
export async function deleteField(page: Page, name: string): Promise<void> {
  const row = centerPanel(page).locator(`[data-testid="field-card"][data-field=${JSON.stringify(name)}]`);
  await row.hover();
  await row.getByTitle("Delete field").click();
  await expect(fieldRow(page, name)).toHaveCount(0);
}

/** The Publish dialog, once its preview has loaded (the form with its Publish button, which is there with or without blockers). */
export async function openPublishDialog(page: Page): Promise<Locator> {
  await centerPanel(page).getByTestId("publish-entity-button").click();
  const dialog = page.getByTestId("publish-dialog");
  await expect(dialog.getByTestId("confirm-publish")).toBeVisible({ timeout: 30_000 });
  return dialog;
}

/**
 * Publish through the dialog: choose a bump (not on a first publish), type a summary, confirm. Resolves to the label the entity was
 * published as ("1.0"), after the header says so.
 */
export async function publishViaDialog(page: Page, options: { bump?: "minor" | "major"; summary?: string } = {}): Promise<string> {
  const dialog = await openPublishDialog(page);
  if (options.bump) await dialog.getByTestId(`bump-${options.bump}`).click();
  if (options.summary) await dialog.getByTestId("publish-change-summary").fill(options.summary);
  const confirm = dialog.getByTestId("confirm-publish");
  await expect(confirm).toBeEnabled();
  const label = /v(\d+\.\d+)/.exec(await confirm.innerText())?.[1];
  if (!label) throw new Error("the Publish button names no version");
  await confirm.click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  await expect(versionState(page)).toHaveText(new RegExp(`^Published · v${escapeRegExp(label)}$`), { timeout: 30_000 });
  return label;
}

/** Open the Versions tab and wait for the published versions to have loaded. */
export async function openVersionsTab(page: Page): Promise<Locator> {
  await centerPanel(page).getByTestId("tab-versions").click();
  const tab = centerPanel(page).getByTestId("versions-tab");
  await expect(tab).toBeVisible();
  await expect(tab.getByTestId("versions-loading")).toHaveCount(0, { timeout: 30_000 });
  return tab;
}

/** The labels of the published versions on the Versions tab, top to bottom ("2.0", "1.0"). */
export async function publishedLabels(tab: Locator): Promise<string[]> {
  return tab.getByTestId("entity-version-item").evaluateAll((items) => items.map((item) => item.getAttribute("data-label") ?? ""));
}
