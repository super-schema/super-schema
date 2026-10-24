/**
 * Waiting for React to have hydrated an element, for the first click or keystroke of a page that was just loaded.
 *
 * A production page is visible (and Playwright's actionability checks pass) before React has attached its handlers: a click on a
 * client component's button in that gap does nothing, and a client form submitted in it is submitted natively by the browser (the
 * login form: a GET with the password in the address). React marks every DOM node it hydrates with a `__reactProps$<random>` key, so
 * "hydrated" is a state of the page that can be waited for, instead of a guess about time.
 */
import { expect, type Locator } from "@playwright/test";

export async function waitForHydration(element: Locator): Promise<void> {
  await expect
    .poll(() => element.evaluate((el) => Object.keys(el).some((key) => key.startsWith("__reactProps$"))), {
      message: "React never hydrated the element",
      // The page's scripts are fetched and run first: a load, so the 30 s of `actionTimeout`, not an assertion's 5 s.
      timeout: 30_000,
    })
    .toBe(true);
}
