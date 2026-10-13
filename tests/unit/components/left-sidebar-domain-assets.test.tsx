/**
 * LeftSidebar domain asset category tests.
 *
 * @vitest-environment jsdom
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeftSidebar } from "@/components/layout/LeftSidebar";

const { pushMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/schemas/customer-data",
  useRouter: () => ({
    push: pushMock,
  }),
}));

function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  );
}

describe("LeftSidebar", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/schemas/customer-data");
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          id: "domain-1",
          name: "Customer Data",
          slug: "customer-data",
          isSystem: true,
          entities: [
            { id: "entity-1", name: "Customer", slug: "customer", status: "ACTIVE" },
          ],
          modelCount: 11,
          decoratorCount: 2,
          sharedEnumCount: 5,
          customScalarCount: 4,
          unionTypeCount: 1,
          serviceCount: 3,
        },
      ],
    }) as typeof fetch;
  });

  afterEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it("renders all domain asset categories and deep-links into tabs", async () => {
    renderWithQueryClient(
      <LeftSidebar
        width={320}
        isCollapsed={false}
        onMouseDown={vi.fn()}
        onDoubleClick={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Customer Data")).toBeDefined();
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Entities")).toBeDefined();
    expect(screen.getByText("Types")).toBeDefined();
    expect(screen.getByText("APIs")).toBeDefined();

    fireEvent.click(screen.getByText("Types"));
    expect(pushMock).toHaveBeenCalledWith("/schemas/customer-data?tab=types");
  });

  it("marks the domain root and entity category active without relying on substring checks", async () => {
    renderWithQueryClient(
      <LeftSidebar
        width={320}
        isCollapsed={false}
        onMouseDown={vi.fn()}
        onDoubleClick={vi.fn()}
      />
    );

    const domain = await screen.findByText("Customer Data");
    const entities = screen.getByText("Entities");

    expect(domain.closest("[data-active]")?.getAttribute("data-active")).toBe("true");
    expect(entities.closest("[data-active]")?.getAttribute("data-active")).toBe("true");
  });
});
