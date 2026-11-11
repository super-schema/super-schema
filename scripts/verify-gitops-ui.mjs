import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "@playwright/test";
const server = await createServer({
  configFile: "tests/fixtures/gitops-preview/vite.config.mts",
});
let browser;
const errors = [],
  results = [];
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_EXECUTABLE
      ? { executablePath: process.env.CHROME_EXECUTABLE }
      : {}),
  });
  await mkdir("/tmp/super-schema-gitops-ui", { recursive: true });
  for (const scenario of [
    { name: "desktop-light", width: 1512, height: 1100, query: "" },
    { name: "mobile-dark", width: 390, height: 844, query: "?dark" },
    { name: "viewer-light", width: 1280, height: 1000, query: "?viewer&root" },
    {
      name: "viewer-mobile-dark",
      width: 390,
      height: 844,
      query: "?viewer&dark",
    },
  ]) {
    const page = await browser.newPage({
      viewport: { width: scenario.width, height: scenario.height },
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(
      `http://127.0.0.1:4178/tests/fixtures/gitops-preview/index.html${scenario.query}`,
    );
    await page
      .getByRole("heading", { name: "GitOps storage", exact: true })
      .waitFor();
    assert.equal(
      await page
        .locator('section[aria-labelledby="gitops-environments"] fieldset')
        .count(),
      4,
    );
    await page
      .getByRole("button", { name: /entity\.yaml$/ })
      .first()
      .click();
    await page.locator("#gitops-document").waitFor();
    assert.match(
      await page.locator("#gitops-document").inputValue(),
      /Account contract/,
    );
    assert.equal(
      await page.locator("#gitops-document").evaluate((e) => e.readOnly),
      scenario.query.includes("viewer"),
    );
    if (scenario.query.includes("viewer")) {
      assert.equal(
        await page
          .getByRole("button", { name: "New entry", exact: true })
          .count(),
        0,
      );
      assert.equal(
        await page
          .getByRole("button", { name: "Save private draft", exact: true })
          .count(),
        0,
      );
    } else {
      await page.locator("#gitops-new-name").fill("CustomerAccount");
      await page
        .getByRole("button", { name: "New entry", exact: true })
        .click();
      assert.match(
        await page.locator("#gitops-document").inputValue(),
        /CustomerAccount/,
      );
    }
    const dimensions = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      width: innerWidth,
    }));
    assert.ok(
      dimensions.scroll <= dimensions.width,
      JSON.stringify({ scenario: scenario.name, ...dimensions }),
    );
    await page.screenshot({
      path: `/tmp/super-schema-gitops-ui/${scenario.name}.png`,
      fullPage: true,
    });
    results.push({ scenario: scenario.name, ...dimensions });
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        passed: true,
        scenarios: results,
        pageErrors: errors,
        screenshots: "/tmp/super-schema-gitops-ui",
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server.close();
}
