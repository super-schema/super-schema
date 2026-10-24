// @vitest-environment jsdom
// The explorer sits behind a Suspense boundary (it reads the search params). While it loads, the skeleton fallback is in the page, and
// the browser suite reads `left-sidebar` for the loaded explorer: the two used to share that test id, so for a moment two elements
// carried it and every locator on the sidebar tripped Playwright's strict mode. The fallback has an id of its own.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LeftSidebar } from "@/components/layout/LeftSidebar";

/** The search params are not ready until `release()` is called: reading them suspends, as they do on a statically rendered page. */
const params = vi.hoisted(() => {
  let ready = false;
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = () => {
      ready = true;
      resolve();
    };
  });
  return {
    read: () => {
      if (!ready) throw pending;
      return new URLSearchParams();
    },
    release: () => release(),
    reset: () => {
      ready = false;
    },
  };
});

vi.mock("next/navigation", () => ({
  usePathname: () => "/schemas",
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => params.read(),
}));
vi.mock("@/hooks/useDomainsTree", () => ({
  useDomainsTree: () => ({
    data: { enterprise: { counts: { dataTypes: 0, entities: 0, traits: 0 }, entities: [] }, domains: [] },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));

const open = { width: 260, isCollapsed: false, onMouseDown: vi.fn(), onDoubleClick: vi.fn() };
const collapsed = { ...open, isCollapsed: true };

afterEach(() => {
  cleanup();
  params.reset();
});

describe("LeftSidebar: the loading fallback has a test id of its own", () => {
  it("shows left-sidebar-fallback, and no left-sidebar, while the explorer is loading", () => {
    render(<LeftSidebar {...open} />);
    expect(screen.queryAllByTestId("left-sidebar")).toHaveLength(0);
    const fallback = screen.getByTestId("left-sidebar-fallback");
    expect(fallback.getAttribute("data-collapsed")).toBe("false");
  });

  it("keeps data-collapsed on a collapsed fallback", () => {
    render(<LeftSidebar {...collapsed} />);
    expect(screen.queryAllByTestId("left-sidebar")).toHaveLength(0);
    expect(screen.getByTestId("left-sidebar-fallback").getAttribute("data-collapsed")).toBe("true");
  });

  it("swaps it for exactly one left-sidebar once the explorer has loaded: never two elements with the id", async () => {
    render(<LeftSidebar {...open} />);
    expect(screen.getAllByTestId("left-sidebar-fallback")).toHaveLength(1);
    await act(async () => {
      params.release();
    });
    expect(screen.queryAllByTestId("left-sidebar-fallback")).toHaveLength(0);
    expect(screen.getAllByTestId("left-sidebar")).toHaveLength(1);
    expect(screen.getByTestId("left-sidebar").getAttribute("data-collapsed")).toBe("false");
  });
});
