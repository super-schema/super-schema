// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
afterEach(cleanup);
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
it("saves the tenant environment enum and retains validation errors", async () => {
  render(<TenantDeploymentSettings />);
  const input = await screen.findByLabelText("Environment names (one per line)");
  expect(input).toHaveValue("staging\nqa");
  fireEvent.change(input, { target: { value: "staging\nqa\ncanary" } });
  h.saveEnvironments.mockResolvedValueOnce({ error: "Environment names must be unique" });
  fireEvent.click(screen.getByRole("button", { name: "Save environments" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Environment names must be unique");
  expect(h.saveEnvironments).toHaveBeenCalledWith(["staging", "qa", "canary"]);
  expect(input).toHaveValue("staging\nqa\ncanary");
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
