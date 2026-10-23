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
  const isTextarea = await editable.evaluate((el) => el.tagName === "TEXTAREA");
  if (!isTextarea && text.includes("\n")) {
    // `fill` on CodeMirror's contenteditable flattens newlines into one line; a real user PASTES, so do that (YAML, pretty-printed JSON).
    await editable.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    await editable.evaluate((el, value) => {
      const data = new DataTransfer();
      data.setData("text/plain", value);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, text);
  } else {
    await editable.fill(text);
  }
  // A paste that changes the kind of editor swaps it (and focuses the new one); the text must have arrived either way.
  await expectWorkbenchText(page, PASTE_ID, text);
}

/** Assert the Detail Panel shows `text`. */
export async function expectDetailPanelText(page: Page, text: string): Promise<void> {
  await expectWorkbenchText(page, PANEL_ID, text);
}

async function expectWorkbenchText(page: Page, id: string, text: string): Promise<void> {
  await settled(page, id);
  // The kind of editor can change under us (a paste of another format swaps CodeMirror for the textarea editor), so what is read is
  // decided on every poll: the whole value of a textarea, or the first lines of CodeMirror (it renders only the visible lines of a
  // long document; its text content has no newline between the `.cm-line` blocks, so the lines are read one by one).
  const sampleLines = text.split("\n").slice(0, 5);
  const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
  const wanted = sampleLines.map(collapse).join("\n");
  await expect
    .poll(
      async () => {
        const editable = page.locator(`#${id}`);
        const isTextarea = await editable.evaluate((el) => el.tagName === "TEXTAREA").catch(() => false);
        if (isTextarea) return (await editable.inputValue()) === text ? wanted : (await editable.inputValue()).split("\n").slice(0, 5).map(collapse).join("\n");
        return (await editable.locator(".cm-line").allInnerTexts().catch(() => [])).slice(0, sampleLines.length).map(collapse).join("\n");
      },
      { timeout: 8_000 },
    )
    .toBe(wanted);
}
