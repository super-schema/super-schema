// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ product: vi.fn(), tenant: vi.fn(), saveWorkflow: vi.fn(), saveEnvironments: vi.fn(), saveConnection: vi.fn(), verify: vi.fn(), saveMethods: vi.fn() }));
vi.mock("@/app/(dashboard)/deployments/settings-actions", () => ({
  saveDeploymentTargetMethodsAction: h.saveMethods, getProductDeploymentConfigurationAction: h.product, getTenantDeploymentConfigurationAction: h.tenant,
  saveProductDeploymentWorkflowAction: h.saveWorkflow, saveDeploymentEnvironmentsAction: h.saveEnvironments,
  saveTenantDeploymentConnectionAction: h.saveConnection, verifyTenantDeploymentConnectionAction: h.verify, importTenantLegacyGitConnectionAction: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
import { ProductDeploymentWorkflows } from "@/components/custom/deployments/ProductDeploymentWorkflows";
import { WorkflowSettingsSchema } from "@/lib/deployments/contracts";
import { targetLabel } from "@/components/custom/deployments/DeploymentFields";
import { TenantDeploymentSettings } from "@/components/custom/deployments/TenantDeploymentSettings";
const config = { targetMethods: {}, environments: ["staging", "qa"], connections: [{ id: "registry", method: "registry", name: "Shared registry", active: true, revision: 1, config: { url: "https://registry.example", baseBranch: "main", supportsIdempotency: false } }] };
beforeEach(() => {
  vi.clearAllMocks(); h.product.mockResolvedValue({ success: true, data: { ...config, workflows: [], canManage: true } });
  h.tenant.mockResolvedValue({ success: true, data: config }); h.saveWorkflow.mockResolvedValue({ success: true, data: { id: "workflow" } });
  h.saveEnvironments.mockResolvedValue({ success: true, data: { environments: ["staging", "qa", "canary"] } });
  h.saveConnection.mockResolvedValue({ success: true, data: { ...config.connections[0], id: "new-registry" } });
});
afterEach(() => { cleanup(); try { localStorage.clear(); } catch { /* no storage */ } });
async function choose(label: string, option: string) { fireEvent.click(screen.getByRole("combobox", { name: label })); const item = await screen.findByRole("option", { name: option }); fireEvent.pointerDown(item, { pointerType: "mouse", button: 0 }); fireEvent.click(item); }
it("creates a reusable product registry workflow from a tenant connection", async () => {
  render(<ProductDeploymentWorkflows productId="accounts" />);
  await waitFor(() => expect(screen.getByRole("button", { name: "New workflow" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
  fireEvent.click(await screen.findByRole("tab", { name: "Schema registry" }));
  fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "Publish registry" } });
  fireEvent.click(screen.getByRole("checkbox", { name: targetLabel("avro") }));
  fireEvent.click(screen.getByRole("checkbox", { name: targetLabel("json-schema") }));
  await choose("Default schema registry", "Shared registry");
  fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));
  await waitFor(() => expect(h.saveWorkflow).toHaveBeenCalledWith("accounts", expect.objectContaining({ name: "Publish registry", supportedTargets: ["avro", "json-schema"], connectionId: "registry", environment: "staging" })));
  expect(screen.queryByLabelText("Token")).not.toBeInTheDocument();
});
it("New workflow resets a partially entered definition", async () => {
  render(<ProductDeploymentWorkflows productId="accounts" />);
  await waitFor(() => expect(screen.getByRole("button", { name: "New workflow" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
  const name = await screen.findByLabelText("Workflow name");
  fireEvent.change(name, { target: { value: "Unfinished" } });
  fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
  expect(screen.getByLabelText("Workflow name")).toHaveValue("");
});
it("edits environments as an ordered pipeline with descriptions and branches, and retains validation errors", async () => {
  render(<TenantDeploymentSettings />);
  expect(await screen.findByLabelText("Environment 1 name")).toHaveValue("staging");
  expect(screen.getByLabelText("Environment 2 name")).toHaveValue("qa");
  fireEvent.click(screen.getByRole("button", { name: "Move qa earlier" }));
  expect(screen.getByLabelText("Environment 1 name")).toHaveValue("qa");
  fireEvent.click(screen.getByRole("button", { name: "Add environment" }));
  fireEvent.change(screen.getByLabelText("Environment 3 name"), { target: { value: "canary" } });
  fireEvent.change(screen.getByLabelText("canary description"), { target: { value: "Final rollout" } });
  fireEvent.change(screen.getByLabelText("staging Git branch"), { target: { value: "release/staging" } });
  expect(within(screen.getByRole("list", { name: "Promotion order" })).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["qa", "staging", "canary"]);
  h.saveEnvironments.mockResolvedValueOnce({ error: "Environment names must be unique" });
  fireEvent.click(screen.getByRole("button", { name: "Save environments" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Environment names must be unique");
  expect(h.saveEnvironments).toHaveBeenCalledWith({ environments: [{ name: "qa", description: "" }, { name: "staging", description: "", branch: "release/staging" }, { name: "canary", description: "Final rollout" }], renames: {}, reassign: {} });
  expect(screen.getByLabelText("Environment 3 name")).toHaveValue("canary");
});
it("shows which workflows follow a rename and where a removed environment's workflows go, defaulting to the neighbouring stage", async () => {
  h.tenant.mockResolvedValue({ success: true, data: { ...config, environments: ["development", "qa", "staging"], environmentUsage: { qa: [{ id: "w1", name: "QA PR", scope: "Product Accounts", href: "/schemas/identity/accounts?tab=workflows" }], staging: [{ id: "w2", name: "Staging PR", scope: "Product Accounts", href: null }] } } });
  render(<TenantDeploymentSettings />);
  fireEvent.change(await screen.findByLabelText("Environment 3 name"), { target: { value: "pre-prod" } });
  fireEvent.click(screen.getByRole("button", { name: "Remove qa" }));
  const changes = screen.getByTestId("environment-workflow-changes");
  expect(changes).toHaveTextContent("1 workflow follows the rename staging → pre-prod");
  expect(within(changes).getByRole("link", { name: "QA PR" })).toHaveAttribute("href", "/schemas/identity/accounts?tab=workflows");
  expect(screen.getByLabelText("Workflows of qa")).toHaveValue("development");
  fireEvent.click(screen.getByRole("button", { name: "Save environments" }));
  await waitFor(() => expect(h.saveEnvironments).toHaveBeenCalledWith({ environments: [{ name: "development", description: "" }, { name: "pre-prod", description: "" }], renames: { staging: "pre-prod" }, reassign: { qa: "development" } }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
it("lets the admin disable a removed environment's workflows instead of moving them", async () => {
  h.tenant.mockResolvedValue({ success: true, data: { ...config, environmentUsage: { qa: [{ id: "w1", name: "QA PR", scope: "Product Accounts", href: null }] } } });
  render(<TenantDeploymentSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "Remove qa" }));
  fireEvent.change(screen.getByLabelText("Workflows of qa"), { target: { value: "__disable" } });
  fireEvent.click(screen.getByRole("button", { name: "Save environments" }));
  await waitFor(() => expect(h.saveEnvironments).toHaveBeenCalledWith(expect.objectContaining({ reassign: { qa: null } })));
});
it("keeps unsaved environment edits when the admin leaves and comes back, until they are discarded", async () => {
  localStorage.clear();
  const first = render(<TenantDeploymentSettings />);
  fireEvent.change(await screen.findByLabelText("Environment 2 name"), { target: { value: "quality" } });
  first.unmount();
  render(<TenantDeploymentSettings />);
  expect(await screen.findByLabelText("Environment 2 name")).toHaveValue("quality");
  expect(screen.getByRole("status")).toHaveTextContent("unsaved environment changes were restored");
  fireEvent.click(screen.getAllByRole("button", { name: "Discard changes" })[0]);
  expect(screen.getByLabelText("Environment 2 name")).toHaveValue("qa");
  expect(localStorage.getItem("superschema.deploymentEnvironments.draft")).toBeNull();
});
it("blocks saving duplicate or unnamed environments", async () => {
  render(<TenantDeploymentSettings />);
  fireEvent.change(await screen.findByLabelText("Environment 2 name"), { target: { value: "Staging" } });
  expect(screen.getByText("Environment names must be unique.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save environments" })).toBeDisabled();
});
it("configures registry credentials centrally and clears the secret after saving", async () => {
  render(<TenantDeploymentSettings />);
  fireEvent.click(await screen.findByRole("tab", { name: "Schema registry" }));
  fireEvent.change(screen.getByLabelText("Connection name"), { target: { value: "New registry" } });
  fireEvent.change(screen.getByLabelText("Schema registry URL"), { target: { value: "https://new-registry.example" } });
  await choose("Authentication", "Bearer token");
  fireEvent.change(screen.getByLabelText("Token"), { target: { value: "entered-secret" } });
  fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
  await waitFor(() => expect(h.saveConnection).toHaveBeenCalledWith(expect.objectContaining({ method: "registry", credentials: expect.objectContaining({ authType: "bearer", token: "entered-secret" }) })));
  await waitFor(() => expect(screen.queryByLabelText("Token")).not.toBeInTheDocument());
  expect(screen.queryByDisplayValue("entered-secret")).not.toBeInTheDocument();
});

it("configures target methods in tenant settings with registry restricted to supported schema targets", async () => {
  h.saveMethods.mockResolvedValue({ success: true, data: { targetMethods: { avro: ["git", "registry", "http"] } } });
  render(<TenantDeploymentSettings />);
  expect(await screen.findByLabelText("Avro Schema: Schema registry")).toBeChecked();
  expect(screen.getByLabelText("Avro Schema: API endpoint")).not.toBeChecked();
  expect(screen.getByLabelText("BigQuery DDL: Schema registry")).toBeDisabled();
  expect(screen.getByLabelText("BigQuery DDL: API endpoint")).toBeChecked();
  fireEvent.click(screen.getByLabelText("Avro Schema: API endpoint"));
  fireEvent.click(screen.getByRole("button", { name: "Save target methods" }));
  await waitFor(() => expect(h.saveMethods).toHaveBeenCalledWith({ avro: ["git", "registry", "http"] }));
});

it("lists existing workflows and opens their saved values for editing", async () => {
  h.product.mockResolvedValue({ success: true, data: { ...config, canManage: true, workflows: [{ id: "saved", name: "Reusable registry", connectionId: "registry", format: "avro", supportedTargets: ["avro", "json-schema"], environment: "qa", active: true, revision: 1, settings: WorkflowSettingsSchema.parse({ subject: "account-value" }) }] } });
  render(<ProductDeploymentWorkflows productId="accounts" />);
  expect(await screen.findByTestId("product-workflow-row")).toHaveTextContent("Reusable registry");
  expect(screen.getByTestId("product-workflow-row")).toHaveTextContent("Shared registry");
  expect(screen.queryByLabelText("Workflow name")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Edit Reusable registry" }));
  expect(screen.getByLabelText("Workflow name")).toHaveValue("Reusable registry");
  expect(screen.getByLabelText("Registry subject")).toHaveValue("account-value");
  expect(screen.getByRole("checkbox", { name: targetLabel("avro") })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: targetLabel("json-schema") })).toBeChecked();
  fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "Updated registry" } });
  fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));
  await waitFor(() => expect(h.saveWorkflow).toHaveBeenCalledWith("accounts", expect.objectContaining({ id: "saved", name: "Updated registry", supportedTargets: ["avro", "json-schema"] })));
});
