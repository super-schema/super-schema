/**
 * The `test` every spec imports (`import { test, expect, unique } from "./helpers/fixtures"`): Playwright's own, extended with
 *
 *   - `authedPage`  a page that is logged in as the seeded admin. It is the page of the project's `storageState` (the session the
 *                   `setup` project saved with ONE UI login per run; playwright.config.ts), so no test logs in again. A spec that
 *                   needs the login form opts out with `test.use({ storageState: { cookies: [], origins: [] } })` and uses `page`:
 *                   `authedPage` then fails loudly instead of handing out a page that is not logged in.
 *   - `workspace`   a domain and a product, and the entities named by the `workspaceEntities` option, created straight in the
 *                   database before the test and removed (with everything the test made under them) afterwards. The fast way to a
 *                   page that needs something to work on; the UI flows that CREATE a domain / product are tested through the UI.
 *                   Needs PostgreSQL: helpers/db.ts.
 *
 *   test.use({ workspaceEntities: ["Customer", "Order"] });
 *   test("...", async ({ authedPage: page, workspace }) => { await page.goto(workspace.entities[0].url); });
 */
import { test as base, expect, type Page } from "@playwright/test";
import { createWorkspaceRows, deleteWorkspaceRows, disconnectDb, type WorkspaceRows } from "./db";
import { unique } from "./unique";

export interface Workspace {
  domainId: string;
  domainName: string;
  domainSlug: string;
  productId: string;
  productName: string;
  productSlug: string;
  /** The product page, `/schemas/<domain>/<product>`; its `/new` is the entity wizard. */
  productUrl: string;
  /** The entities of `workspaceEntities`, in that order. `url` is the entity page. */
  entities: ReadonlyArray<{ id: string; name: string; slug: string; url: string }>;
  /** Remove the domain and everything under it. Idempotent; the fixture calls it after the test, so a spec rarely needs to. */
  cleanup(): Promise<void>;
}

/** What the `workspace` fixture hands out, built without a test: a `beforeAll` (a serial describe that shares one workspace) uses it too. */
export async function createWorkspace(entityNames: readonly string[] = []): Promise<Workspace> {
  const rows = await createWorkspaceRows(entityNames);
  return toWorkspace(rows);
}

function toWorkspace(rows: WorkspaceRows): Workspace {
  const productUrl = `/schemas/${rows.domain.slug}/${rows.product.slug}`;
  let removed = false;
  return {
    domainId: rows.domain.id,
    domainName: rows.domain.name,
    domainSlug: rows.domain.slug,
    productId: rows.product.id,
    productName: rows.product.name,
    productSlug: rows.product.slug,
    productUrl,
    entities: rows.entities.map((e) => ({ id: e.id, name: e.name, slug: e.slug, url: `${productUrl}/${e.slug}` })),
    async cleanup() {
      if (removed) return;
      removed = true;
      await deleteWorkspaceRows(rows);
    },
  };
}

interface TestFixtures {
  authedPage: Page;
  workspace: Workspace;
  /** Names of the entities the `workspace` fixture creates in its product (plain identifiers); none by default. */
  workspaceEntities: string[];
}

interface WorkerFixtures {
  /** A worker's database connection is closed when the worker ends, whichever specs used it. */
  closeDbPool: void;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  workspaceEntities: [[], { option: true }],

  authedPage: async ({ page }, use) => {
    const cookies = await page.context().cookies();
    if (!cookies.some((cookie) => /session-token/.test(cookie.name))) {
      throw new Error(
        "authedPage has no session: the `setup` project did not run (`--no-deps` skips it: run `--project=setup` first), or this spec opted out of storageState. Use `page` for a logged-out test.",
      );
    }
    await use(page);
  },

  workspace: async ({ workspaceEntities }, use) => {
    const workspace = await createWorkspace(workspaceEntities);
    try {
      await use(workspace);
    } finally {
      await workspace.cleanup();
    }
  },

  closeDbPool: [
    // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's needs from this destructuring: it needs none
    async ({}, use) => {
      await use();
      await disconnectDb();
    },
    { scope: "worker", auto: true },
  ],
});

export { expect, unique };
