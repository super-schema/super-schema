// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowSettingsSchema } from "@/lib/deployments/contracts";

const h = vi.hoisted(() => ({ load: vi.fn(), preview: vi.fn(), execute: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/deployment-actions", () => ({
  getDeploymentWorkspaceAction: h.load, previewDeploymentAction: h.preview, executeDeploymentAction: h.execute,
  saveDeploymentConnectionAction: vi.fn(), saveDeploymentWorkflowAction: vi.fn(), verifyDeploymentConnectionAction: vi.fn(), refreshDeploymentReceiptAction: vi.fn(), importLegacyGitConnectionAction: vi.fn(),
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/EntityDeploymentsTab", () => ({ EntityDeploymentsTab: () => <p>Legacy environment records</p> }));
vi.mock("@/components/custom/SchemaWorkbench/DetailPanel", () => ({ DetailPanel: ({ value }: { value: string }) => <pre>{value}</pre> }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
import { DeploymentWorkflowsTab } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/DeploymentWorkflowsTab";

const workspace = () => ({
  targetMethods: { avro: ["git", "http", "registry"] }, environments: ["staging", "production", "qa"], productWorkflowsHref: "/schemas/identity/accounts?tab=workflows", recorded: [{ target: "avro", environment: "staging", version: 1, sourceVersion: 2 }],
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
    await waitFor(() => expect(screen.getByTestId("deployment-preview")).toHaveTextContent("old published bytes"));
    expect(h.execute).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("deployment-execute"));
    await waitFor(() => expect(h.execute).toHaveBeenCalledWith("account", { runId: "run", planHash: "hash" }));
  });
  it("clears a reviewed preview when a deployment variable changes without requiring a definition save", async () => {
    render(<DeploymentWorkflowsTab entityId="account" entityName="Account" initialVersion="1" />);
    await selectWorkflow();
    fireEvent.click(screen.getByRole("button", { name: "Validate and preview" }));
    await screen.findByTestId("deployment-preview");
    await waitFor(() => expect(screen.getByRole("button", { name: "Validate and preview" })).toBeEnabled());
    fireEvent.click(screen.getByLabelText("Environment"));
    const option = await screen.findByRole("option", { name: "production" });
    fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 }); fireEvent.click(option);
    await waitFor(() => expect(screen.queryByTestId("deployment-preview")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Validate and preview" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Save workflow" })).not.toBeInTheDocument();
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
    expect(screen.getByRole("combobox", { name: "Schema registry" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Git repository")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Token")).not.toBeInTheDocument();
    expect(h.preview).not.toHaveBeenCalled(); expect(h.execute).not.toHaveBeenCalled();
  });
});


it("links new workflow to the product and keeps credentials and definition editing out of deployment", async () => {
  render(<DeploymentWorkflowsTab entityId="account" entityName="Account" />);
  await selectWorkflow();
  expect(screen.getByRole("link", { name: "New workflow" })).toHaveAttribute("href", "/schemas/identity/accounts?tab=workflows");
  expect(screen.getByRole("link", { name: "Deployment settings" })).toHaveAttribute("href", "/admin/settings/deployments");
  expect(screen.queryByRole("heading", { name: "Deployments" })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Workflow name")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Token")).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("Environment"));
  expect(await screen.findByRole("option", { name: "qa" })).toBeInTheDocument();
});
it("shows a version matrix and scopes delivery history and workflow controls to each method", async () => {
  const data = workspace();
  data.runs = ["git", "http", "registry"].map((method) => ({ id: method, workflowId: "workflow", method, format: "avro", artifactVersion: 1, environment: "staging", status: "SUCCEEDED", receipt: null, createdAt: "2026-11-10T00:00:00Z", attemptCount: 1, planHash: "hash", error: null, expiresAt: "2026-11-10T01:00:00Z" })) as never[];
  h.load.mockResolvedValue({ success: true, data });
  render(<DeploymentWorkflowsTab entityId="account" entityName="Account" />);
  const matrix = await screen.findByTestId("target-version-matrix");
  expect(matrix).toHaveTextContent("Latest published"); expect(matrix).toHaveTextContent("Source v2");
  expect(screen.getAllByTestId("deployment-run")).toHaveLength(1);
  expect(screen.getByTestId("deployment-run")).toHaveTextContent("Git PR");
  fireEvent.click(screen.getByRole("tab", { name: "API endpoint" }));
  expect(screen.getAllByTestId("deployment-run")).toHaveLength(1);
  expect(screen.getByTestId("deployment-run")).toHaveTextContent("API endpoint");
  expect(within(screen.getByTestId("deployment-method-http")).queryByLabelText("Destination contract version")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Schema registry" }));
  expect(screen.getByTestId("deployment-run")).toHaveTextContent("Schema registry");
});

it("changes the available deployment methods when the selected target changes", async () => {
  const data = { ...workspace(), targetMethods: {}, formats: [{ key: "avro", versions: [3, 1] }, { key: "bigquery", versions: [2] }] };
  h.load.mockResolvedValue({ success: true, data });
  render(<DeploymentWorkflowsTab entityId="account" entityName="Account" />);
  await screen.findByTestId("target-version-matrix");
  expect(screen.getByRole("tab", { name: "Git PR" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Schema registry" })).toBeInTheDocument();
  expect(screen.queryByRole("tab", { name: "API endpoint" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Schema registry" }));
  fireEvent.click(screen.getByRole("combobox", { name: "Target datastore or format" }));
  const item = await screen.findByRole("option", { name: "BigQuery DDL" });
  fireEvent.pointerDown(item, { pointerType: "mouse", button: 0 }); fireEvent.click(item);
  await waitFor(() => expect(screen.queryByRole("tab", { name: "Schema registry" })).not.toBeInTheDocument());
  expect(screen.getByRole("tab", { name: "API endpoint" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Git PR" })).toHaveAttribute("aria-selected", "true");
});

it("inherits the Git repository and submits the generated title with the exact target", async () => {
  render(<DeploymentWorkflowsTab entityId="account" entityName="Account" initialFormat="avro" initialVersion="1" />);
  await selectWorkflow();
  expect(screen.queryByRole("combobox", { name: "Git repository" })).not.toBeInTheDocument();
  expect(screen.getByTestId("inherited-git-repository")).toHaveTextContent("Contracts");
  expect(screen.getByLabelText("PR title")).toHaveValue("Publish account: avro v1 → staging (1.0.0_snapshot)");
  fireEvent.click(screen.getByRole("button", { name: "Validate and preview" }));
  await waitFor(() => expect(h.preview).toHaveBeenCalled());
  expect(h.preview.mock.calls[0][1]).toMatchObject({ format: "avro", variables: { title: "Publish account: avro v1 → staging (1.0.0_snapshot)" } });
  expect(h.preview.mock.calls[0][1]).not.toHaveProperty("connectionId");
});
it("preserves manual PR titles while variables change and can restore the generated title", async () => {
  render(<DeploymentWorkflowsTab entityId="account" entityName="Account" initialFormat="avro" initialVersion="1" />);
  await selectWorkflow();
  fireEvent.change(screen.getByLabelText("PR title"), { target: { value: "Review account activation" } });
  fireEvent.change(screen.getByLabelText("Destination contract version"), { target: { value: "2.0.0_snapshot" } });
  expect(screen.getByLabelText("PR title")).toHaveValue("Review account activation");
  fireEvent.click(screen.getByRole("button", { name: "Reset to generated" }));
  expect(screen.getByLabelText("PR title")).toHaveValue("Publish account: avro v1 → staging (2.0.0_snapshot)");
});
