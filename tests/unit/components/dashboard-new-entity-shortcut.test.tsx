/**
 * "New Entity" (Cmd+N and the palette action) is tenant-aware: it targets the
 * placement implied by the current /schemas path, via assetHref.
 *
 * @vitest-environment jsdom
 */
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ pathname: "/schemas", push: vi.fn() }));
const palette = vi.hoisted(() => ({
  actions: [] as Array<{ id: string; onSelect: () => void }>,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: nav.push }),
}));
vi.mock("next-auth/react", () => ({ SessionProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/components/custom/CommandPalette/CommandPalette", () => ({
  CommandPalette: ({ isOpen, actions }: { isOpen: boolean; actions: Array<{ id: string; onSelect: () => void }> }) => {
    palette.actions = actions;
    return isOpen ? <div data-testid="palette-open" /> : null;
  },
}));
vi.mock("@/components/layout/ActivityBar", () => ({ ActivityBar: () => null }));
vi.mock("@/components/layout/LeftSidebar", () => ({ LeftSidebar: () => null }));
vi.mock("@/components/layout/RightPanel", () => ({ RightPanel: () => null }));
vi.mock("@/components/layout/StatusBar", () => ({ StatusBar: () => null }));
vi.mock("@/components/layout/TopBar", () => ({ TopBar: () => null }));

import { DashboardClientShell } from "@/components/layout/DashboardClientShell";

const CASES: Array<{ name: string; pathname: string; target: string | null }> = [
  { name: "a product page", pathname: "/schemas/payments/checkout", target: "/schemas/payments/checkout/new" },
  { name: "a product entity", pathname: "/schemas/payments/checkout/order", target: "/schemas/payments/checkout/new" },
  { name: "a tenant-level entity", pathname: "/schemas/enterprise/entities/customer", target: "/schemas/enterprise/new" },
  { name: "a tenant-level field", pathname: "/schemas/enterprise/entities/customer/fields/email", target: "/schemas/enterprise/new" },
  { name: "the Enterprise root", pathname: "/schemas/enterprise", target: "/schemas/enterprise/new" },
  { name: "the Enterprise new-entity page", pathname: "/schemas/enterprise/new", target: null },
  { name: "the product new-entity page", pathname: "/schemas/payments/checkout/new", target: null },
];

describe("DashboardClientShell new-entity shortcut", () => {
  beforeEach(() => {
    nav.push.mockReset();
    // This jsdom environment ships no localStorage (the resizable panels read it).
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
        clear: () => store.clear(),
      },
    });
    // jsdom lacks matchMedia, which the responsive-layout hook reads.
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      onchange: null,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => cleanup());

  function renderAt(pathname: string) {
    nav.pathname = pathname;
    render(<DashboardClientShell>content</DashboardClientShell>);
  }

  describe.each(CASES)("on $name ($pathname)", ({ pathname, target }) => {
    it("Cmd+N goes to the right new-entity page", () => {
      renderAt(pathname);
      fireEvent.keyDown(document, { key: "n", metaKey: true });

      if (target) expect(nav.push).toHaveBeenCalledWith(target);
      else expect(nav.push).not.toHaveBeenCalled();
      expect(screen.queryByTestId("palette-open")).toBeNull();
    });

    it("the palette 'New Entity' action does the same", () => {
      renderAt(pathname);
      palette.actions.find((a) => a.id === "new-entity")!.onSelect();

      if (target) expect(nav.push).toHaveBeenCalledWith(target);
      else expect(nav.push).not.toHaveBeenCalled();
    });
  });

  it.each(["/schemas", "/schemas/payments"])("opens the palette to pick a target on %s", (pathname) => {
    renderAt(pathname);
    fireEvent.keyDown(document, { key: "n", metaKey: true });

    expect(nav.push).not.toHaveBeenCalled();
    expect(screen.getByTestId("palette-open")).toBeTruthy();
  });
});
