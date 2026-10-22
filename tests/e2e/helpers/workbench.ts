import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Schema Workbench editors. The paste box and the Detail Panel are a `JsonEditor` (CodeMirror: a contenteditable) for JSON/YAML text,
 * or a plain textarea for Protobuf / TypeSpec / SQL, and a textarea while CodeMirror loads. `#<test id>` is the editable node in every
 * one of those states (a textarea's id, or CodeMirror's content element's id); `getByTestId` would hit the host div instead.
 */

const PASTE_ID = "workbench-paste-textarea";
const PANEL_ID = "detail-panel-textarea";

/** Wait until the editor of `id` has settled: CodeMirror is in, or (a textarea editor, or no CodeMirror) the textarea stays. */
async function settled(page: Page, id: string): Promise<Locator> {
  const host = page.getByTestId(`${id}-editor`);
  // JsonEditor's wrapper says which it is; the overlay textarea has no wrapper, so then the textarea itself is the editor.
  if (await host.count()) {
    await page
      .waitForFunction(
        (testId) => document.querySelector(`[data-testid="${testId}"]`)?.getAttribute("data-editor") === "codemirror",
        `${id}-editor`,
        { timeout: 10_000 }
      )
      .catch(() => undefined); // never loaded: the textarea fallback is a fine editor
  }
  const editable = page.locator(`#${id}`);
  await expect(editable).toBeVisible();
  return editable;
}

/** Put `text` in the workbench paste box (the Paste tab must be open). Works for CodeMirror and for the textarea editors. */
export async function fillWorkbenchPaste(page: Page, text: string): Promise<void> {
  const editable = await settled(page, PASTE_ID);
  await editable.fill(text);
  // A paste that changes the kind of editor swaps it (and focuses the new one); the text must have arrived either way.
  await expectWorkbenchText(page, PASTE_ID, text);
}

/** Assert the Detail Panel shows `text`. */
export async function expectDetailPanelText(page: Page, text: string): Promise<void> {
  await expectWorkbenchText(page, PANEL_ID, text);
}

async function expectWorkbenchText(page: Page, id: string, text: string): Promise<void> {
  const editable = await settled(page, id);
  const isTextarea = await editable.evaluate((el) => el.tagName === "TEXTAREA");
  if (isTextarea) {
    await expect(editable).toHaveValue(text);
    return;
  }
  // CodeMirror renders only the visible lines of a long document: compare a bounded sample (the first lines), whitespace-insensitive.
  const sample = text.split("\n").slice(0, 5).join("\n").trim();
  await expect(editable).toContainText(sample); // a string is matched with whitespace normalised on both sides
}
