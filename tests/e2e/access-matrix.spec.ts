/**
 * The access matrix: who may see and do what, end to end (access-control design, Task 9). Every test makes the people it needs through the database helpers
 * (`createUser` + `grantRole`: helpers/second-user.ts), signs each in through the REAL login form in a browser context of their own, and checks the same rule in every
 * place it is enforced: the screens, the app's own JSON endpoints, the REST API v1 and, where the screen cannot make the call, the server action POSTed by hand
 * (`captureAction` / `replayAction`: the page's own `Next-Action` request, sent again with other arguments, as the person's session). The rule per role and action is
 * the table in src/lib/access/actions.ts; `docs/testing/access-control.md` says what each test covers and what is covered somewhere else.
 *
 * What each test is:
 *   - VIEWER          sees the workspace; the screens refuse an added field, a publish, a new domain and the new-entity page, nothing is written (no audit row), the same POST by hand is refused,
 *                     the endpoints that write or that are another role's (webhooks, compliance, AI) answer 403;
 *   - AUTHOR          writes (a field is added, and its audit row names the tenant) and cannot publish, cannot approve a governance request, cannot create a domain, and passes the AI route's role gate;
 *   - STEWARD         publishes, approves a governance request and creates a domain; compliance is not theirs (403: the Compliance Officer is above the Steward on the ladder, not beside it);
 *   - COMPLIANCE_OFFICER  reads the Query, Gaps and Audit Trail tabs (screen and API) and, being above the Steward on the ladder, holds the Steward's rights too (the ladder is linear: policy.test.ts);
 *   - tenant ADMIN    of tenant A neither sees nor reaches tenant B: not in the switcher, not in /api/tenants, a forged `active_tenant` cookie changes nothing, B's entity is a not-found at its
 *                     address and by id on /api/v1 (identical to an unknown id), a POST by hand against B's entity is refused, and the platform endpoints stay platform-only;
 *   - domain AUTHOR   is confined to the domain: the sibling domain is absent from the tree, a not-found at its address, absent from /api/v1 and /api/domains-tree, a write against it is
 *                     refused, the tenant-level (Enterprise) entity is not theirs either;
 *   - product role    sees its own domain (as the parent) and its own product only, writes there and nowhere else;
 *   - no role         lands on /no-access from every page and gets a 404 (or an empty list, or a 403 for platform items) from every /api/* route, nothing of the tenant in any body;
 *   - disabled        a user disabled while signed in is refused on the next page, API call and POSTed action, and is let in again when enabled (the state is the database's, not the cookie's);
 *   - reference closure  a domain AUTHOR whose entity refers to an entity of another domain is refused the emission in the screen and with a 403 from /api/v1 emit and validate, in words that name nothing
 *                     of the other entity (KD-045), while a tenant-wide AUTHOR is not refused;
 *   - invite mode     (@external: needs the second app, `--second-app` / the nightly tier) `AUTH_REGISTRATION=invite` has no register form, and /register needs a live invitation token.
 *
 * NOT HERE (covered, and not repeated): the invite flow end to end, disabling and resetting through the Users screen, the last administrator, the tenant administrator's and an AUTHOR's views of
 * /admin: user-management.spec.ts; the lockout after five wrong passwords, the uniform login answers, the register page: auth.spec.ts; the webhook endpoints' 403 for every non-platform
 * caller and the notifications API: api-v1.spec.ts; an AUTHOR who may not decide a governance request, per button: governance-compliance.spec.ts.
 *
 * What it leaves behind: the tenants, domains and entities go with each test's tenant (the cascade). A person who WROTE something has an audit row, and audit rows are immutable and point at
 * their user, so that account cannot be deleted (`deleteUsersBestEffort` leaves it, the run's database is thrown away); a person who only read leaves nothing.
 */
import type { APIResponse, Page } from "@playwright/test";
import { madeUpClientAddress, expectApiError, expectApiSuccess, jsonOf } from "./helpers/api";
import {
  createEntityInProduct,
  createEntityInTenant,
  createGovernanceRequest,
  createInvitationRow,
  createIsolatedWorkspaceRows,
  createProductInDomain,
  createReferenceFieldRow,
  createSiblingDomainRows,
  deleteGovernanceRequestsByEntity,
  deleteInvitationsByEmail,
  deleteIsolatedWorkspaceRows,
  disableUser,
  disconnectDb,
  enableUser,
  governanceOutcome,
  pg,
  seededOwnerId,
  type IsolatedWorkspaceRows,
  type SiblingDomainRows,
} from "./helpers/db";
import { afterServerAction, fieldRow, openEntityPage, openPublishDialog, publishViaDialog, versionState } from "./helpers/entity-page";
import { captureAction, replayAction } from "./helpers/admin-users";
import { centerPanel, leftSidebar } from "./helpers/event-builder";
import { test, expect, unique } from "./helpers/fixtures";
import { waitForHydration } from "./helpers/hydration";
import { errorToast } from "./helpers/lifecycle";
import { withSecondUser, type SecondUser, type SecondUserRole } from "./helpers/second-user";

const MOD = "ControlOrMeta";
const FORBIDDEN_TEXT = "You do not have permission to do this";

// ---------------------------------------------------------------------------
// The world a test works in: a tenant of its own (A) with a domain, a product and an entity "Customer", a sibling domain with an entity "Invoice", and,
// where a test needs them, a tenant-level entity, a sibling product and a second tenant (B). All of it goes with the tenant.
// ---------------------------------------------------------------------------

interface World {
  a: IsolatedWorkspaceRows;
  sibling: SiblingDomainRows;
  customerUrl: string;
}

/** Tenants a test made, so the `finally` of `withWorld` removes them whatever the test does. */
async function withWorld<T>(body: (world: World) => Promise<T>): Promise<T> {
  const a = await createIsolatedWorkspaceRows();
  try {
    const sibling = await createSiblingDomainRows(a.tenantId);
    return await body({ a, sibling, customerUrl: `/schemas/${a.domain.slug}/${a.product.slug}/${a.entity.slug}` });
  } finally {
    await deleteIsolatedWorkspaceRows(a);
  }
}

const entityUrlOf = (domain: { slug: string }, product: { slug: string }, entity: { slug: string }): string => `/schemas/${domain.slug}/${product.slug}/${entity.slug}`;

/** The names of an entity's fields, in order. */
async function fieldNamesOf(entityId: string): Promise<string[]> {
  const { rows } = await pg().query(`SELECT name FROM fields WHERE "entityId" = $1 ORDER BY "sortOrder", name`, [entityId]);
  return rows.map((row) => row.name as string);
}

/** How many audit rows a user wrote, and the tenants they name. */
async function auditOf(userId: string): Promise<{ count: number; tenantIds: Array<string | null> }> {
  const { rows } = await pg().query(`SELECT "tenantId" FROM audit_log WHERE "userId" = $1`, [userId]);
  return { count: rows.length, tenantIds: [...new Set(rows.map((row) => (row.tenantId as string | null) ?? null))] };
}

async function publishedVersionsOf(entityId: string): Promise<number> {
  const { rows } = await pg().query(`SELECT count(*)::int AS n FROM entity_versions WHERE "entityId" = $1`, [entityId]);
  return rows[0].n as number;
}

const role = (name: SecondUserRole["role"], scope: SecondUserRole["scope"]): SecondUserRole => ({ role: name, scope });

/** The person's own calls to the app's endpoints: their browser context's session, each with a client address of its own (the REST API limits emit and validate per address). */
function apiOf(user: SecondUser) {
  const headers = { "x-forwarded-for": madeUpClientAddress() };
  return {
    get: (path: string): Promise<APIResponse> => user.context.request.get(path, { headers }),
    post: (path: string, data: unknown = {}): Promise<APIResponse> => user.context.request.post(path, { headers, data }),
  };
}

/** Open the new-field form and Quick Create a field of this name: the first half of an add, which the server then accepts or refuses. */
async function submitNewField(page: Page, name: string): Promise<void> {
  const form = centerPanel(page).getByTestId("new-field-form");
  await centerPanel(page).getByTestId("field-add-button").click();
  await form.getByPlaceholder("field_name").fill(name);
  // Leave the input so a suggestion list for a name the autocomplete knows is closed before the button is used.
  await form.getByRole("heading", { name: "New Field" }).click();
  await expect(form.getByTestId("autocomplete-suggestions")).toHaveCount(0);
  await form.getByRole("button", { name: "Quick Create" }).click();
}

/** Add a field through the screen and capture the server action POST it made (the body holds the field's name, so it names this call). */
async function addFieldCapturing(page: Page, name: string) {
  const form = centerPanel(page).getByTestId("new-field-form");
  await centerPanel(page).getByTestId("field-add-button").click();
  await form.getByPlaceholder("field_name").fill(name);
  await form.getByRole("heading", { name: "New Field" }).click();
  await expect(form.getByTestId("autocomplete-suggestions")).toHaveCount(0);
  return captureAction(page, () => form.getByRole("button", { name: "Quick Create" }).click(), name);
}

/** The dashboard's shell is up: the explorer has loaded (its Enterprise root is there). */
async function explorerLoaded(page: Page): Promise<void> {
  await expect(leftSidebar(page).getByTestId("enterprise")).toBeVisible({ timeout: 30_000 });
}

const notFoundCard = (page: Page) => page.getByTestId("dashboard-not-found");

test.afterAll(async () => {
  await disconnectDb();
});

// ---------------------------------------------------------------------------
// Roles over one tenant
// ---------------------------------------------------------------------------

test.describe("a role over the whole tenant", () => {
  test("a VIEWER sees the workspace and cannot create, edit or publish: the screens refuse, nothing is written, the same POST by hand is refused, and the endpoints of other roles answer 403", { tag: ["@regression"] }, async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(240_000);
    await withWorld(async (w) => {
      await withSecondUser(
        browser,
        baseURL,
        async (viewer) => {
          const page = viewer.page;

          // They SEE: both domains of the tenant are on the grid, the entity opens, its field is listed.
          await page.goto("/schemas");
          await expect(centerPanel(page).getByText(w.a.domain.name).first()).toBeVisible();
          await expect(centerPanel(page).getByText(w.sibling.domain.name).first()).toBeVisible();
          await openEntityPage(page, w.customerUrl, "Customer");
          await expect(fieldRow(page, "id")).toBeVisible();

          // EDIT: an added field is refused by the server and the screen says so; the entity is as it was.
          const captured = await addFieldCapturing(page, "memo");
          await expect(errorToast(page).filter({ hasText: FORBIDDEN_TEXT })).toBeVisible();
          await expect(fieldRow(page, "memo")).toHaveCount(0);
          expect(await fieldNamesOf(w.a.entity.id)).toEqual(["id"]);

          // The same POST by hand, with another name: refused as well (the screen is not what protects the entity).
          const replayed = await replayAction(page, captured, captured.body.replace("memo", "memo_by_hand"));
          expect(replayed.text).toContain(FORBIDDEN_TEXT);
          expect(await fieldNamesOf(w.a.entity.id)).toEqual(["id"]);

          // PUBLISH: the dialog opens (they may read the preview), the confirmation is refused in the dialog itself, nothing is published.
          const dialog = await openPublishDialog(page);
          await dialog.getByTestId("confirm-publish").click();
          await expect(dialog.getByTestId("publish-error")).toHaveText(FORBIDDEN_TEXT);
          expect(await publishedVersionsOf(w.a.entity.id)).toBe(0);

          // CREATE: a domain is refused on the grid, and the new-entity page of the product is not found (it needs the right to write there).
          await page.goto("/schemas");
          const create = centerPanel(page).getByTestId("create-domain-button");
          await waitForHydration(create);
          await create.click();
          const domainName = unique("viewer-domain-");
          await page.getByPlaceholder(/Customer, Payment/i).fill(domainName);
          await page.getByTestId("create-domain-submit").click();
          await expect(page.getByTestId("create-domain-error")).toContainText(FORBIDDEN_TEXT);
          expect((await pg().query(`SELECT 1 FROM domains WHERE name = $1`, [domainName])).rows).toHaveLength(0);
          await page.goto(`/schemas/${w.a.domain.slug}/${w.a.product.slug}/new`);
          await expect(notFoundCard(page)).toBeVisible();

          // The endpoints: their own tenant's schemas are readable; the platform's webhooks, compliance and the AI suggestion are other roles' (403, naming nothing).
          const api = apiOf(viewer);
          const listed = await expectApiSuccess<Array<{ id: string; name: string }>>(await api.get("/api/v1/schemas"));
          expect(listed.data.map((entity) => entity.name).sort()).toEqual(["Customer", "Invoice"]);
          const webhook = await expectApiError(await api.post("/api/v1/webhooks", { url: "https://example.invalid/hook", events: ["emission.completed"] }), 403, "FORBIDDEN");
          expect(webhook.message).toBe(FORBIDDEN_TEXT);
          for (const path of ["/api/compliance/query", "/api/compliance/gaps", "/api/compliance/audit-trail"]) {
            const response = await api.post(path, { filters: {} });
            expect(response.status(), path).toBe(403);
            expect(await jsonOf(response), path).toEqual({ success: false, error: FORBIDDEN_TEXT });
          }
          const ai = await api.post("/api/ai/generate-entity", { domainId: w.a.domain.id, description: "an invoice" });
          expect(ai.status()).toBe(403);
          expect(await jsonOf(ai)).toEqual({ error: FORBIDDEN_TEXT });

          // They wrote nothing at all: not even an audit row.
          expect((await auditOf(viewer.id)).count).toBe(0);
        },
        { roles: [role("VIEWER", { tenantId: w.a.tenantId })] },
      );
    });
  });

  test("an AUTHOR writes, and the audit row names the tenant; they cannot publish, approve a governance request or create a domain, and they pass the AI route's role gate", { tag: ["@regression"] }, async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(240_000);
    await withWorld(async (w) => {
      const requested: string[] = [];
      try {
        await withSecondUser(
          browser,
          baseURL,
          async (author) => {
            const page = author.page;

            // WRITES: a field is added and kept, and the audit row of the change is the tenant's (KD-016).
            await openEntityPage(page, w.customerUrl, "Customer");
            await submitNewField(page, "memo");
            await expect(fieldRow(page, "memo")).toBeVisible();
            expect(await fieldNamesOf(w.a.entity.id)).toEqual(["id", "memo"]);
            const audit = await auditOf(author.id);
            expect(audit.count).toBeGreaterThan(0);
            expect(audit.tenantIds).toEqual([w.a.tenantId]);

            // PUBLISH is the Steward's: refused in the dialog, nothing is published.
            const dialog = await openPublishDialog(page);
            await dialog.getByTestId("confirm-publish").click();
            await expect(dialog.getByTestId("publish-error")).toHaveText(FORBIDDEN_TEXT);
            expect(await publishedVersionsOf(w.a.entity.id)).toBe(0);

            // APPROVE is the Steward's: the request is listed (they may read it), the decision is refused, the request stays pending.
            const entityName = unique("MatrixGov");
            requested.push(entityName);
            const request = await createGovernanceRequest({ entityId: w.a.entity.id, entityName });
            await page.goto("/governance");
            await waitForHydration(centerPanel(page).getByTestId("governance-dashboard"));
            const card = centerPanel(page).getByTestId("governance-request-card").filter({ hasText: entityName });
            await expect(card).toBeVisible();
            await card.getByTestId("governance-approve").click();
            await afterServerAction(page, () => card.getByTestId("governance-approve").click(), { body: request.id });
            expect(await governanceOutcome(request.id)).toEqual({ status: "PENDING", decisions: [] });

            // CREATE a domain is the Steward's: refused on the grid.
            await page.goto("/schemas");
            const create = centerPanel(page).getByTestId("create-domain-button");
            await waitForHydration(create);
            await create.click();
            const domainName = unique("author-domain-");
            await page.getByPlaceholder(/Customer, Payment/i).fill(domainName);
            await page.getByTestId("create-domain-submit").click();
            await expect(page.getByTestId("create-domain-error")).toContainText(FORBIDDEN_TEXT);
            expect((await pg().query(`SELECT 1 FROM domains WHERE name = $1`, [domainName])).rows).toHaveLength(0);

            // The API: the AI suggestion is an AUTHOR's act. A run has no AI provider, so passing the role gate is a 503 ("not configured"), where a viewer gets the 403 above.
            const api = apiOf(author);
            const ai = await api.post("/api/ai/generate-entity", { domainId: w.a.domain.id, description: "an invoice" });
            expect(ai.status()).toBe(503);
            // Compliance is not an author's.
            expect((await api.post("/api/compliance/query", { filters: {} })).status()).toBe(403);
          },
          { roles: [role("AUTHOR", { tenantId: w.a.tenantId })] },
        );
      } finally {
        await deleteGovernanceRequestsByEntity(requested);
      }
    });
  });

  test("a STEWARD publishes, approves a governance request and creates a domain; compliance is not theirs", { tag: ["@regression"] }, async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    await withWorld(async (w) => {
      const requested: string[] = [];
      try {
        await withSecondUser(
          browser,
          baseURL,
          async (steward) => {
            const page = steward.page;

            // PUBLISH: the entity is published as 1.0, and a version row is in the database.
            await openEntityPage(page, w.customerUrl, "Customer");
            await expect(versionState(page)).toHaveText("Never published");
            expect(await publishViaDialog(page)).toBe("1.0");
            expect(await publishedVersionsOf(w.a.entity.id)).toBe(1);

            // APPROVE: the decision is recorded.
            const entityName = unique("MatrixGov");
            requested.push(entityName);
            const request = await createGovernanceRequest({ entityId: w.a.entity.id, entityName });
            await page.goto("/governance");
            await waitForHydration(centerPanel(page).getByTestId("governance-dashboard"));
            const card = centerPanel(page).getByTestId("governance-request-card").filter({ hasText: entityName });
            await card.getByTestId("governance-approve").click();
            await card.getByTestId("governance-comment").fill("Reviewed");
            await afterServerAction(page, () => card.getByTestId("governance-approve").click(), { body: request.id });
            await expect(card).toHaveCount(0);
            expect(await governanceOutcome(request.id)).toEqual({ status: "APPROVED", decisions: [{ decision: "APPROVE", comment: "Reviewed" }] });

            // CREATE a domain: it is made, in this tenant.
            await page.goto("/schemas");
            const create = centerPanel(page).getByTestId("create-domain-button");
            await waitForHydration(create);
            await create.click();
            const domainName = unique("steward-domain-");
            await page.getByPlaceholder(/Customer, Payment/i).fill(domainName);
            await page.getByTestId("create-domain-submit").click();
            await expect(centerPanel(page).getByText(domainName).first()).toBeVisible();
            const made = await pg().query(`SELECT "tenantId" FROM domains WHERE name = $1`, [domainName]);
            expect(made.rows).toEqual([{ tenantId: w.a.tenantId }]);

            // Deleting a domain is the tenant administrator's: the steward is offered no delete on the grid.
            await expect(centerPanel(page).getByTestId("domain-card-delete")).toHaveCount(0);

            // Compliance sits ABOVE the steward on the ladder: refused (403), not shown.
            const api = apiOf(steward);
            for (const path of ["/api/compliance/query", "/api/compliance/gaps", "/api/compliance/audit-trail"]) {
              expect((await api.post(path, { filters: {} })).status(), path).toBe(403);
            }
          },
          { roles: [role("STEWARD", { tenantId: w.a.tenantId })] },
        );
      } finally {
        await deleteGovernanceRequestsByEntity(requested);
      }
    });
  });

  test("a COMPLIANCE_OFFICER reads the Query, Gaps and Audit Trail tabs and the API behind them, and holds the Steward's rights too (the ladder is linear)", { tag: ["@regression"] }, async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(240_000);
    await withWorld(async (w) => {
      await withSecondUser(
        browser,
        baseURL,
        async (officer) => {
          const page = officer.page;
          const api = apiOf(officer);

          // The API: all three answer 200, with the tenant's own fields and nothing of another tenant.
          for (const path of ["/api/compliance/query", "/api/compliance/gaps", "/api/compliance/audit-trail"]) {
            const response = await api.post(path, { filters: {} });
            expect(response.status(), path).toBe(200);
            expect(((await response.json()) as { success: boolean }).success, path).toBe(true);
          }
          const queried = JSON.stringify(await (await api.post("/api/compliance/query", { filters: {} })).json());
          expect(queried).toContain("Customer");

          // The screen: the Query tab lists the tenant's fields; Gaps and Audit Trail open without an error.
          await page.goto("/compliance");
          await expect(centerPanel(page).getByTestId("compliance-error")).toHaveCount(0);
          await expect(centerPanel(page).getByTestId("compliance-row").filter({ hasText: "Customer" }).first()).toBeVisible({ timeout: 30_000 });
          for (const tab of ["Gaps", "Audit Trail"]) {
            await centerPanel(page).getByRole("tab", { name: tab }).or(centerPanel(page).getByRole("button", { name: tab })).first().click();
            await expect(centerPanel(page).getByTestId("compliance-error")).toHaveCount(0);
          }

          // The ladder (VIEWER < AUTHOR < STEWARD < COMPLIANCE_OFFICER < ADMIN, one linear order: src/types/schemas/rbac.ts): the officer holds the author's and the steward's
          // rights as well. It is not a read-only audit role; if the owner wants one, that is a policy change, and this line is what will say so.
          await openEntityPage(page, w.customerUrl, "Customer");
          await submitNewField(page, "audited");
          await expect(fieldRow(page, "audited")).toBeVisible();
          expect(await fieldNamesOf(w.a.entity.id)).toEqual(["id", "audited"]);
        },
        { roles: [role("COMPLIANCE_OFFICER", { tenantId: w.a.tenantId })] },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// The tenant boundary
// ---------------------------------------------------------------------------

test.describe("the tenant boundary", () => {
  test("the ADMIN of tenant A neither sees nor reaches tenant B: the switcher, /api/tenants, a forged cookie, B's entity by address and by id, a POST by hand, and the platform's endpoints", { tag: ["@regression"] }, async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(240_000);
    await withWorld(async (w) => {
      const b = await createIsolatedWorkspaceRows();
      try {
        const customerOfB = { ...b.entity, url: entityUrlOf(b.domain, b.product, b.entity) };
        await withSecondUser(
          browser,
          baseURL,
          async (admin) => {
            const page = admin.page;
            const api = apiOf(admin);

            // The switcher offers the one tenant they hold a role in.
            await page.goto("/schemas");
            await explorerLoaded(page);
            await page.getByTestId("tenant-switcher").click();
            await expect(page.locator('[data-testid="tenant-option"]')).toHaveCount(1);
            await expect(page.locator(`[data-testid="tenant-option"][data-tenant-id="${w.a.tenantId}"]`)).toBeVisible();
            await expect(page.locator(`[data-testid="tenant-option"][data-tenant-id="${b.tenantId}"]`)).toHaveCount(0);
            await page.keyboard.press("Escape");

            // /api/tenants lists the same one, and names no other.
            const tenants = (await (await api.get("/api/tenants")).json()) as { activeTenantId: string | null; tenants: Array<{ id: string }> };
            expect(tenants.tenants.map((tenant) => tenant.id)).toEqual([w.a.tenantId]);
            expect(tenants.activeTenantId).toBe(w.a.tenantId);

            // B's entity: a not-found at its address. (The status bar echoes the address that was typed; nothing of B is offered: no entity page, no domain in the tree, none on the page.)
            await page.goto(customerOfB.url);
            await expect(notFoundCard(page)).toBeVisible();
            await expect(centerPanel(page).getByRole("heading", { level: 1, name: "Customer" })).toHaveCount(0);
            await expect(centerPanel(page).getByText(b.domain.name)).toHaveCount(0);
            await expect(leftSidebar(page).getByTestId(`domain-${b.domain.id}`)).toHaveCount(0);

            // A forged `active_tenant` cookie naming B changes nothing: the page, the tree and the schemas are A's.
            await page.context().addCookies([{ name: "active_tenant", value: b.tenantId, url: baseURL as string }]);
            await page.goto("/schemas");
            await expect(centerPanel(page).getByText(w.a.domain.name).first()).toBeVisible();
            await expect(centerPanel(page).getByText(b.domain.name)).toHaveCount(0);
            await expect(leftSidebar(page).getByTestId(`domain-${b.domain.id}`)).toHaveCount(0);
            // Deleting a domain is the tenant administrator's: the control is on A's domain cards (and is not on a steward's: above).
            await expect(centerPanel(page).getByTestId("domain-card-delete").first()).toBeVisible();
            const tree = JSON.stringify(await (await api.get("/api/domains-tree")).json());
            expect(tree).toContain(w.a.domain.id);
            expect(tree).not.toContain(b.domain.id);
            expect(tree).not.toContain(b.entity.id);

            // /api/v1: A's entities are listed, B's is not; B's entity by id is the 404 of an id that does not exist (the same answer, so nothing says it is there).
            const listed = await expectApiSuccess<Array<{ id: string }>>(await api.get("/api/v1/schemas"));
            expect(listed.data.map((entity) => entity.id)).toContain(w.a.entity.id);
            expect(listed.data.map((entity) => entity.id)).not.toContain(b.entity.id);
            const missingId = `no-such-entity-${unique("")}`;
            const foreign = await expectApiError(await api.get(`/api/v1/schemas/${b.entity.id}`), 404, "NOT_FOUND");
            const missing = await expectApiError(await api.get(`/api/v1/schemas/${missingId}`), 404, "NOT_FOUND");
            // The same answer but for the id the caller asked about (the message repeats it).
            expect({ ...foreign, message: foreign.message.replace(b.entity.id, "<id>") }).toEqual({ ...missing, message: missing.message.replace(missingId, "<id>") });
            await expectApiError(await api.post(`/api/v1/schemas/${b.entity.id}/emit`), 404, "NOT_FOUND");

            // The platform's endpoints are the platform administrator's: a tenant ADMIN is refused.
            await expectApiError(await api.get("/api/v1/webhooks"), 403, "FORBIDDEN");

            // A POST by hand: their own add-field (it works on A's entity), sent again with B's entity id and another name, is refused and B's entity is untouched.
            await openEntityPage(page, w.customerUrl, "Customer");
            const captured = await addFieldCapturing(page, "memo");
            await expect(fieldRow(page, "memo")).toBeVisible();
            const forged = await replayAction(page, captured, captured.body.replace(w.a.entity.id, b.entity.id).replace("memo", "memo_in_b"));
            expect(forged.text).toContain("Entity not found");
            expect(await fieldNamesOf(b.entity.id)).toEqual(["id"]);
          },
          { roles: [role("ADMIN", { tenantId: w.a.tenantId })] },
        );
      } finally {
        await deleteIsolatedWorkspaceRows(b);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Roles over a part of the tenant
// ---------------------------------------------------------------------------

test.describe("a role over a domain or a product", () => {
  test("an AUTHOR of one domain is confined to it: the sibling domain and the tenant-level entities are absent, a not-found, absent from the API, and a write against them is refused", { tag: ["@regression"] }, async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(240_000);
    await withWorld(async (w) => {
      const enterprise = await createEntityInTenant(w.a.tenantId, "EnterpriseThing");
      await withSecondUser(
        browser,
        baseURL,
        async (author) => {
          const page = author.page;
          const api = apiOf(author);

          // The tree: their domain is there, the sibling is not (and no page of the dashboard names it).
          await page.goto("/schemas");
          await explorerLoaded(page);
          await expect(leftSidebar(page).getByTestId(`domain-${w.a.domain.id}`)).toBeVisible();
          await expect(leftSidebar(page).getByTestId(`domain-${w.sibling.domain.id}`)).toHaveCount(0);
          await expect(centerPanel(page).getByText(w.sibling.domain.name)).toHaveCount(0);

          // The sibling's page and its entity, and the tenant-level entity: not found.
          for (const path of [`/schemas/${w.sibling.domain.slug}`, w.sibling.entity.url, `/schemas/enterprise/entities/enterprisething`]) {
            await page.goto(path);
            await expect(notFoundCard(page), path).toBeVisible();
          }

          // Their own domain: the entity opens and a field is added.
          await openEntityPage(page, w.customerUrl, "Customer");
          const captured = await addFieldCapturing(page, "memo");
          await expect(fieldRow(page, "memo")).toBeVisible();
          expect(await fieldNamesOf(w.a.entity.id)).toEqual(["id", "memo"]);

          // The same POST by hand against the sibling's entity and against the tenant-level one: refused (the answer of an entity that is not there), nothing is written.
          const sibling = await replayAction(page, captured, captured.body.replace(w.a.entity.id, w.sibling.entity.id).replace("memo", "memo_in_sibling"));
          expect(sibling.text).toContain("Entity not found");
          expect(await fieldNamesOf(w.sibling.entity.id)).toEqual(["id"]);
          const tenantLevel = await replayAction(page, captured, captured.body.replace(w.a.entity.id, enterprise.id).replace("memo", "memo_in_enterprise"));
          expect(tenantLevel.text).toContain("Entity not found");
          expect(await fieldNamesOf(enterprise.id)).toEqual(["id"]);

          // /api/v1 and the tree: only their domain's entity; the others are the 404 of an id that is not there.
          const listed = await expectApiSuccess<Array<{ id: string }>>(await api.get("/api/v1/schemas"));
          expect(listed.data.map((entity) => entity.id)).toEqual([w.a.entity.id]);
          await expectApiError(await api.get(`/api/v1/schemas/${w.sibling.entity.id}`), 404, "NOT_FOUND");
          await expectApiError(await api.get(`/api/v1/schemas/${enterprise.id}`), 404, "NOT_FOUND");
          const tree = JSON.stringify(await (await api.get("/api/domains-tree")).json());
          expect(tree).toContain(w.a.domain.id);
          expect(tree).not.toContain(w.sibling.domain.id);

          // What an AUTHOR may not do anywhere: create a domain (the Steward's).
          await page.goto("/schemas");
          const create = centerPanel(page).getByTestId("create-domain-button");
          await waitForHydration(create);
          await create.click();
          const domainName = unique("domain-author-");
          await page.getByPlaceholder(/Customer, Payment/i).fill(domainName);
          await page.getByTestId("create-domain-submit").click();
          await expect(page.getByTestId("create-domain-error")).toBeVisible();
          expect((await pg().query(`SELECT 1 FROM domains WHERE name = $1`, [domainName])).rows).toHaveLength(0);
        },
        { roles: [role("AUTHOR", { tenantId: w.a.tenantId, domainId: w.a.domain.id })] },
      );
    });
  });

  test("a role over one product sees its own domain (as the parent) and that product only, writes there and nowhere else", { tag: ["@regression"] }, async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    await withWorld(async (w) => {
      const secondProduct = await createProductInDomain(w.a.domain.id);
      const sibling = await createEntityInProduct(w.a.domain.id, secondProduct.id, "Neighbour", w.a.tenantId);
      const siblingUrl = entityUrlOf(w.a.domain, secondProduct, sibling);
      await withSecondUser(
        browser,
        baseURL,
        async (author) => {
          const page = author.page;
          const api = apiOf(author);

          // Their product's entity opens, and a field is added there.
          await openEntityPage(page, w.customerUrl, "Customer");
          await explorerLoaded(page);
          const captured = await addFieldCapturing(page, "memo");
          await expect(fieldRow(page, "memo")).toBeVisible();

          // The tree: the domain is the parent of their product, the product is there, its sibling product and the sibling domain are not.
          await expect(leftSidebar(page).getByTestId(`domain-${w.a.domain.id}`)).toBeVisible();
          await expect(leftSidebar(page).getByTestId(`product-${w.a.product.id}`)).toBeVisible();
          await expect(leftSidebar(page).getByTestId(`product-${secondProduct.id}`)).toHaveCount(0);
          await expect(leftSidebar(page).getByTestId(`domain-${w.sibling.domain.id}`)).toHaveCount(0);

          // The sibling product's entity is a not-found, and a write against it by hand is refused.
          await page.goto(siblingUrl);
          await expect(notFoundCard(page)).toBeVisible();
          const forged = await replayAction(page, captured, captured.body.replace(w.a.entity.id, sibling.id).replace("memo", "memo_in_neighbour"));
          expect(forged.text).toContain("Entity not found");
          expect(await fieldNamesOf(sibling.id)).toEqual(["id"]);

          // The API: their product's entity, and nothing else of the tenant.
          const listed = await expectApiSuccess<Array<{ id: string }>>(await api.get("/api/v1/schemas"));
          expect(listed.data.map((entity) => entity.id)).toEqual([w.a.entity.id]);
          await expectApiError(await api.get(`/api/v1/schemas/${sibling.id}`), 404, "NOT_FOUND");
          const tree = (await (await api.get("/api/domains-tree")).json()) as { domains: Array<{ id: string; products: Array<{ id: string }> }> };
          expect(tree.domains.map((domain) => domain.id)).toEqual([w.a.domain.id]);
          expect(tree.domains[0].products.map((product) => product.id)).toEqual([w.a.product.id]);
        },
        { roles: [role("AUTHOR", { tenantId: w.a.tenantId, domainId: w.a.domain.id, productId: w.a.product.id })] },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// No role, and a disabled account
// ---------------------------------------------------------------------------

test.describe("no role, and a disabled account", () => {
  test("a user with no role lands on /no-access from every page and gets nothing of the tenant from /api/*", { tag: ["@regression"] }, async ({ browser, baseURL, playwright }) => {
    test.setTimeout(240_000);
    await withWorld(async (w) => {
      await withSecondUser(browser, baseURL, async (nobody) => {
        const page = nobody.page;
        await expect(page.getByTestId("no-access")).toBeVisible();
        await expect(page.getByTestId("no-access-email")).toContainText(nobody.email);

        // Every page of the dashboard is that page: nothing of the workspace is drawn.
        for (const path of ["/schemas", w.customerUrl, `/schemas/${w.a.domain.slug}`, "/governance", "/compliance", "/admin", "/notifications"]) {
          await page.goto(path);
          await expect(page, path).toHaveURL((url) => url.pathname === "/no-access");
          await expect(page.getByText(w.a.domain.name), path).toHaveCount(0);
        }

        // The API: no data. Another tenant's content is a 404 (the answer of a tenant that is not there), the list of their own tenants is empty, platform items are a 403, and their own
        // mailbox is still theirs.
        const api = apiOf(nobody);
        const everything: string[] = [];
        const text = async (response: APIResponse) => {
          const body = await response.text();
          everything.push(body);
          return body;
        };
        const tenants = await api.get("/api/tenants");
        expect(tenants.status()).toBe(200);
        expect(JSON.parse(await text(tenants))).toEqual({ activeTenantId: null, tenants: [] });
        for (const path of ["/api/domains-tree", "/api/command-palette-fields", "/api/v1/schemas", `/api/v1/schemas/${w.a.entity.id}`]) {
          const response = await api.get(path);
          expect(response.status(), path).toBe(404);
          await text(response);
        }
        for (const path of ["/api/compliance/query", "/api/compliance/gaps", "/api/compliance/audit-trail", `/api/v1/schemas/${w.a.entity.id}/emit`, "/api/ai/generate-entity"]) {
          const response = await api.post(path, { filters: {}, domainId: w.a.domain.id, description: "x" });
          expect(response.status(), path).toBe(404);
          await text(response);
        }
        await expectApiError(await api.get("/api/v1/webhooks"), 403, "FORBIDDEN");
        const mailbox = await api.get("/api/v1/notifications");
        expect(mailbox.status()).toBe(200);
        await text(mailbox);
        for (const body of everything) {
          expect(body).not.toContain(w.a.domain.name);
          expect(body).not.toContain(w.a.entity.id);
          expect(body).not.toContain(w.sibling.entity.id);
        }

        // And without any session at all: 401, for the same two kinds of endpoint.
        const anonymous = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
        try {
          await expectApiError(await anonymous.get("/api/v1/schemas"), 401, "UNAUTHORIZED");
          expect((await anonymous.get("/api/tenants", { maxRedirects: 0 })).status()).toBe(401);
        } finally {
          await anonymous.dispose();
        }
      });
    });
  });

  test("a user disabled while signed in is refused on the next page, call and POSTed action, and is let in again when enabled: the account's state is the database's, not the cookie's", { tag: ["@regression"] }, async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(240_000);
    await withWorld(async (w) => {
      await withSecondUser(
        browser,
        baseURL,
        async (author) => {
          const page = author.page;
          const api = apiOf(author);

          // Signed in and working: a field is added, a call is answered.
          await openEntityPage(page, w.customerUrl, "Customer");
          const captured = await addFieldCapturing(page, "before_disable");
          await expect(fieldRow(page, "before_disable")).toBeVisible();
          await expectApiSuccess(await api.get("/api/v1/schemas"));

          // Disabled: the session cookie is the same one, and nothing of it is honoured.
          await disableUser(author.id);
          await page.goto("/schemas");
          await expect(page).toHaveURL((url) => url.pathname === "/no-access");
          await expectApiError(await api.get("/api/v1/schemas"), 401, "UNAUTHORIZED");
          expect((await api.get("/api/tenants")).status()).toBe(401);
          // The page's own action, POSTed again: refused, nothing written.
          const refused = await replayAction(page, captured, captured.body.replace("before_disable", "after_disable"));
          expect(refused.text).not.toContain("after_disable");
          expect(await fieldNamesOf(w.a.entity.id)).toEqual(["id", "before_disable"]);

          // Enabled again: the same cookie works, and the same POST is accepted.
          await enableUser(author.id);
          await openEntityPage(page, w.customerUrl, "Customer");
          await expectApiSuccess(await api.get("/api/v1/schemas"));
          await replayAction(page, captured, captured.body.replace("before_disable", "after_enable"));
          expect(await fieldNamesOf(w.a.entity.id)).toContain("after_enable");
        },
        { roles: [role("AUTHOR", { tenantId: w.a.tenantId })] },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// The reference closure (KD-045)
// ---------------------------------------------------------------------------

test.describe("the reference closure", () => {
  test("an AUTHOR of one domain whose entity refers to an entity of another domain is refused the emission, in the screen and by /api/v1, in words that name nothing of the other entity; a tenant-wide AUTHOR is not refused", { tag: ["@regression"] }, async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(300_000);
    await withWorld(async (w) => {
      // Customer (their domain) has a reference field to Invoice (the sibling domain).
      await createReferenceFieldRow(w.a.entity.id, { id: w.sibling.entity.id, name: w.sibling.entity.name }, "invoice_ref");
      await withSecondUser(
        browser,
        baseURL,
        async (author) => {
          const page = author.page;
          const api = apiOf(author);

          // The screen: Mod+E emits the entity; the toast is the closure's refusal, naming their own field and nothing of the other entity.
          await openEntityPage(page, w.customerUrl, "Customer");
          await waitForHydration(page.getByTestId("topbar"));
          await page.keyboard.press(`${MOD}+e`);
          const refusal = errorToast(page).filter({ hasText: "refers to an entity that none of your roles covers" });
          await expect(refusal).toBeVisible({ timeout: 45_000 });
          await expect(refusal).toContainText('Field "invoice_ref"');
          const said = await refusal.innerText();
          expect(said).not.toContain(w.sibling.entity.name);
          expect(said).not.toContain(w.sibling.domain.name);

          // /api/v1: emit and validate both refuse with a 403 and the same kind of message.
          for (const path of [`/api/v1/schemas/${w.a.entity.id}/emit`, `/api/v1/schemas/${w.a.entity.id}/validate`]) {
            const error = await expectApiError(await api.post(path), 403, "REFERENCE_NOT_READABLE");
            expect(error.message, path).toContain("refers to an entity that none of your roles covers");
            expect(JSON.stringify(error), path).not.toContain(w.sibling.entity.name);
            expect(JSON.stringify(error), path).not.toContain(w.sibling.entity.id);
          }
        },
        { roles: [role("AUTHOR", { tenantId: w.a.tenantId, domainId: w.a.domain.id })] },
      );

      // The control: a role over the whole tenant covers the referenced entity too, so the same call is not refused.
      await withSecondUser(
        browser,
        baseURL,
        async (wide) => {
          const response = await apiOf(wide).post(`/api/v1/schemas/${w.a.entity.id}/validate`);
          expect(response.status(), await response.text()).not.toBe(403);
          expect(response.status()).not.toBe(404);
        },
        { roles: [role("AUTHOR", { tenantId: w.a.tenantId })] },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// AUTH_REGISTRATION=invite (the second app)
// ---------------------------------------------------------------------------

test.describe("registration in invite mode (the second app)", () => {
  // The release runner's second app (`--second-app`, and by itself in the nightly tier: scripts/e2e-release.mjs) runs the same build in `AUTH_REGISTRATION=invite`, the product's own default
  // (the first app runs `open`, which the suite's own users register through), as well as `SCHEMA_IMPORT_GIT_MODE=any`. Its origin is E2E_GIT_ANY_BASE_URL.
  const secondBase = process.env.E2E_GIT_ANY_BASE_URL;
  test.skip(!secondBase, "@external second-server precondition not met: E2E_GIT_ANY_BASE_URL is not set (the release runner's nightly tier, or --second-app, starts the second server with AUTH_REGISTRATION=invite)");
  // Another server is another session: this test needs none.
  test.use({ baseURL: secondBase, storageState: { cookies: [], origins: [] } });

  test("there is no register form: /register needs a live invitation token, a wrong one is the card every dead link shows, and a live one continues at the invitation", { tag: ["@regression", "@external"] }, async ({ page }) => {
    test.setTimeout(120_000);
    const email = `${unique("e2e-invite-mode-")}@example.com`.toLowerCase();
    try {
      // No token: the generic card, and no form to fill.
      await page.goto("/register");
      await expect(page.getByTestId("invalid-link")).toBeVisible();
      await expect(page.getByTestId("register-form")).toHaveCount(0);
      await expect(page.locator("form")).toHaveCount(0);

      // A token that is not live: the same card.
      await page.goto(`/register?token=${"x".repeat(43)}`);
      await expect(page.getByTestId("invalid-link")).toBeVisible();
      await expect(page.getByTestId("register-form")).toHaveCount(0);

      // A live invitation: /register continues at /invite/<token>, whose form carries the invited address (and nothing for an e-mail to be typed into).
      const { token } = await createInvitationRow({ email, createdById: await seededOwnerId() });
      await page.goto(`/register?token=${token}`);
      await expect(page).toHaveURL((url) => url.pathname === `/invite/${token}`);
      await waitForHydration(page.getByTestId("invite-form"));
      await expect(page.getByTestId("invite-email")).toHaveValue(email);

      // Nobody registered by looking: no account for the address exists.
      expect((await pg().query(`SELECT 1 FROM users WHERE email = $1`, [email])).rows).toHaveLength(0);
    } finally {
      await deleteInvitationsByEmail([email]);
    }
  });
});
