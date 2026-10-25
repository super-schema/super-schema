/**
 * Waiting for a page to be settled, for the two specs that look at the whole page rather than at one element (the accessibility scan,
 * a11y.spec.ts, and the screenshots, visual.spec.ts): a scan or a screenshot of a page that is still being drawn (a skeleton, a list that is
 * still being fetched, a dialog fading in, text laid out in the fallback font) would see a different page each time.
 */
import type { Page } from "@playwright/test";

/**
 * Count the requests the page makes with `fetch` that have not been answered yet (Next's server actions and the app's own calls are all
 * `fetch`), as `window.__ssInflight`, from the first line of every document the page loads. Call it before the first `goto` of the test;
 * `waitForQuietPage` then knows that a list that is still being fetched is not a page that has stopped changing.
 */
export async function trackInflightRequests(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __ssInflight?: number; fetch: typeof fetch };
    if (w.__ssInflight !== undefined) return;
    w.__ssInflight = 0;
    const original = w.fetch.bind(window);
    w.fetch = (...args: Parameters<typeof fetch>) => {
      w.__ssInflight = (w.__ssInflight ?? 0) + 1;
      return original(...args).finally(() => {
        w.__ssInflight = Math.max(0, (w.__ssInflight ?? 1) - 1);
      });
    };
  });
}

/**
 * Wait until the page has stopped changing: 30 animation frames (half a second) in a row without a DOM mutation and without a request in
 * flight (`trackInflightRequests`), and at most 600 frames (a spinner that never stops must not hang the scan), then until the fonts are
 * loaded and every animation that has an end has ended. A scan of a page that is still being drawn (a skeleton, a dialog fading in, text laid out in the fallback font) would find
 * a different page each time, which is what makes a baseline flaky. It is a state of the page, not a sleep: it does not wait for a time.
 */
export async function waitForQuietPage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      let quiet = 0;
      let frames = 0;
      const inflight = () => (window as unknown as { __ssInflight?: number }).__ssInflight ?? 0;
      const observer = new MutationObserver(() => {
        quiet = 0;
      });
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      const tick = () => {
        if (inflight() > 0) quiet = 0;
        else quiet += 1;
        frames += 1;
        if (quiet >= 30 || frames >= 600) {
          observer.disconnect();
          resolve();
        } else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}
