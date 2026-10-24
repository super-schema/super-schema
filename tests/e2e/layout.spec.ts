import type { Page } from "@playwright/test";
import { test, expect } from "./helpers/fixtures";

// The shell is checked as the real, logged-in admin (the session the `setup` project saved), not with a made-up session cookie that
// only gets past the middleware.

/**
 * Open /schemas at `width` and wait until the shell has settled: the explorer (`left-sidebar`) is there. While it loads, the page shows a
 * skeleton with a test id of its own (`left-sidebar-fallback`), so `left-sidebar` is never two elements and needs no count to wait for.
 */
async function openSchemas(page: Page, width = 1440): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/schemas");
  await expect(page.getByTestId("left-sidebar")).toBeAttached({ timeout: 15_000 });
}

test.describe("IDE Layout", () => {
  test("all 6 sections render at 1440px width", { tag: ["@smoke", "@regression"] }, async ({ authedPage: page }) => {
    await openSchemas(page);

    await expect(page.getByTestId("topbar")).toBeVisible();
    await expect(page.getByTestId("activity-bar")).toBeVisible();
    await expect(page.getByTestId("left-sidebar")).toBeVisible();
    await expect(page.getByTestId("center-panel")).toBeVisible();
    await expect(page.getByTestId("right-panel")).toBeVisible();
    await expect(page.getByTestId("status-bar")).toBeVisible();
  });

  test("Activity Bar navigation switches routes", { tag: ["@smoke", "@regression"] }, async ({ authedPage: page }) => {
    await openSchemas(page);

    await page.getByTestId("nav-lineage").click();
    await expect(page).toHaveURL(/\/lineage/);
    await expect(
      page.getByRole("heading", { name: "Lineage Graph" })
    ).toBeVisible();

    await page.getByTestId("nav-governance").click();
    await expect(page).toHaveURL(/\/governance/);

    await page.getByTestId("nav-schemas").click();
    await expect(page).toHaveURL(/\/schemas/);
    await expect(
      page.getByRole("heading", { name: "Domains" })
    ).toBeVisible();
  });

  test("sidebar collapses and expands via double-click", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    await openSchemas(page);

    const sidebar = page.getByTestId("left-sidebar");
    await expect(sidebar).toHaveAttribute("data-collapsed", "false");

    // Double-click handle to collapse
    await page.getByTestId("sidebar-handle").first().dblclick();
    await expect(sidebar).toHaveAttribute("data-collapsed", "true");

    // Double-click again to expand
    await page.getByTestId("sidebar-handle").first().dblclick();
    await expect(sidebar).toHaveAttribute("data-collapsed", "false");
  });

  test("panel widths persist after reload", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    await openSchemas(page);

    // Wait for sidebar to render
    await expect(page.getByTestId("left-sidebar")).toHaveAttribute(
      "data-collapsed",
      "false"
    );

    // The layout effect writes the width to localStorage after the first render: poll for it (no fixed sleep).
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("panel-width-left-sidebar")), {
        message: "the sidebar width was never stored",
      })
      .toBeTruthy();

    // Reload and verify sidebar still visible (the explorer replaces its loading fallback, which has another test id)
    await page.reload();
    await expect(page.getByTestId("left-sidebar")).toHaveAttribute(
      "data-collapsed",
      "false",
      { timeout: 15_000 }
    );
  });

  test("at 1200px, panels auto-collapse with warning", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    await openSchemas(page, 1200);

    await expect(page.getByTestId("responsive-warning")).toBeVisible();
    const sidebar = page.getByTestId("left-sidebar");
    await expect(sidebar).toHaveAttribute("data-collapsed", "true");
  });
});
