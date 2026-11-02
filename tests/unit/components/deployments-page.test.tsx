/**
 * @vitest-environment jsdom
 */
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The deployments page: a rejected overview call must leave the loading state and say so; the overview is paged (25 rows a page) and the
// filters are mounted and reach the action.

const h = vi.hoisted(() => ({
  getDeploymentOverviewAction: vi.fn(),
}));

vi.mock("@/app/(dashboard)/deployments/actions", () => ({
  getDeploymentOverviewAction: h.getDeploymentOverviewAction,
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

import DeploymentsPage from "@/app/(dashboard)/deployments/page";

const row = (n: number) => ({
  entityId: `e${n}`,
  entityName: `Entity ${n}`,
  entitySlug: `entity-${n}`,
  domain: "Payments",
  domainSlug: "payments",
  productSlug: null,
  currentVersion: "v1",
  targets: [],
});

/** A page of the overview as the action answers it: `count` rows of `total` entities. */
const page = (count: number, total: number) => ({
  success: true as const,
  data: {
    rows: Array.from({ length: count }, (_, i) => row(i)),
    targetFormats: ["BigQuery"],
    domains: ["Payments", "Shipping"],
    total,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("DeploymentsPage loading", () => {
  it("a rejected overview call leaves the loading state, enables refresh and shows the error", async () => {
    h.getDeploymentOverviewAction.mockRejectedValueOnce(new Error("Failed to fetch"));
    render(<DeploymentsPage />);

    expect((await screen.findByRole("alert")).textContent).toContain("Could not load deployments");
    expect(screen.queryByText(/Loading deployments/)).toBeNull();
    expect((screen.getByRole("button", { name: /Refresh/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("DeploymentsPage paging and filters", () => {
  it("shows one page of 25 rows out of the total, and moves to the next page through the action", async () => {
    h.getDeploymentOverviewAction.mockResolvedValue(page(25, 30));
    render(<DeploymentsPage />);

    expect(await screen.findByText("Showing 1–25 of 30")).toBeTruthy();
    expect(h.getDeploymentOverviewAction).toHaveBeenLastCalledWith({ offset: 0, limit: 25, filters: {} });
    expect((screen.getByRole("button", { name: "Previous page" }) as HTMLButtonElement).disabled).toBe(true);

    h.getDeploymentOverviewAction.mockResolvedValue(page(5, 30));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));

    expect(await screen.findByText("Showing 26–30 of 30")).toBeTruthy();
    expect(h.getDeploymentOverviewAction).toHaveBeenLastCalledWith({ offset: 25, limit: 25, filters: {} });
    expect((screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(true);
  }, 15_000);

  it("mounts the filters, and a filter change goes back to the first page with that filter", async () => {
    h.getDeploymentOverviewAction.mockResolvedValue(page(25, 30));
    const { container } = render(<DeploymentsPage />);
    await screen.findByText("Showing 1–25 of 30");

    h.getDeploymentOverviewAction.mockResolvedValue(page(3, 3));
    const status = container.querySelector("#deployment-filter-status") as HTMLSelectElement;
    expect(status).not.toBeNull();
    fireEvent.change(status, { target: { value: "drifted" } });

    expect(await screen.findByText("Showing 1–3 of 3")).toBeTruthy();
    expect(h.getDeploymentOverviewAction).toHaveBeenLastCalledWith({ offset: 0, limit: 25, filters: { driftStatus: "drifted" } });
  });
});

/** A promise the test settles by hand, for a load that is still in flight when the reader moves on. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("DeploymentsPage moving between answers", () => {
  it("an answer to a load that a newer load has overtaken is ignored", async () => {
    const stale = deferred<unknown>();
    h.getDeploymentOverviewAction.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(page(3, 3));
    const { container } = render(<DeploymentsPage />);

    fireEvent.change(container.querySelector("#deployment-filter-status") as HTMLSelectElement, { target: { value: "drifted" } });
    expect(await screen.findByText("Showing 1–3 of 3")).toBeTruthy();

    await act(async () => {
      stale.resolve(page(25, 30));
    });
    expect(screen.queryByText("Showing 1–25 of 30")).toBeNull();
    expect(screen.getByText("Showing 1–3 of 3")).toBeTruthy();
  }, 15_000);

  it("a page past the last one (its entities were removed meanwhile) is answered by the last page", async () => {
    h.getDeploymentOverviewAction
      .mockResolvedValueOnce(page(25, 30))
      .mockResolvedValueOnce({ success: true, data: { rows: [], targetFormats: ["BigQuery"], domains: ["Payments"], total: 20 } })
      .mockResolvedValueOnce(page(20, 20));
    render(<DeploymentsPage />);
    await screen.findByText("Showing 1–25 of 30");

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));

    expect(await screen.findByText("Showing 1–20 of 20")).toBeTruthy();
    expect(h.getDeploymentOverviewAction).toHaveBeenLastCalledWith({ offset: 0, limit: 25, filters: {} });
  }, 15_000);

  it("a failed load shows its error instead of the rows and the pager of the answer before it", async () => {
    h.getDeploymentOverviewAction.mockResolvedValueOnce(page(25, 30));
    const { container } = render(<DeploymentsPage />);
    await screen.findByText("Showing 1–25 of 30");

    h.getDeploymentOverviewAction.mockResolvedValueOnce({ error: "Not authenticated" });
    fireEvent.change(container.querySelector("#deployment-filter-status") as HTMLSelectElement, { target: { value: "drifted" } });

    expect((await screen.findByRole("alert")).textContent).toContain("Not authenticated");
    expect(screen.queryByText(/Showing \d/)).toBeNull();
    expect(screen.queryByTestId("deployment-overview-table")).toBeNull();
  }, 15_000);
});

describe("DeploymentsPage answers", () => {
  it("an answer that is not a page shows the action's error", async () => {
    h.getDeploymentOverviewAction.mockResolvedValueOnce({ error: "Not authenticated" });
    render(<DeploymentsPage />);

    expect((await screen.findByRole("alert")).textContent).toContain("Not authenticated");
    await waitFor(() => expect(screen.queryByText(/Loading deployments/)).toBeNull());
  });
});
