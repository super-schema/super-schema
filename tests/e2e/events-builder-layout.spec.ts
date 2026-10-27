/**
 * The event builder's layout in a real browser: the working area the Messages form gets, and that a narrow pane never runs past the
 * edge of the page. jsdom has no layout, so this is where the container-query layout (outline icons, tab strip, pane rail) is checked.
 *
 *   - 1440px wide with the code panel open: the message form is at least 500px wide (it was about 270px with the old three columns);
 *   - 1280px wide with the code panel at its widest (800px, the narrowest pane the shell allows): the page has no horizontal scroll and
 *     the Save / Discard buttons and the problem count stay inside the builder's own width (not run out under the code panel), and the form
 *     stays inside the content column.
 *
 * The code panel's width is the shell's own `panel-width-right-panel` entry in localStorage (useResizablePanel).
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./helpers/fixtures";
import { createNavFixtures, deleteNavFixtures, disconnectDb, type NavFixtures } from "./helpers/db";
import { centerPanel, createEventFromMenu, productUrlOf } from "./helpers/event-builder";

let fixtures: NavFixtures | undefined;

test.beforeAll(async () => {
  fixtures = await createNavFixtures();
});

test.afterAll(async () => {
  try {
    await deleteNavFixtures(fixtures);
  } finally {
    await disconnectDb();
  }
});

/** An event with `count` blank messages, on the Messages section. */
async function eventWithMessages(page: Page, count: number): Promise<void> {
  if (fixtures === undefined) throw new Error("navigation fixture was not created");
  await createEventFromMenu(page, productUrlOf(fixtures), `layout-${Date.now().toString(36)}`);
  const main = centerPanel(page);
  await main.getByTestId("outline-messages").click();
  await main.getByTestId("message-empty-add").click();
  for (let i = 1; i < count; i += 1) await main.getByTestId("message-add").click();
  await expect(main.getByTestId("message-form")).toBeVisible();
}

/**
 * Opens the code panel at `width` px: the shell keeps its width in localStorage and reads it when the page loads, so this is set before
 * the first navigation (a reload would throw away the unsaved messages the test adds).
 */
async function codePanelAt(page: Page, width: number): Promise<void> {
  await page.addInitScript((w) => localStorage.setItem("panel-width-right-panel", JSON.stringify({ width: w, collapsed: false })), width);
}

const pageOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe("event builder layout", () => {
  test("1440px with the code panel open: the message form has room to work in", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await codePanelAt(page, 400);
    await eventWithMessages(page, 10);
    const main = centerPanel(page);
    const form = await main.getByTestId("message-form").boundingBox();
    expect(form?.width ?? 0, "width of the message form").toBeGreaterThanOrEqual(500);
    expect(await pageOverflow(page), "horizontal page scroll").toBeLessThanOrEqual(0);
  });

  test("1280px with the code panel at 800px: no horizontal scroll, Save and Discard stay inside the builder", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await codePanelAt(page, 800);
    await eventWithMessages(page, 10);
    const main = centerPanel(page);
    // The setup took: the builder is in a really narrow pane (the sidebar, the 800px panel and the page padding leave it under 400px).
    const builder = await main.getByTestId("event-builder").boundingBox();
    expect(builder?.width ?? 0, "width of the builder").toBeLessThan(400);
    expect(await pageOverflow(page), "horizontal page scroll").toBeLessThanOrEqual(0);
    // Save, Discard and the problem count sit inside the builder's own width, without any sideways scrolling: a bar that runs past the
    // pane ends up under the code panel and the user has to scroll the column to find Save.
    const frame = (await main.getByTestId("event-builder").boundingBox())!;
    for (const id of ["builder-save", "builder-discard", "builder-problems"]) {
      const box = await main.getByTestId(id).boundingBox();
      expect(box, id).not.toBeNull();
      expect(box!.x, `${id} starts inside the builder`).toBeGreaterThanOrEqual(frame.x - 1);
      expect(box!.x + box!.width, `${id} ends inside the builder`).toBeLessThanOrEqual(frame.x + frame.width + 1);
    }
    const content = await main.getByTestId("builder-content").boundingBox();
    const form = await main.getByTestId("message-form").boundingBox();
    expect(form!.x + form!.width, "the form stays inside the content column").toBeLessThanOrEqual(content!.x + content!.width + 1);
  });
});
