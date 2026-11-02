/**
 * @vitest-environment jsdom
 */
/**
 * The Deployments tab answers a rejected action (a network drop, a server action id that went stale after a deploy) the way the TypeSpec tab
 * does: the loading state ends and the error is said, instead of "Loading deployments…" or a drift check left in progress.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { toastMock } = vi.hoisted(() => ({ toastMock: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/components/custom/DeploymentPanel/DeploymentPanel", () => ({
  DeploymentPanel: ({ onCheckDrift, isChecking }: { onCheckDrift: (targetId: string) => void; isChecking: boolean }) => (
    <button onClick={() => onCheckDrift("target-1")}>{isChecking ? "Checking drift" : "Check drift"}</button>
  ),
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions", () => ({
  getEntityDeploymentStatusAction: vi.fn(),
  markEntityDeployedAction: vi.fn(),
  checkTargetDriftAction: vi.fn(),
}));

import { EntityDeploymentsTab } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/EntityDeploymentsTab";

const actions = await import("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions");
const loadStatuses = actions.getEntityDeploymentStatusAction as unknown as ReturnType<typeof vi.fn>;
const checkDrift = actions.checkTargetDriftAction as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  loadStatuses.mockResolvedValue({ success: true, data: [] });
});
afterEach(() => cleanup());

describe("Deployments tab: a rejected action does not leave the tab stuck", () => {
  it("a load that rejects ends the loading state and says why", async () => {
    loadStatuses.mockRejectedValueOnce(new Error("Failed to fetch"));
    render(<EntityDeploymentsTab entityId="ent-1" entityName="Customer" />);

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("Could not load deployments: Failed to fetch"));
    expect(screen.queryByText("Loading deployments…")).toBeNull();
    expect(screen.getByRole("button", { name: "Check drift" })).toBeDefined();
  });

  it("a drift check that rejects says why and is not left in progress", async () => {
    checkDrift.mockRejectedValueOnce(new Error("Failed to fetch"));
    render(<EntityDeploymentsTab entityId="ent-1" entityName="Customer" />);
    await screen.findByRole("button", { name: "Check drift" });

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check drift" })); });

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("Could not check drift: Failed to fetch"));
    expect(screen.getByRole("button", { name: "Check drift" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Checking drift" })).toBeNull();
  });
});
