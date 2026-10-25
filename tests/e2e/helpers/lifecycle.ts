/**
 * Lifecycle helpers for the schema import -> create -> generate-every-target -> edit -> sync browser specs.
 *
 * Everything goes through the real UI. A helper never asserts a variation's content (the specs do): it drives the page and returns
 * what the page shows (the generated artifact text, the TypeSpec source, the toast), so one failing check names the step.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { unique } from "./unique";
import { fillWorkbenchPaste, expectDetailPanelText } from "./workbench";
import { SCHEMA_TARGETS_FOR_TESTS } from "./targets";
import { previewSignature, readPreviewFrom, settlePreview, type PreviewSource } from "./preview-text";
import { artifactProblems } from "./artifact-text";
import { centerPanel } from "./event-builder";

export { unique };

/** Every target of the catalog the Schemas tab offers, in catalog order (key + the label on its button). */
export const ENABLED_TARGETS = SCHEMA_TARGETS_FOR_TESTS;

export type TargetKey = (typeof ENABLED_TARGETS)[number]["key"];

export async function createDomain(page: Page, name: string): Promise<void> {
  await page.goto("/schemas");
  await page.getByRole("button", { name: /create domain/i }).first().click();
  await page.getByPlaceholder(/Customer, Payment/i).fill(name);
  await page.getByRole("button", { name: /^create$/i }).click();
  await expect(page.getByText(name).first()).toBeVisible();
}

export async function createProduct(page: Page, domain: string, name: string): Promise<string> {
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

/** A fresh domain + product made through the UI; resolves to the product URL (the `/new` entity wizard hangs off it). The database-backed one is `createDbWorkspace` (helpers/fixtures.ts). */
export async function createUiWorkspace(page: Page, prefix: string): Promise<{ domain: string; productUrl: string }> {
  const domain = unique(`${prefix}-d-`);
  await createDomain(page, domain);
  const productUrl = await createProduct(page, domain, unique(`${prefix}-p-`));
  return { domain, productUrl };
}

/** Open the workbench Paste tab of the product's new-entity page. */
export async function openWorkbench(page: Page, productUrl: string): Promise<void> {
  await page.goto(`${productUrl.replace(/\/+$/, "")}/new`);
  await expect(page.getByRole("heading", { name: /create new entity/i })).toBeVisible();
  await page.getByRole("button", { name: /import or build schema/i }).first().click();
}

/** Paste `text`, Load, then open the review screen. */
export async function pasteAndReview(page: Page, productUrl: string, text: string): Promise<void> {
  await openWorkbench(page, productUrl);
  await page.getByRole("button", { name: "Paste", exact: true }).click();
  await fillWorkbenchPaste(page, text);
  await page.getByTestId("workbench-load-button").click();
  await expectDetailPanelText(page, text);
  await page.getByTestId("workbench-review-button").click();
}

/**
 * Drop mode of the workbench, as a user's drop: the file is DROPPED on the drop zone (a `dragover` and a `drop` event whose
 * `dataTransfer` carries a real `File`, which is what the zone's `onDrop` reads), then the review screen is opened. Resolves to what the workbench said of the file (its name and format) before the review.
 */
export async function dropFileAndReview(page: Page, productUrl: string, filePath: string): Promise<string> {
  await openWorkbench(page, productUrl);
  const zone = page.getByTestId("workbench-dropzone");
  await expect(zone).toBeVisible();
  const content = readFileSync(filePath, "utf8");
  await zone.evaluate(
    (element, file) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([file.content], file.name, { type: "application/octet-stream" }));
      for (const type of ["dragenter", "dragover", "drop"]) {
        element.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }));
      }
    },
    { name: path.basename(filePath), content },
  );
  const summary = page.getByTestId("workbench-import-summary");
  await expect(summary).toBeVisible();
  const text = await summary.innerText();
  await page.getByTestId("workbench-review-button").click();
  return text;
}

/** Drop mode of the workbench, by browsing: the file is chosen in the zone's own file input (what a click on the zone opens), then the review screen is opened. */
export async function chooseFileAndReview(page: Page, productUrl: string, filePath: string): Promise<string> {
  await openWorkbench(page, productUrl);
  await expect(page.getByTestId("workbench-dropzone")).toBeVisible();
  await page.getByTestId("workbench-file-input").setInputFiles(filePath);
  const summary = page.getByTestId("workbench-import-summary");
  await expect(summary).toBeVisible();
  const text = await summary.innerText();
  await page.getByTestId("workbench-review-button").click();
  return text;
}

/**
 * Single-entity review: name the entity (the importer's placeholder blocks Create), Create, and land on the entity page.
 * Resolves to the entity page URL.
 */
export async function createSingleEntity(page: Page, entityName: string): Promise<string> {
  await expect(page.getByTestId("import-entity-details")).toBeVisible({ timeout: 30_000 });
  const nameInput = page.getByPlaceholder("EntityName");
  await nameInput.fill(entityName);
  const create = page.getByRole("button", { name: /create entity/i });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page).toHaveURL(/\/schemas\/[^/]+\/[^/]+\/[^/]+$/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: new RegExp(entityName) }).first()).toBeVisible({ timeout: 30_000 });
  return page.url();
}

/**
 * Finish the review whichever screen it is: the single-entity one (name prompt + Create entity) or the multi-model one (every model
 * registered as an entity: `Import N Asset(s)`, then the product page lists them). Resolves to the entity page URL of `entityName`.
 */
export async function createEntityFromReview(page: Page, productUrl: string, entityName: string): Promise<string> {
  const multi = page.getByRole("button", { name: /import \d+ asset/i });
  const single = page.getByTestId("import-entity-details");
  await expect(multi.or(single)).toBeVisible({ timeout: 45_000 });
  if (await single.isVisible()) return createSingleEntity(page, entityName);
  await multi.click();
  await expect(page).toHaveURL(/\/schemas\/[^/]+\/[^/]+$/, { timeout: 45_000 });
  return openEntityFromProduct(page, productUrl, entityName);
}

/** From the product page, open the entity card named `entityName`. Resolves to the entity page URL. */
export async function openEntityFromProduct(page: Page, productUrl: string, entityName: string): Promise<string> {
  await page.goto(productUrl);
  await page.getByText(entityName, { exact: true }).first().click();
  await expect(page).toHaveURL(/\/schemas\/[^/]+\/[^/]+\/[^/]+$/, { timeout: 30_000 });
  await expect(page).not.toHaveURL(/\/new$/);
  await expect(page.getByRole("heading", { name: new RegExp(entityName) }).first()).toBeVisible({ timeout: 30_000 });
  return page.url();
}

/** A failed server action surfaces as an error toast (sonner). */
export const errorToast = (page: Page): Locator => page.locator('[data-sonner-toast][data-type="error"]');

export async function openEntityTab(page: Page, label: string): Promise<void> {
  await page.locator("main").getByText(label, { exact: true }).first().click();
}

export interface Generated {
  /** The preview text (line numbers stripped). */
  code: string;
  /** Warning toast text when the target generated with warnings. */
  warning?: string;
  /** Set when the target did not generate: the error toast text. */
  error?: string;
  /** True when the primary-key dialog was shown and answered. */
  askedForKey: boolean;
}

const targetButton = (page: Page, displayName: string): Locator =>
  page
    .getByTestId("schemas-tab")
    .locator("button")
    .filter({ hasText: displayName })
    .filter({ hasNotText: /Regenerate|Generate$/ })
    .first();

/**
 * The generated artifact of the selected target, without the line-number gutter. A version of several files (one per entity, a JSON
 * Schema inline enum in a file of its own) shows one file at a time, so every `schema-file-item` is selected in turn and the files are
 * joined in the `===== path =====` form of the stored output (`readPreviewFrom`); a single plain preview is returned as it is.
 * NOT run in a browser yet: the walking and joining are unit tested (tests/unit/e2e-helpers/preview-text.test.ts) against a fake page.
 */
export async function readPreview(page: Page): Promise<string> {
  return readPreviewFrom(previewSourceOf(page));
}

/** The Schemas tab as a `PreviewSource`: the file list, one file selected by its path, the code on show. */
function previewSourceOf(page: Page): PreviewSource {
  const tab = page.getByTestId("schemas-tab");
  const items = tab.getByTestId("schema-file-item");
  return {
    filePaths: async () => ((await items.count()) === 0 ? [] : items.evaluateAll((els) => els.map((el) => el.getAttribute("data-path") ?? ""))),
    select: async (path) => {
      // By the path of the snapshot, never by position: a list re-rendered in another order cannot make this click another file.
      await tab.locator(`[data-testid="schema-file-item"][data-path=${JSON.stringify(path)}]`).click({ timeout: 5_000 });
      // The code preview's header carries the shown file's path: wait until it is the one that was asked for.
      await expect(tab.getByTestId("schema-code-preview").locator("span").first()).toHaveText(path, { timeout: 5_000 });
    },
    code: async () => (await tab.locator("pre code > div > span:nth-child(2)").allInnerTexts()).join("\n"),
  };
}

/**
 * Generate `displayName` on the open Schemas tab. If the primary-key dialog appears it is answered with `primaryKey` (the first
 * offered field when absent) and generation continues. Resolves with what the page shows; never throws for a failed generation
 * (the spec asserts on `error`).
 */
export async function generateTarget(
  page: Page,
  displayName: string,
  opts: { primaryKey?: string[]; timeoutMs?: number } = {},
): Promise<Generated> {
  const timeout = opts.timeoutMs ?? 120_000;
  await targetButton(page, displayName).click();
  const toasts = page.locator("[data-sonner-toast]");
  // A toast of an earlier action must not be taken for this generation's: let them go first.
  await expect(toasts).toHaveCount(0, { timeout: 15_000 }).catch(async () => {
    await page.keyboard.press("Escape");
  });
  // A drafted target is regenerated IN PLACE (the version number stays), so the change is told by the toast, then by the text.
  const previous = await readPreview(page);
  const previousSignature = await previewSignature(previewSourceOf(page));
  await page.getByTestId("schemas-tab").getByRole("button", { name: /^(Generate|Regenerate)$/ }).click();

  const dialog = page.getByTestId("primary-key-dialog");
  let askedForKey = false;
  const deadline = Date.now() + timeout;
  for (;;) {
    // The primary-key dialog or the result toast, whichever the page shows first: one web-first wait, not a polling sleep.
    await expect(dialog.or(toasts.first()).first(), `${displayName}: no result toast within ${timeout} ms`).toBeVisible({
      timeout: Math.max(deadline - Date.now(), 1),
    });
    if (!(await dialog.isVisible().catch(() => false))) break;
    askedForKey = true;
    if (opts.primaryKey) {
      for (const name of opts.primaryKey) {
        const box = dialog.locator("label", { hasText: new RegExp(`^${name}$`) }).locator("input");
        if (!(await box.isChecked())) await box.check();
      }
    } else if ((await dialog.locator("input:checked").count()) === 0) {
      await dialog.locator("input[type=checkbox]").first().check();
    }
    await dialog.getByRole("button", { name: /save key and generate/i }).click();
    await expect(dialog).toBeHidden({ timeout: 60_000 });
  }
  const toast = toasts.last();
  const type = await toast.getAttribute("data-type");
  const toastText = (await toast.innerText()).trim();
  if (type === "error") return { code: "", error: toastText, askedForKey };
  // The toast comes before the versions are reloaded: wait for the preview to show the new text (or settle on the same one), within
  // the same 8 s as ever. A round costs one cheap signature (the file list and the file on show); every file is clicked through only
  // when that changed, every fifth round, and while nothing is readable (`settlePreview`, unit tested). A read that fails because the
  // file list was replaced under it counts as "not settled yet".
  const code = await settlePreview({
    previous,
    previousSignature,
    read: () => readPreview(page),
    signature: () => previewSignature(previewSourceOf(page)),
    wait: pollEvery,
  });
  return { code, warning: type === "warning" ? toastText : undefined, askedForKey };
}

/**
 * The cadence of `settlePreview`'s bounded poll (what `expect.poll` does with its `intervals`): the gap between two cheap reads of the
 * preview while it is being replaced, not a sleep before an assertion. `settlePreview` takes it as a parameter so its unit test needs no
 * clock.
 */
const pollEvery = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A documented, accepted open defect: generating the target must fail with an error matching `match`. */
export interface KnownTargetFailure {
  match: RegExp;
  why: string;
}

/**
 * Generate EVERY target of the catalog on the open Schemas tab and check each artifact: it generated (or failed exactly as `known`
 * says, and a `known` entry that no longer fails is reported as stale), and, file by file (`artifactProblems`), no file is trivial and
 * the entity's own file names the entity. `problems` is empty when everything held.
 */
export async function generateAllTargets(
  page: Page,
  entityName: string,
  opts: { primaryKey?: string[]; known?: Partial<Record<string, KnownTargetFailure>> } = {},
): Promise<{ outputs: Map<string, Generated>; problems: string[] }> {
  const outputs = new Map<string, Generated>();
  const problems: string[] = [];
  for (const t of ENABLED_TARGETS) {
    const g = await generateTarget(page, t.displayName, { primaryKey: opts.primaryKey });
    outputs.set(t.key, g);
    const known = opts.known?.[t.key];
    if (known) {
      if (!g.error) problems.push(`${t.key}: known defect "${known.why}" no longer reproduces: remove it from the table`);
      else if (!known.match.test(g.error)) problems.push(`${t.key}: known defect expected /${known.match.source}/ but got: ${g.error.slice(0, 200)}`);
      continue;
    }
    if (g.error) problems.push(`${t.key}: ${g.error.slice(0, 300)}`);
    else for (const problem of artifactProblems(g.code, entityName)) problems.push(`${t.key}: ${problem}`);
  }
  return { outputs, problems };
}

/** Open the Schemas tab of the entity page. */
export async function openSchemasTab(page: Page): Promise<void> {
  await openEntityTab(page, "Schemas");
  await expect(page.getByTestId("schemas-tab")).toBeVisible();
}

/** Open the TypeSpec tab and read the source. */
export async function readTypeSpecSource(page: Page): Promise<string> {
  // In the center panel: right after a hard load the streamed segment's hidden copy holds a second `tab-typespec` (helpers/event-builder.ts).
  await centerPanel(page).getByTestId("tab-typespec").click();
  const area = page.getByTestId("typespec-source-textarea");
  await expect(area).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Compiling current fields/)).toHaveCount(0, { timeout: 60_000 });
  return area.inputValue();
}

/** Replace the TypeSpec source (the tab must be open) and Save: resolves with the toast / diagnostics text. */
export async function saveTypeSpecSource(page: Page, source: string): Promise<{ ok: boolean; message: string }> {
  const area = page.getByTestId("typespec-source-textarea");
  const save = page.getByRole("button", { name: /^Save$/ });
  // A toast of an earlier save must not be taken for this one's (a second save a few seconds after the first): let it go first.
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 15_000 }).catch(async () => {
    await page.keyboard.press("Escape");
  });
  // The tab can reload its source right after it was opened (a refresh of the page behind a just-finished edit) and put the saved text
  // back over what was typed: Save then stays disabled (not dirty) and the click waits for it in vain. Type and click as one unit that
  // is repeated until it goes through, instead of sleeping to see whether the text stayed.
  await expect(async () => {
    await area.fill(source);
    await save.click({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  const ok = page.locator('[data-sonner-toast][data-type="success"]').filter({ hasText: /TypeSpec compiled and applied/ }).first();
  const bad = page.locator('[data-sonner-toast][data-type="error"]').last();
  await expect(ok.or(bad)).toBeVisible({ timeout: 90_000 });
  if (await ok.isVisible()) return { ok: true, message: (await ok.innerText()).trim() };
  return { ok: false, message: (await bad.innerText()).trim() };
}

/** Switch back to the field Editor tab. */
export async function openEditor(page: Page): Promise<void> {
  await openEntityTab(page, "Editor");
  await expect(page.getByRole("heading", { name: /^Fields \(\d+\)$/ })).toBeVisible({ timeout: 30_000 });
}

/** The row of a field in the editor list (the name cell carries `title=<name>`). */
export const fieldName = (page: Page, name: string): Locator => page.locator(`span[title="${name}"]`);

/** Inline rename in the field list. */
export async function renameField(page: Page, from: string, to: string): Promise<void> {
  await fieldName(page, from).click();
  const input = page.locator("input:focus");
  await expect(input).toBeVisible();
  await input.fill(to);
  await input.press("Enter");
  await expect(fieldName(page, to)).toBeVisible();
}
