import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "@playwright/test";
const server = await createServer({
  configFile: "tests/fixtures/tenant-storage-preview/vite.config.mts",
});
let browser;
const errors = [],
  results = [];
const output = "/tmp/super-schema-tenant-storage-ui";
try {
  await server.listen();
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_EXECUTABLE
      ? { executablePath: process.env.CHROME_EXECUTABLE }
      : {}),
  });
  for (const scenario of [
    { name: "database-desktop", width: 1440, height: 1100, query: "" },
    { name: "database-mobile", width: 390, height: 844, query: "?mobile" },
    { name: "git-desktop-dark", width: 1440, height: 1100, query: "?git&dark" },
    { name: "git-mobile-dark", width: 390, height: 844, query: "?git&dark" },
  ]) {
    const page = await browser.newPage({
      viewport: { width: scenario.width, height: scenario.height },
    });
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(
      `http://127.0.0.1:4179/tests/fixtures/tenant-storage-preview/index.html${scenario.query}`,
    );
    await page
      .getByRole("heading", { name: "Tenant storage", exact: true })
      .waitFor();
    if (!scenario.query) {
      await page.getByRole("button", { name: /^PostgreSQL/ }).focus();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Space");
      await page.getByLabel("Repository root", { exact: true }).waitFor();
      await page.getByLabel("Repository root", { exact: true }).fill("");
      await page.getByLabel("Review owners").fill("@example/one, @example/two");
      await page
        .getByRole("button", { name: "Verify & save repository" })
        .click();
      await page.getByRole("button", { name: "Use GitHub storage" }).click();
      await page.getByRole("heading", { name: "Finish Git setup" }).waitFor();
      assert.equal(
        await page.getByLabel("Repository root", { exact: true }).inputValue(),
        "",
      );
    }
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
    const accessibility = await page.evaluate(async () =>
      (await window.axe.run()).violations.map((v) => ({
        id: v.id,
        impact: v.impact,
      })),
    );
    assert.deepEqual(
      accessibility,
      [],
      JSON.stringify({ scenario: scenario.name, accessibility }),
    );
    await page.screenshot({
      path: `${output}/${scenario.name}.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "New tenant", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await dialog
      .getByLabel("Tenant name", { exact: true })
      .fill("Private schemas");
    await dialog.getByRole("button", { name: /^GitHub/ }).click();
    assert.equal(
      await dialog.getByLabel("Repository root", { exact: true }).inputValue(),
      "superschema/private-schemas",
    );
    await dialog
      .getByLabel("Repository root", { exact: true })
      .fill("my-contracts");
    await dialog
      .getByLabel("Tenant name", { exact: true })
      .fill("My private schemas");
    assert.equal(
      await dialog.getByLabel("Repository root", { exact: true }).inputValue(),
      "my-contracts",
    );
    await page.screenshot({
      path: `${output}/${scenario.name}-onboarding.png`,
      fullPage: true,
    });
    assert.ok(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth));
    const dialogAccessibility = await page.evaluate(async () =>
      (await window.axe.run()).violations.map((v) => ({
        id: v.id,
        impact: v.impact,
      })),
    );
    assert.deepEqual(
      dialogAccessibility,
      [],
      JSON.stringify({ scenario: scenario.name, dialogAccessibility }),
    );
    await dialog.getByRole("button", { name: /^PostgreSQL/ }).click();
    await dialog
      .getByRole("button", { name: "Create tenant", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByText("My private schemas", { exact: true }).waitFor();
    results.push(scenario.name);
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        passed: true,
        scenarios: results,
        pageErrors: errors,
        screenshots: output,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server.close();
}
