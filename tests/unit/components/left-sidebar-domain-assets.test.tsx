/**
 * LeftSidebar domain asset category tests.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
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

describe("LeftSidebar", () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          id: "domain-1",
          name: "Customer Data",
          slug: "customer-data",
          isSystem: true,
          entities: [{ id: "entity-1", name: "Customer", slug: "customer", status: "ACTIVE" }],
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
    render(
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

    expect(screen.getByText("Entities")).toBeDefined();
    expect(screen.getByText("Types")).toBeDefined();
    expect(screen.getByText("APIs")).toBeDefined();

    fireEvent.click(screen.getByText("Types"));
    expect(pushMock).toHaveBeenCalledWith("/schemas/customer-data?tab=types");
  });
});
