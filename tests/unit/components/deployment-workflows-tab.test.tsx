// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowSettingsSchema } from "@/lib/deployments/contracts";

const h = vi.hoisted(() => ({ load: vi.fn(), preview: vi.fn(), execute: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/deployment-actions", () => ({
  getDeploymentWorkspaceAction: h.load, previewDeploymentAction: h.preview, executeDeploymentAction: h.execute,
  saveDeploymentConnectionAction: vi.fn(), saveDeploymentWorkflowAction: vi.fn(), verifyDeploymentConnectionAction: vi.fn(), refreshDeploymentReceiptAction: vi.fn(), importLegacyGitConnectionAction: vi.fn(),
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/EntityDeploymentsTab", () => ({ EntityDeploymentsTab: () => <p>Legacy environment records</p> }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
import { DeploymentWorkflowsTab } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/DeploymentWorkflowsTab";

const workspace = () => ({
  connections: [{ id: "connection", name: "Contracts", method: "git", config: { url: "https://github.com/acme/contracts", baseBranch: "main" }, active: true, revision: 1 }],
  workflows: [{ id: "workflow", name: "Staging PR", connectionId: "connection", format: "avro", environment: "staging", settings: WorkflowSettingsSchema.parse({}), active: true, revision: 1 }],
  runs: [], formats: [{ key: "avro", versions: [3, 1] }], canConfigure: true, canRun: true,
});
beforeEach(() => {
  vi.clearAllMocks(); h.load.mockResolvedValue({ success: true, data: workspace() });
  h.preview.mockResolvedValue({ success: true, data: { run: { id: "run", environment: "staging", method: "git", planHash: "hash" }, plan: { bundle: { format: "avro", version: 1, contentHash: "sha256:exact" }, connectionConfig: { url: "https://github.com/acme/contracts", baseBranch: "main" }, settings: { contractVersion: "1.0.0_snapshot" }, validation: ["Pinned artifact validated"], files: [{ path: "schemas/paypal/identity/accounts/account/1.0.0_snapshot/account.avsc", content: "old published bytes" }] } } });
  h.execute.mockResolvedValue({ success: true, data: { status: "QUEUED" } });
});
afterEach(cleanup);
async function selectWorkflow() {
  fireEvent.click(await screen.findByLabelText("Saved workflow"));
  fireEvent.click(await screen.findByRole("option", { name: "Staging PR" }));
}

describe("deployment workflow review", () => {
  it("shows initialization failures without an endless spinner and can reload after setup", async () => {
    h.load.mockResolvedValueOnce({ error: "Database initialization is required" });
    render(<DeploymentWorkflowsTab entityId="account" entityName="Account" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Database initialization is required");
    expect(screen.queryByText("Loading workflows…")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByLabelText("Saved workflow")).toBeInTheDocument();
  });
  it("keeps an explicitly selected older version, validates it, and only sends after confirmation", async () => {
    render(<DeploymentWorkflowsTab entityId="account" entityName="Account" initialFormat="avro" initialVersion="1" />);
    await selectWorkflow();
    expect(screen.getByLabelText("Published artifact version")).toHaveTextContent("v1");
    fireEvent.click(screen.getByRole("button", { name: "Validate and preview" }));
    await screen.findByTestId("deployment-preview");
    expect(h.preview).toHaveBeenCalledWith("account", expect.objectContaining({ workflowId: "workflow", version: 1 }));
    expect(screen.getByTestId("deployment-preview")).toHaveTextContent("old published bytes");
    expect(h.execute).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("deployment-execute"));
    await waitFor(() => expect(h.execute).toHaveBeenCalledWith("account", { runId: "run", planHash: "hash" }));
  });
  it("requires saving workflow edits and clears a previous preview", async () => {
    render(<DeploymentWorkflowsTab entityId="account" entityName="Account" initialVersion="1" />);
    await selectWorkflow();
    fireEvent.click(screen.getByRole("button", { name: "Validate and preview" }));
    await screen.findByTestId("deployment-preview");
    fireEvent.change(screen.getByLabelText("Environment label"), { target: { value: "production" } });
    expect(screen.queryByTestId("deployment-preview")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Validate and preview" })).toBeDisabled();
  });
  it("resets the reviewed plan when navigation selects another schema version", async () => {
    const { rerender } = render(<DeploymentWorkflowsTab entityId="account" entityName="Account" initialFormat="avro" initialVersion="1" />);
    await selectWorkflow();
    fireEvent.click(screen.getByRole("button", { name: "Validate and preview" }));
    await screen.findByTestId("deployment-preview");
    rerender(<DeploymentWorkflowsTab entityId="account" entityName="Account" initialFormat="avro" initialVersion="3" />);
    await selectWorkflow();
    expect(screen.getByLabelText("Published artifact version")).toHaveTextContent("v3");
    expect(screen.queryByTestId("deployment-preview")).not.toBeInTheDocument();
    expect(h.execute).not.toHaveBeenCalled();
  });
  it("does not replace an unavailable selected version and separates the three deployment methods", async () => {
    render(<DeploymentWorkflowsTab entityId="account" entityName="Account" initialFormat="avro" initialVersion="99" />);
    await selectWorkflow();
    expect(screen.getByText(/unavailable selected version is never replaced silently/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Validate and preview" })).toBeDisabled();
    fireEvent.click(screen.getByRole("tab", { name: "API endpoint" }));
    expect(screen.getByText(/receiving API owns all subsequent processing/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Schema registry" }));
    expect(screen.getByLabelText("Registry subject")).toBeInTheDocument();
    expect(h.preview).not.toHaveBeenCalled(); expect(h.execute).not.toHaveBeenCalled();
  });
});
