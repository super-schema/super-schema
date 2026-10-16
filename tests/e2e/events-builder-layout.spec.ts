/**
 * Event builder layout E2E: the sticky Save bar must never hide the last control of a section on a short window.
 *
 * `EventBuilder` pads the section container by the bar's own height (`--builder-bar-h`), so scrolled to the bottom the last control
 * ends above the bar. This spec measures that in a real browser at 1280x600 on the seeded showcase event's Messages section (the
 * longest form: several messages, each with a payload, key, properties and bindings). A jsdom test cannot: it only pins the rule.
 *
 * PREREQS: see helpers/auth.ts; the demo data (`npm run db:seed-events-demo`: Payments / Checkout with the showcase `order-platform`);
 * the app on :3000. The test only reads; it creates and deletes nothing.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./helpers/auth";

// First visits compile routes in dev.
test.use({ viewport: { width: 1280, height: 600 }, navigationTimeout: 60_000, actionTimeout: 30_000, screenshot: "only-on-failure", trace: "retain-on-failure" });

const SHOWCASE = { domain: "payments", product: "checkout", event: "order-platform" } as const;
/** Every control a form can end with, in document order. */
const CONTROLS = "input, select, textarea, button, [role=combobox], [role=switch], [role=checkbox]";

/** Page content is queried inside the center panel: a hard load leaves Next's hidden streamed copy in <body> (strict-mode clash). */
const centerPanel = (page: Page): Locator => page.getByTestId("center-panel");

async function openShowcaseMessages(page: Page) {
  await page.goto(`/schemas/${SHOWCASE.domain}/${SHOWCASE.product}?tab=events`);
  const link = centerPanel(page).getByRole("link", { name: SHOWCASE.event, exact: true });
  await expect(link, "the showcase event is missing: run `npm run db:seed-events-demo`").toBeVisible({ timeout: 30_000 });
  await link.click();
  await expect(page).toHaveURL(/\/events\/[^/?]+/, { timeout: 60_000 });
  await centerPanel(page).getByTestId("outline-messages").click();
  await expect(centerPanel(page).getByTestId("section-messages")).toBeVisible();
}

/** Scrolls the page's scroll container (the center panel) as far down as it goes. */
const scrollToBottom = (page: Page) => centerPanel(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });

test.describe("event builder layout at 1280x600", () => {
  test("scrolled to the bottom, the last control of Messages ends above the Save bar", async ({ authedPage: page }) => {
    await openShowcaseMessages(page);
    const form = centerPanel(page).getByTestId("builder-form");
    const bar = centerPanel(page).getByTestId("builder-bar");
    const last = form.locator(CONTROLS).filter({ visible: true }).last();

    await scrollToBottom(page);
    await expect(last).toBeVisible();

    // Layout settles after the scroll (the bar is blurred and sticky): poll the two edges instead of reading them once.
    await expect.poll(async () => {
      const [lastBox, barBox] = await Promise.all([last.boundingBox(), bar.boundingBox()]);
      if (!lastBox || !barBox) return null;
      return barBox.y - (lastBox.y + lastBox.height); // the clear space between the field's bottom edge and the bar's top edge
    }, { message: "the last control must end above the sticky Save bar" }).toBeGreaterThanOrEqual(0);

    // The bar itself stays on screen (it is sticky: it never scrolls away from the bottom of the window).
    const barBox = await bar.boundingBox();
    expect(barBox, "the Save bar has no box").not.toBeNull();
    expect(barBox!.y + barBox!.height).toBeLessThanOrEqual(600);
    expect(barBox!.y).toBeGreaterThanOrEqual(0);
  });

  test("the form is padded by the height of the bar", async ({ authedPage: page }) => {
    await openShowcaseMessages(page);
    const [padding, barHeight] = await Promise.all([
      centerPanel(page).getByTestId("builder-form").evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom)),
      centerPanel(page).getByTestId("builder-bar").evaluate((el) => el.getBoundingClientRect().height),
    ]);
    expect(padding).toBeGreaterThan(0);
    expect(Math.abs(padding - barHeight), `padding ${padding}px vs bar ${barHeight}px`).toBeLessThanOrEqual(1);
  });
});
