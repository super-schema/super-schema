// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowSettingsSchema, type PreparedPlan } from "@/lib/deployments/contracts";
vi.mock("@/components/custom/SchemaWorkbench/DetailPanel", () => ({ DetailPanel: ({ value }: { value: string }) => <pre data-testid="readonly-file-content">{value}</pre> }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { GitPrPreview } from "@/components/custom/deployments/GitPrPreview";
afterEach(cleanup);
const plan = { settings: WorkflowSettingsSchema.parse({ title: "Publish exact artifacts" }), connectionConfig: { url: "https://github.com/acme/contracts", baseBranch: "main", supportsIdempotency: false }, branch: "superschema/account", baseSha: "abcdef0123456789", validation: ["Pinned base validated"], files: [{ path: "schemas/account.avsc", content: '{"name":"Account"}\n' }, { path: "product-manifest.json", content: '{\n  "version": 2\n}\n' }], fileChanges: [{ path: "schemas/account.avsc", status: "added" }, { path: "product-manifest.json", status: "modified", before: '{\n  "version": 1\n}\n' }] } as PreparedPlan;
it("shows every prepared path and exact selected file content", async () => {
  render(<GitPrPreview plan={plan} />);
  const files = screen.getByRole("navigation", { name: "Files in Git PR" });
  expect(within(files).getByText("schemas/account.avsc")).toBeInTheDocument();
  expect(within(files).getByText("product-manifest.json")).toBeInTheDocument();
  expect(await screen.findByTestId("readonly-file-content")).toHaveTextContent('{"name":"Account"}');
  expect(screen.getByTestId("git-preview-title")).toHaveTextContent("Publish exact artifacts");
  fireEvent.click(within(files).getByText("product-manifest.json"));
  await waitFor(() => expect(screen.getByTestId("readonly-file-content").textContent).toBe(plan.files![1].content));
  fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
  expect(screen.getByTestId("git-file-diff")).toHaveTextContent('"version": 1');
  expect(screen.getByTestId("git-file-diff")).toHaveTextContent('"version": 2');
});
it("copies the frozen file bytes including its final newline", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  render(<GitPrPreview plan={plan} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(plan.files![0].content));
});
