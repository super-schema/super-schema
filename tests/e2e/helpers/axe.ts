/**
 * An axe-core scan of the page a test is on (a11y.spec.ts). The baseline it is compared to is helpers/a11y-baseline.ts; the rules for
 * both are in docs/testing/a11y.md.
 *
 * This is what `@axe-core/playwright`'s `AxeBuilder` does, in a few lines, on `axe-core` itself: the package could not be installed (the
 * registry this repository is configured for answered 403 to every package, `@playwright/test` included, with a token that had
 * expired), and axe-core 4.11.2 was already in node_modules (a dependency of eslint-config-next), so it is declared as a devDependency
 * of its own and used directly. Switching to `@axe-core/playwright` later changes `scanPage` only.
 *
 * The scan sees the page's own document: an iframe (the AsyncAPI preview) is not entered. `resultTypes: ["violations"]`: what axe cannot
 * decide ("needs review", `incomplete`) is not a finding.
 */
import type { Page } from "@playwright/test";
import type { AxeFinding, ElementInfo } from "./a11y-baseline";

// eslint-disable-next-line @typescript-eslint/no-require-imports -- axe-core is a CommonJS script; Playwright loads this file as CommonJS
const axeCore = require("axe-core") as { source: string };

/** axe-core's version (in the baseline file, so a newer ruleset that finds more is visible as such). */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
export const AXE_VERSION: string = (require("axe-core/package.json") as { version: string }).version;

/** WCAG 2.1 levels A and AA, the standard the product is held to. */
export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] as const;

interface RawNode { target: Array<string | string[]>; html: string; element?: ElementInfo }
interface RawViolation { id: string; impact?: string | null; help: string; helpUrl: string; nodes: RawNode[] }

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

/** Run axe on the page as it is now and return every violation, one finding per offending element. */
export async function scanPage(page: Page, options: { include?: string; exclude?: string[] } = {}): Promise<AxeFinding[]> {
  await waitForQuietPage(page);
  await page.evaluate(axeCore.source);
  const violations = await page.evaluate(
    async ({ tags, include, exclude }) => {
      const axe = (window as unknown as { axe: { run(context: unknown, options: unknown): Promise<{ violations: unknown[] }> } }).axe;
      const context = include || exclude ? { ...(include ? { include: [[include]] } : {}), ...(exclude ? { exclude: exclude.map((selector) => [selector]) } : {}) } : document;
      const result = await axe.run(context, { runOnly: { type: "tag", values: tags }, resultTypes: ["violations"], iframes: false, elementRef: true });
      // The element itself is read here, in the page: its own markup is what the baseline identifies it by (helpers/a11y-baseline.ts).
      return (result.violations as Array<{ nodes: Array<{ element?: Element; html: string; target: unknown }> }>).map((violation) => ({
        ...violation,
        nodes: violation.nodes.map((node) => ({
          target: node.target,
          html: node.html,
          element: node.element
            ? {
                tag: node.element.tagName.toLowerCase(),
                id: node.element.id,
                classes: Array.from(node.element.classList),
                attributes: Object.fromEntries(Array.from(node.element.attributes).map((attribute) => [attribute.name, attribute.value])),
              }
            : undefined,
        })),
      })) as unknown as RawViolation[];
    },
    { tags: [...WCAG_TAGS], include: options.include, exclude: options.exclude },
  );
  return violations.flatMap((violation) =>
    violation.nodes.map((node) => ({
      rule: violation.id,
      impact: violation.impact ?? "unknown",
      help: violation.help,
      helpUrl: violation.helpUrl,
      target: node.target.map((part) => (Array.isArray(part) ? part.join(" >> ") : part)).join(" >> "),
      html: node.html,
      element: node.element,
    })),
  );
}
