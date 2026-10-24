/**
 * Every dashboard page that can be reached from the shell without having to make anything first: the ActivityBar (seven items), the
 * admin tabs, and the pages those lead to. One table, read from `src/app/(dashboard)` (a route that is not in `src/app` is not here),
 * for the specs that visit all of them: smoke-pages.spec.ts (loads, no error, shell present), and the accessibility and visual
 * specs of Tasks 5-7, which can take the same list instead of a second one.
 *
 * Pages that need a record (a domain, a product, an entity, an event) are not in it: they are exercised by the specs that make the
 * record (hierarchy-crud.spec.ts and the entity specs). `/dev/design-system` is a development page (the middleware only serves it
 * when NODE_ENV is "development"); it is not tested in the browser.
 *
 * A row says what a user sees, not how the page is built: the heading is the page's own `<h1>` / `<h2>` as the accessible name
 * (queried with `getByRole("heading")`, which also ignores the hidden copy Next leaves of a streamed segment).
 */

export interface DashboardRoute {
  /** The URL path, as typed. */
  path: string;
  /** What the test is called. */
  name: string;
  /** The accessible name of the page's own heading. A string is matched exactly. */
  heading: string;
  /** The heading level (`<h1>` ... `<h3>`). */
  level: 1 | 2 | 3;
  /** How a user gets there from the shell: the ActivityBar item, an admin tab, or a link on another page. */
  from: "activity-bar" | "admin-tab" | "link";
  /** The ActivityBar item's test id (`nav-<segment>`), when `from` is "activity-bar". */
  navTestId?: string;
  /** The admin tab's test id (`admin-tab-<id>`), when the page is an admin tab. */
  adminTab?: { testId: string };
  /** A page of the pull-request tier (`@smoke`); the others are `@regression`. */
  smoke: boolean;
}

export const DASHBOARD_ROUTES: readonly DashboardRoute[] = [
  // The ActivityBar, in its order (src/components/layout/ActivityBar.tsx).
  { path: "/schemas", name: "Schema Editor", heading: "Domains", level: 1, from: "activity-bar", navTestId: "nav-schemas", smoke: true },
  { path: "/glossary", name: "Glossary", heading: "Business Glossary", level: 1, from: "activity-bar", navTestId: "nav-glossary", smoke: true },
  { path: "/lineage", name: "Lineage Graph", heading: "Lineage Graph", level: 1, from: "activity-bar", navTestId: "nav-lineage", smoke: false },
  { path: "/governance", name: "Governance", heading: "Governance Dashboard", level: 1, from: "activity-bar", navTestId: "nav-governance", smoke: true },
  { path: "/compliance", name: "Compliance", heading: "Compliance", level: 1, from: "activity-bar", navTestId: "nav-compliance", smoke: false },
  { path: "/deployments", name: "Deployments", heading: "Deployment Tracking", level: 1, from: "activity-bar", navTestId: "nav-deployments", smoke: false },
  // `/admin` is the ActivityBar's Admin item and the Users tab of the admin pages.
  { path: "/admin", name: "Admin (Users)", heading: "Users", level: 2, from: "activity-bar", navTestId: "nav-admin", adminTab: { testId: "admin-tab-users" }, smoke: true },

  // The admin tabs (src/app/(dashboard)/admin/layout.tsx), without the Users one above.
  { path: "/admin/settings", name: "Admin Settings", heading: "Settings", level: 2, from: "admin-tab", adminTab: { testId: "admin-tab-settings" }, smoke: false },
  { path: "/admin/domains", name: "Admin Domains", heading: "Domains", level: 2, from: "admin-tab", adminTab: { testId: "admin-tab-domains" }, smoke: false },
  { path: "/admin/emitters", name: "Admin Emitters", heading: "Emitters", level: 2, from: "admin-tab", adminTab: { testId: "admin-tab-emitters" }, smoke: false },
  { path: "/admin/health", name: "Admin Health", heading: "System Health", level: 2, from: "admin-tab", adminTab: { testId: "admin-tab-health" }, smoke: false },
  { path: "/admin/classifications", name: "Admin Classifications", heading: "Classifications", level: 2, from: "admin-tab", adminTab: { testId: "admin-tab-classifications" }, smoke: false },

  // Pages linked from other pages: the Governance page, the notification bell, the Domains page, the explorer.
  { path: "/governance/retention", name: "Retention Policies", heading: "Retention Policies", level: 1, from: "link", smoke: false },
  { path: "/notifications", name: "Notification History", heading: "Notification History", level: 1, from: "link", smoke: false },
  { path: "/schemas/type-mappings", name: "Type Mapping Reference", heading: "Type Mapping Reference", level: 1, from: "link", smoke: false },
  { path: "/schemas/enterprise", name: "Enterprise", heading: "Enterprise", level: 1, from: "link", smoke: false },
];

/** The ActivityBar items, in order. */
export const ACTIVITY_BAR_ROUTES: readonly DashboardRoute[] = DASHBOARD_ROUTES.filter((route) => route.from === "activity-bar");

/** The admin tabs in the order of the tab bar (Settings, Users, Domains, Emitters, Health, Classifications). */
const ADMIN_TAB_ORDER = ["admin-tab-settings", "admin-tab-users", "admin-tab-domains", "admin-tab-emitters", "admin-tab-health", "admin-tab-classifications"];
export const ADMIN_TAB_ROUTES: readonly DashboardRoute[] = DASHBOARD_ROUTES.filter((route) => route.adminTab !== undefined).sort(
  (a, b) => ADMIN_TAB_ORDER.indexOf(a.adminTab!.testId) - ADMIN_TAB_ORDER.indexOf(b.adminTab!.testId),
);

/** The unauthenticated health endpoint of the monitoring tools (not a page). */
export const HEALTH_API_PATH = "/api/v1/health";
