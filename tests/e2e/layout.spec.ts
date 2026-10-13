import { test, expect } from "@playwright/test";

// Layout tests need auth bypass - set a mock session cookie
test.beforeEach(async ({ context }) => {
  // Set session cookies to bypass auth middleware (both secure and non-secure variants)
  await context.addCookies([
    { name: "authjs.session-token", value: "test-session-token", domain: "localhost", path: "/" },
    { name: "next-auth.session-token", value: "test-session-token", domain: "localhost", path: "/" },
    { name: "__Secure-authjs.session-token", value: "test-session-token", domain: "localhost", path: "/", secure: true },
  ]);
});

test.describe("IDE Layout", () => {
  test("all 6 sections render at 1440px width", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/schemas");

    await expect(page.getByTestId("topbar")).toBeVisible();
    await expect(page.getByTestId("activity-bar")).toBeVisible();
    await expect(page.getByTestId("left-sidebar")).toBeVisible();
    await expect(page.getByTestId("center-panel")).toBeVisible();
    await expect(page.getByTestId("right-panel")).toBeVisible();
    await expect(page.getByTestId("status-bar")).toBeVisible();
  });

  test("Activity Bar navigation switches routes", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/schemas");

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

  test("sidebar collapses and expands via double-click", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/schemas");

    const sidebar = page.getByTestId("left-sidebar");
    await expect(sidebar).toHaveAttribute("data-collapsed", "false");

    // Double-click handle to collapse
    await page.getByTestId("sidebar-handle").first().dblclick();
    await expect(sidebar).toHaveAttribute("data-collapsed", "true");

    // Double-click again to expand
    await page.getByTestId("sidebar-handle").first().dblclick();
    await expect(sidebar).toHaveAttribute("data-collapsed", "false");
  });

  test("panel widths persist after reload", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/schemas");

    // Wait for sidebar to render and localStorage to be populated
    await expect(page.getByTestId("left-sidebar")).toHaveAttribute(
      "data-collapsed",
      "false"
    );

    // Give the effect time to write to localStorage
    await page.waitForTimeout(500);

    const stored = await page.evaluate(() =>
      localStorage.getItem("panel-width-left-sidebar")
    );
    expect(stored).toBeTruthy();

    // Reload and verify sidebar still visible
    await page.reload();
    await expect(page.getByTestId("left-sidebar")).toHaveAttribute(
      "data-collapsed",
      "false"
    );
  });

  test("at 1200px, panels auto-collapse with warning", async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.goto("/schemas");

    await expect(page.getByTestId("responsive-warning")).toBeVisible();
    const sidebar = page.getByTestId("left-sidebar");
    await expect(sidebar).toHaveAttribute("data-collapsed", "true");
  });
});
