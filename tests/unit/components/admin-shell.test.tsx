// @vitest-environment jsdom
/**
 * The Admin area's shell: only the tabs the capabilities allow are drawn, and a page whose tab the person may not use is replaced by the no-permission screen
 * (the page is not rendered at all). The matrix of who they are: a platform administrator, a tenant administrator, a domain-scoped administrator, an AUTHOR,
 * a person with no role. The capabilities come from the real `adminCapabilities`; nothing in the shell reads a role name.
 */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { adminCapabilities } from "@/lib/access/capabilities";
import { assign } from "../../helpers/access-mocks";
import type { Assignment } from "@/lib/access";

const nav = vi.hoisted(() => ({ pathname: "/admin", push: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname, useRouter: () => ({ push: nav.push }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: { href: string; children: ReactNode }) => <a href={href} {...props}>{children}</a> }));

import { AdminShell, allowedTabs, tabOfPath } from "@/components/custom/admin/AdminShell";

const T = "tenant-1";
const PERSONAS: Array<[string, Assignment[], string[]]> = [
  ["a platform administrator", [assign.global()], ["settings", "users", "domains", "emitters", "health", "classifications", "ai"]],
  ["a tenant administrator of the tenant in view", [assign.tenant("ADMIN", T)], ["settings", "users", "domains"]],
  ["a domain-scoped administrator", [assign.domain("ADMIN", T, "dom-a")], ["settings"]],
  ["an AUTHOR", [assign.tenant("AUTHOR", T)], ["settings"]],
  ["a person with no role", [], ["settings"]],
];

const renderShell = (assignments: Assignment[], path: string) => {
  nav.pathname = path;
  return render(
    <AdminShell capabilities={adminCapabilities(assignments, T)}>
      <div data-testid="page">the page</div>
    </AdminShell>
  );
};
const tabIds = () => screen.getAllByRole("tab").map((tab) => tab.getAttribute("data-testid")?.replace("admin-tab-", ""));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("the tabs are the ones the person may use", () => {
  it.each(PERSONAS)("%s", (_who, assignments, expected) => {
    renderShell(assignments, "/admin/settings");
    expect(tabIds()).toEqual(expected);
    expect(screen.getByTestId("page")).toBeTruthy();
  });

  it("the platform-only tabs (emitters, health, classifications) are absent, not disabled, for a tenant administrator", () => {
    renderShell([assign.tenant("ADMIN", T)], "/admin");
    for (const id of ["emitters", "health", "classifications", "ai"]) expect(screen.queryByTestId(`admin-tab-${id}`)).toBeNull();
  });

  it("marks the tab of the page the person is on, and routes a click to the tab's address", () => {
    renderShell([assign.global()], "/admin/emitters");
    expect(screen.getByTestId("admin-tab-emitters").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("admin-tab-users").getAttribute("aria-selected")).toBe("false");
    fireEvent.click(screen.getByTestId("admin-tab-health"));
    expect(nav.push).toHaveBeenCalledWith("/admin/health");
  });
});

describe("a page the person may not use is the no-permission screen", () => {
  it.each(PERSONAS.filter(([, , tabs]) => !tabs.includes("users")))("%s on /admin: the screen, not an empty shell, and the page is not rendered", (_who, assignments) => {
    renderShell(assignments, "/admin");
    expect(screen.getByTestId("admin-no-permission")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "You do not have permission to use this page" })).toBeTruthy();
    expect(screen.queryByTestId("page")).toBeNull();
    // no tab is selected (the Users tab is not theirs), and the way back to their settings is offered
    expect(screen.getAllByRole("tab").every((tab) => tab.getAttribute("aria-selected") === "false")).toBe(true);
    expect(screen.getByRole("link", { name: "Go to your settings" }).getAttribute("href")).toBe("/admin/settings");
  });

  it("a tenant administrator is turned away from a platform tab typed into the address bar", () => {
    for (const path of ["/admin/emitters", "/admin/health", "/admin/classifications"]) {
      renderShell([assign.tenant("ADMIN", T)], path);
      expect(screen.getByTestId("admin-no-permission"), path).toBeTruthy();
      expect(screen.queryByTestId("page"), path).toBeNull();
      cleanup();
    }
  });

  it("every person may use their own settings", () => {
    for (const [, assignments] of PERSONAS) {
      renderShell(assignments, "/admin/settings");
      expect(screen.getByTestId("page")).toBeTruthy();
      expect(screen.queryByTestId("admin-no-permission")).toBeNull();
      cleanup();
    }
  });
});

describe("tab bookkeeping", () => {
  it("knows which tab a path belongs to (an unknown path under /admin is the Users tab, as before)", () => {
    expect(tabOfPath("/admin")).toBe("users");
    expect(tabOfPath("/admin/health")).toBe("health");
    expect(tabOfPath("/admin/domains/anything")).toBe("domains");
    expect(tabOfPath("/admin/nope")).toBe("users");
  });

  it("allowedTabs follows the capabilities and keeps the order of the tab bar", () => {
    expect(allowedTabs(adminCapabilities([assign.global()], T)).map((tab) => tab.id)).toEqual(["settings", "users", "domains", "emitters", "health", "classifications", "ai"]);
    expect(allowedTabs(adminCapabilities([], T)).map((tab) => tab.id)).toEqual(["settings"]);
  });
});
