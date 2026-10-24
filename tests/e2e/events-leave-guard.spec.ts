/**
 * Leave-guard E2E (plan 2026-10-16-events-completion WP-G, spec 2026-10-15-events-self-contained-design §7 builder): while the Event
 * page's draft has unsaved changes, leaving the page in the app asks first. Everything goes through the real UI, in Chromium, so the
 * Navigation API path (`window.navigation`) is the one exercised for Back; the sidebar rows and links are caught before the router.
 *
 *   1. A clean page never asks (sidebar, then Back). With an edit: a sidebar click asks, Stay keeps the edit; the Back button asks,
 *      Stay keeps the edit; a breadcrumb link (a real next/link) asks, Stay keeps the edit; Back then Discard & leave goes back and the
 *      edit is gone.
 *   2. Save & leave saves the draft and then navigates; reopening the event shows the saved title.
 *   3. A save the server refuses (the title is required) keeps the user on the page, the dialog open and the error visible; nothing was
 *      lost and nothing leaked (no driver / Prisma text); Stay, Discard, and the sidebar then works.
 *   4. Switching tabs and sections inside the page (which rewrite ?tab= / ?section= with history.replaceState) never asks.
 *
 * The domain and product are fixtures (helpers/db.ts); `deleteNavFixtures` removes them in `afterAll` and the domain cascade takes the
 * event with them. No entity is pinned or published, so no immutable audit row is written. The builder flow for the one event the tests
 * share is the shared `createEventFromMenu` (helpers/event-builder.ts): a locator that no longer matches is fixed THERE.
 *
 * PREREQS: see helpers/auth.ts and helpers/db.ts (PostgreSQL provider, seeded admin, app on :3000).
 *
 * SELECTORS: `metadata-title` (the Metadata section's title input), `builder-status` / `builder-discard` / `outline-servers` (the
 * builder), `event-tab-design` / `event-tab-docs`, the dialog `unsaved-changes-dialog` with `leave-stay` / `leave-discard` /
 * `leave-save` / `unsaved-changes-error`, and the explorer's `enterprise` row in `left-sidebar` (always rendered, always another page).
 * If a step fails on a locator, adjust it here, not in the flow.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./helpers/fixtures";
import { createNavFixtures, deleteNavFixtures, disconnectDb, type NavFixtures } from "./helpers/db";
import { BUILDER_ID, centerPanel, createEventFromMenu, expectNoRawDbText, productUrlOf } from "./helpers/event-builder";

const SAVE_TIMEOUT = 60_000;
/** A cancelled Back never commits: do not wait for it for long. */
const BACK_TIMEOUT = 5_000;
const ENTERPRISE_PATH = "/schemas/enterprise";

let fixtures: NavFixtures | undefined;

/** What the first test creates and the later tests read. */
const flow = { s: "", eventName: "", eventId: "", title: "" };

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

const need = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`${what} fixture was not created`);
  return value;
};

const eventPath = () => `${productUrlOf(need(fixtures, "navigation"))}/events/${flow.eventId}`;
const onEventPage = (url: URL) => url.pathname === eventPath();
const onPath = (path: string) => (url: URL) => url.pathname === path;

const titleInput = (page: Page): Locator => centerPanel(page).getByTestId("metadata-title");
const statusOf = (page: Page): Locator => centerPanel(page).getByTestId(BUILDER_ID.status);
const leaveDialog = (page: Page): Locator => page.getByTestId("unsaved-changes-dialog");
/** The Enterprise row of the explorer: another page, always rendered. */
const explorerRow = (page: Page): Locator => page.getByTestId("left-sidebar").getByTestId("enterprise");

/** Opens the shared event on a fresh load and returns the stored title. */
async function openEvent(page: Page): Promise<string> {
  await page.goto(eventPath());
  await expect(titleInput(page)).toBeVisible({ timeout: 30_000 });
  await expect(statusOf(page)).toHaveText("No unsaved changes");
  return titleInput(page).inputValue();
}

/** Types a new title and waits until the builder says the draft is dirty. */
async function editTitle(page: Page, title: string): Promise<void> {
  await titleInput(page).fill(title);
  await expect(statusOf(page)).toHaveText("Unsaved changes");
}

/** Starts Back like the browser button does and does not wait for a navigation the guard is about to cancel. */
function pressBack(page: Page): Promise<unknown> {
  return page.goBack({ waitUntil: "commit", timeout: BACK_TIMEOUT }).catch(() => null);
}

test.describe("leave guard end to end", () => {
  // The tests share the event the first one creates.
  test.describe.configure({ mode: "serial" });

  test("a clean page never asks; unsaved edits make the sidebar and Back ask, Stay keeps them, Discard & leave drops them", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    test.setTimeout(300_000);
    const f = need(fixtures, "navigation");
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    flow.s = Date.now().toString(36);
    flow.eventName = `leave-guard-${flow.s}`;

    await test.step("create the event (a client-side visit, so Back has a page to return to)", async () => {
      flow.eventId = await createEventFromMenu(page, productUrlOf(f), flow.eventName);
      await expect(statusOf(page)).toHaveText("No unsaved changes");
      flow.title = await titleInput(page).inputValue();
      // Chromium: the Navigation API path
      expect(await page.evaluate(() => "navigation" in window), "this spec drives the Navigation API path: run it in Chromium").toBe(true);
    });

    await test.step("a clean page leaves by the sidebar, and comes back by Back, without a question", async () => {
      await explorerRow(page).click();
      await expect(page).toHaveURL(onPath(ENTERPRISE_PATH));
      await expect(leaveDialog(page)).toHaveCount(0);
      await page.goBack();
      await expect(page).toHaveURL(onEventPage);
      await expect(titleInput(page)).toBeVisible();
      await expect(leaveDialog(page)).toHaveCount(0);
    });

    await test.step("an edit makes a sidebar click ask instead of navigate; Stay keeps the page and the edit", async () => {
      await editTitle(page, `${flow.title} edited`);
      await explorerRow(page).click();
      const dialog = leaveDialog(page);
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("Unsaved changes");
      await expect(page).toHaveURL(onEventPage);
      await dialog.getByTestId("leave-stay").click();
      await expect(dialog).toBeHidden();
      await expect(page).toHaveURL(onEventPage);
      await expect(titleInput(page)).toHaveValue(`${flow.title} edited`);
      await expect(statusOf(page)).toHaveText("Unsaved changes");
    });

    await test.step("the Back button asks too; Stay keeps the page and the edit", async () => {
      const back = pressBack(page);
      const dialog = leaveDialog(page);
      await expect(dialog).toBeVisible();
      await expect(page).toHaveURL(onEventPage);
      await dialog.getByTestId("leave-stay").click();
      await expect(dialog).toBeHidden();
      await back;
      await expect(page).toHaveURL(onEventPage);
      await expect(titleInput(page)).toHaveValue(`${flow.title} edited`);
    });

    await test.step("a real <Link> (the breadcrumb) asks too, before the router: Stay keeps the page and the edit", async () => {
      const dialog = leaveDialog(page);
      await centerPanel(page).getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Events", exact: true }).click();
      await expect(dialog).toBeVisible();
      await expect(page).toHaveURL(onEventPage);
      await dialog.getByTestId("leave-stay").click();
      await expect(dialog).toBeHidden();
      await expect(page).toHaveURL(onEventPage);
      await expect(titleInput(page)).toHaveValue(`${flow.title} edited`);
      await expect(statusOf(page)).toHaveText("Unsaved changes");
    });

    await test.step("Back, then Discard & leave: goes back to the product page, and the edit is gone", async () => {
      const back = pressBack(page);
      const dialog = leaveDialog(page);
      await expect(dialog).toBeVisible();
      await dialog.getByTestId("leave-discard").click();
      await expect(page).toHaveURL(onPath(productUrlOf(f)));
      await back;
      expect(await openEvent(page)).toBe(flow.title); // nothing was saved
    });

    expect(pageErrors, `uncaught page errors:\n${pageErrors.join("\n")}`).toEqual([]);
  });

  test("Save & leave saves the draft, then navigates", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    test.setTimeout(240_000);
    await openEvent(page);
    const saved = `${flow.title} saved ${flow.s}`;
    await editTitle(page, saved);

    await explorerRow(page).click();
    const dialog = leaveDialog(page);
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("leave-save").click();

    // the first save compiles the action module and validates the document
    await expect(page).toHaveURL(onPath(ENTERPRISE_PATH), { timeout: SAVE_TIMEOUT });
    await expect(leaveDialog(page)).toHaveCount(0);

    await page.goto(eventPath());
    await expect(titleInput(page)).toHaveValue(saved);
    await expect(statusOf(page)).toHaveText("No unsaved changes");
    flow.title = saved;
  });

  test("a save the server refuses keeps the user on the page, with the error visible and every edit kept", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    test.setTimeout(240_000);
    await openEvent(page);
    await titleInput(page).fill(""); // the title is required: the draft can be saved, the server refuses it
    await expect(statusOf(page)).toHaveText("Unsaved changes");

    await explorerRow(page).click();
    const dialog = leaveDialog(page);
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("leave-save").click();

    const error = page.getByTestId("unsaved-changes-error");
    await expect(error).toBeVisible({ timeout: SAVE_TIMEOUT });
    await expect(error).not.toBeEmpty();
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(onEventPage);
    await expect(titleInput(page)).toHaveValue("");
    await expectNoRawDbText(page);

    await test.step("Stay closes the question; the page is still guarded; Discard makes it leavable", async () => {
      await dialog.getByTestId("leave-stay").click();
      await expect(dialog).toBeHidden();
      await explorerRow(page).click();
      await expect(dialog).toBeVisible();
      await dialog.getByTestId("leave-stay").click();
      await expect(dialog).toBeHidden();

      await centerPanel(page).getByTestId("builder-discard").click();
      await expect(statusOf(page)).toHaveText("No unsaved changes");
      await expect(titleInput(page)).toHaveValue(flow.title);
      await explorerRow(page).click();
      await expect(page).toHaveURL(onPath(ENTERPRISE_PATH));
      await expect(leaveDialog(page)).toHaveCount(0);
    });
  });

  test("switching tabs and sections inside the page never asks, and keeps the edit", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    test.setTimeout(240_000);
    await openEvent(page);
    const main = centerPanel(page);
    const edited = `${flow.title} tabs`;
    await editTitle(page, edited);

    await main.getByTestId("event-tab-docs").click();
    await expect(page).toHaveURL((url) => onEventPage(url) && url.searchParams.get("tab") === "docs");
    await expect(leaveDialog(page)).toHaveCount(0);

    await main.getByTestId("event-tab-design").click();
    await main.getByTestId(BUILDER_ID.outline("servers")).click();
    await expect(page).toHaveURL((url) => onEventPage(url) && url.searchParams.get("section") === "servers");
    await expect(leaveDialog(page)).toHaveCount(0);

    await main.getByTestId(BUILDER_ID.outline("metadata")).click();
    await expect(titleInput(page)).toHaveValue(edited);
    await expect(statusOf(page)).toHaveText("Unsaved changes");
    await expect(leaveDialog(page)).toHaveCount(0);

    // and the guard is still there for a real departure
    await explorerRow(page).click();
    await expect(leaveDialog(page)).toBeVisible();
    await leaveDialog(page).getByTestId("leave-discard").click();
    await expect(page).toHaveURL(onPath(ENTERPRISE_PATH));
  });
});
