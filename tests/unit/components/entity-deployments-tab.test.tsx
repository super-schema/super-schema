/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A drift check that rejects (a dropped connection, a server action that no longer exists) must release its own button and say so, and a
// load that rejects must stop the spinner. Neither may leave the other targets' drift checks disabled.

const h = vi.hoisted(() => ({
  getEntityDeploymentStatusAction: vi.fn(),
  markEntityDeployedAction: vi.fn(),
  checkTargetDriftAction: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions", () => ({
  getEntityDeploymentStatusAction: h.getEntityDeploymentStatusAction,
  markEntityDeployedAction: h.markEntityDeployedAction,
  checkTargetDriftAction: h.checkTargetDriftAction,
}));
vi.mock("sonner", () => ({ toast: { error: h.toastError, success: h.toastSuccess } }));

import { EntityDeploymentsTab } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/EntityDeploymentsTab";

const TARGETS = [
  { targetFormat: "BigQuery", targetId: "ent-1:bigquery", emittedVersion: "v2", environments: [] },
  { targetFormat: "Avro", targetId: "ent-1:avro", emittedVersion: "v2", environments: [] },
];

/** A target with one tracked environment (`production`, running v2) and the drift it was given. */
const tracked = (format: string, targetId: string, driftStatus: "in-sync" | "drifted" | "unknown") => ({
  targetFormat: format,
  targetId,
  emittedVersion: "v2",
  environments: [{ name: "production", deployedVersion: "2", status: "DEPLOYED", driftStatus, lastChecked: null, markedDeployedAt: null }],
});

/** A promise the test settles by hand, for checks that are in flight at the same time. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const checkButtons = () => screen.getAllByTestId("deployment-check-drift") as HTMLButtonElement[];

beforeEach(() => {
  vi.clearAllMocks();
  h.getEntityDeploymentStatusAction.mockResolvedValue({ success: true, data: TARGETS });
});

afterEach(() => {
  cleanup();
});

describe("EntityDeploymentsTab drift checks", () => {
  it("a drift check that rejects releases its own button, leaves the other targets enabled, and says it failed", async () => {
    h.checkTargetDriftAction.mockRejectedValueOnce(new Error("Failed to fetch"));
    render(<EntityDeploymentsTab entityId="ent-1" entityName="Order" />);
    await waitFor(() => expect(checkButtons()).toHaveLength(2));

    fireEvent.click(checkButtons()[0]);

    await waitFor(() => expect(h.toastError).toHaveBeenCalledTimes(1));
    expect(checkButtons().map((button) => button.disabled)).toEqual([false, false]);
  });

  it("while a drift check is in flight, only that target's button is disabled", async () => {
    h.checkTargetDriftAction.mockReturnValueOnce(new Promise(() => undefined));
    render(<EntityDeploymentsTab entityId="ent-1" entityName="Order" />);
    await waitFor(() => expect(checkButtons()).toHaveLength(2));

    fireEvent.click(checkButtons()[0]);

    await waitFor(() => expect(checkButtons()[0].disabled).toBe(true));
    expect(checkButtons()[1].disabled).toBe(false);
  });

  it("a drift check that succeeds shows its result and releases the button", async () => {
    h.checkTargetDriftAction.mockResolvedValueOnce({ success: true, data: TARGETS });
    render(<EntityDeploymentsTab entityId="ent-1" entityName="Order" />);
    await waitFor(() => expect(checkButtons()).toHaveLength(2));

    fireEvent.click(checkButtons()[1]);

    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith("Drift check complete"));
    expect(checkButtons().map((button) => button.disabled)).toEqual([false, false]);
  });
});

describe("EntityDeploymentsTab overlapping checks", () => {
  it("while two drift checks are in flight, a rejected one releases only its own button, and the other stays disabled until it answers", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    h.checkTargetDriftAction.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<EntityDeploymentsTab entityId="ent-1" entityName="Order" />);
    await waitFor(() => expect(checkButtons()).toHaveLength(2));

    fireEvent.click(checkButtons()[0]);
    fireEvent.click(checkButtons()[1]);
    await waitFor(() => expect(checkButtons().map((button) => button.disabled)).toEqual([true, true]));

    first.reject(new Error("Failed to fetch"));
    await waitFor(() => expect(h.toastError).toHaveBeenCalledTimes(1));
    expect(checkButtons().map((button) => button.disabled)).toEqual([false, true]);

    second.resolve({ success: true, data: TARGETS });
    await waitFor(() => expect(checkButtons().map((button) => button.disabled)).toEqual([false, false]));
  });

  it("an answer to one check replaces only its own target's status, so an older status of another target does not come back", async () => {
    h.getEntityDeploymentStatusAction.mockResolvedValue({
      success: true,
      data: [tracked("BigQuery", "ent-1:bigquery", "unknown"), tracked("Avro", "ent-1:avro", "unknown")],
    });
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    h.checkTargetDriftAction.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<EntityDeploymentsTab entityId="ent-1" entityName="Order" />);
    await waitFor(() => expect(checkButtons()).toHaveLength(2));

    fireEvent.click(checkButtons()[0]);
    fireEvent.click(checkButtons()[1]);

    // The BigQuery check answers first: its production environment has drifted.
    first.resolve({
      success: true,
      data: [tracked("BigQuery", "ent-1:bigquery", "drifted"), tracked("Avro", "ent-1:avro", "unknown")],
    });
    await waitFor(() => expect(screen.getAllByTestId("drift-badge-drifted")).toHaveLength(1));

    // The Avro check answers later with the BigQuery status it read before the first check wrote: that older status must not replace the newer one.
    second.resolve({
      success: true,
      data: [tracked("BigQuery", "ent-1:bigquery", "unknown"), tracked("Avro", "ent-1:avro", "in-sync")],
    });
    await waitFor(() => expect(screen.getAllByTestId("drift-badge-in-sync")).toHaveLength(1));
    expect(screen.getAllByTestId("drift-badge-drifted")).toHaveLength(1);
    expect(screen.queryAllByTestId("drift-badge-unknown")).toHaveLength(0);
  });
});

describe("EntityDeploymentsTab marking", () => {
  it("a mark-as-deployed that rejects says so, and the drift checks stay usable", async () => {
    h.getEntityDeploymentStatusAction.mockResolvedValue({ success: true, data: TARGETS });
    h.markEntityDeployedAction.mockRejectedValueOnce(new Error("Failed to fetch"));
    render(<EntityDeploymentsTab entityId="ent-1" entityName="Order" />);
    await waitFor(() => expect(checkButtons()).toHaveLength(2));

    fireEvent.click(screen.getAllByTestId("deployment-mark-deployed")[0]);
    fireEvent.click(await screen.findByTestId("confirm-deploy-button"));

    await waitFor(() => expect(h.toastError).toHaveBeenCalledTimes(1));
    expect(checkButtons().map((button) => button.disabled)).toEqual([false, false]);
  });
});

describe("EntityDeploymentsTab version match", () => {
  it("shows the environment on the emitted version as matched, and one on an older version as not matched", async () => {
    h.getEntityDeploymentStatusAction.mockResolvedValue({
      success: true,
      data: [
        {
          targetFormat: "BigQuery",
          targetId: "ent-1:bigquery",
          emittedVersion: "v2",
          environments: [
            { name: "production", deployedVersion: "2", status: "DEPLOYED", driftStatus: "in-sync", lastChecked: null, markedDeployedAt: null },
            { name: "staging", deployedVersion: "1", status: "DEPLOYED", driftStatus: "drifted", lastChecked: null, markedDeployedAt: null },
          ],
        },
      ],
    });
    render(<EntityDeploymentsTab entityId="ent-1" entityName="Order" />);

    expect((await screen.findByTestId("version-badge-2")).className).toContain("text-success");
    expect(screen.getByTestId("version-badge-1").className).toContain("text-warning");
  });
});

describe("EntityDeploymentsTab load", () => {
  it("a load that rejects stops the loading state, enables refresh and says it failed", async () => {
    h.getEntityDeploymentStatusAction.mockRejectedValueOnce(new Error("Failed to fetch"));
    render(<EntityDeploymentsTab entityId="ent-1" entityName="Order" />);

    await waitFor(() => expect(h.toastError).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Loading deployments/)).toBeNull();
    expect((screen.getByTestId("deployments-refresh") as HTMLButtonElement).disabled).toBe(false);
  });
});
