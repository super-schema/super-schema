// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
const h = vi.hoisted(() => ({ getAiSettingsAction: vi.fn(), updateAiSettingsAction: vi.fn(), testAiConnectionAction: vi.fn() }));
vi.mock("@/app/(dashboard)/admin/actions", () => h);
import { AiSettingsForm } from "@/components/custom/admin/AiSettingsForm";
const view = { stored: { provider: null, baseUrl: null, model: null }, effective: null, apiKeyConfigured: false, envHint: { providerEnv: null, baseUrlEnv: null, modelEnv: null } };
beforeEach(() => {
  vi.clearAllMocks();
  h.getAiSettingsAction.mockResolvedValue({ data: view });
  h.testAiConnectionAction.mockResolvedValue({ data: { reachable: true, detail: "Connected." } });
});
afterEach(cleanup);
async function custom() {
  render(<AiSettingsForm />);
  await screen.findByTestId("ai-settings-provider");
  fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "custom" } });
  fireEvent.change(screen.getByLabelText("Chat completions endpoint"), { target: { value: "https://customer.test/v1/chat/completions" } });
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "customer-model" } });
}
it("tests custom endpoint, model, API key, and headers before saving", async () => {
  await custom();
  fireEvent.change(screen.getByLabelText("API key (optional bearer token)"), { target: { value: "typed-secret" } });
  fireEvent.change(screen.getByLabelText("Additional headers (JSON, optional)"), { target: { value: '{"api-key":"custom-secret"}' } });
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  await waitFor(() => expect(h.testAiConnectionAction).toHaveBeenCalledWith({
    provider: "custom", baseUrl: "https://customer.test/v1/chat/completions", model: "customer-model", apiKey: "typed-secret", headers: { "api-key": "custom-secret" },
  }));
  expect(await screen.findByText("Reachable: Connected.")).toBeInTheDocument();
});
it("clears typed credentials after saving and never hydrates a saved secret", async () => {
  await custom();
  h.updateAiSettingsAction.mockResolvedValue({ data: { ...view, stored: { provider: "custom", baseUrl: "https://customer.test/v1/chat/completions", model: "customer-model" }, credentialsConfigured: true, apiKeyConfigured: true } });
  fireEvent.change(screen.getByLabelText("API key (optional bearer token)"), { target: { value: "typed-secret" } });
  fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
  await screen.findByText("Saved.");
  expect(screen.getByLabelText("API key (optional bearer token)")).toHaveValue("");
  expect(screen.getByLabelText("Additional headers (JSON, optional)")).toHaveValue("");
});
it("does not carry typed credentials when switching providers", async () => {
  await custom();
  fireEvent.change(screen.getByLabelText("API key (optional bearer token)"), { target: { value: "typed-secret" } });
  fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "ollama" } });
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  await waitFor(() => expect(h.testAiConnectionAction).toHaveBeenCalled());
  expect(h.testAiConnectionAction.mock.calls[0][0]).not.toHaveProperty("apiKey");
});
it("rejects invalid header JSON without calling the server", async () => {
  await custom();
  fireEvent.change(screen.getByLabelText("Additional headers (JSON, optional)"), { target: { value: "invalid" } });
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("JSON object");
  expect(h.testAiConnectionAction).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Test connection" })).toBeEnabled();
});
it("recovers from a rejected action", async () => {
  await custom();
  h.testAiConnectionAction.mockRejectedValueOnce(new Error("network"));
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Test connection" })).toBeEnabled();
});
