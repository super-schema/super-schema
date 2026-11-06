/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const actions = vi.hoisted(() => ({ previewOpenApiOperationsAction: vi.fn(), importOpenApiOperationsAction: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/api-import-actions", () => actions);

import { ApiImportDialog } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/ApiImportDialog";

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

const OPS = [
  { name: "listOrders", summary: "List", description: "", httpMethod: "GET", httpPath: "/orders", tags: [], deprecated: false, parameters: [], requestBody: null, responses: [{ statusCode: 200, type: "Order", isArray: true, contentType: "application/json", description: "" }] },
  { name: "createOrder", summary: "", description: "", httpMethod: "POST", httpPath: "/orders", tags: [], deprecated: false, parameters: [], requestBody: { type: "Order", isArray: false, contentType: "application/json", required: true, description: "" }, responses: [] },
];
const FOUND = { operations: OPS, warnings: ["GET /x: the default response is not supported; it was skipped."], referencedTypes: ["Order"], title: "Orders", version: "1", sourceVersion: "3.0.3" };

function renderDialog(onImported = vi.fn()) {
  render(<ApiImportDialog serviceId={null} domainId="d1" entityId="e1" entityName="Order" onImported={onImported} />);
  fireEvent.click(screen.getByTestId("api-import-open"));
  return onImported;
}

describe("ApiImportDialog", () => {
  it("previews pasted content, lists the operations checked, shows warnings, imports the checked ones", async () => {
    actions.previewOpenApiOperationsAction.mockResolvedValue({ success: true, data: FOUND });
    const created = [{ ...OPS[1], id: "op-1", serviceId: "svc-1" }];
    actions.importOpenApiOperationsAction.mockResolvedValue({ success: true, serviceId: "svc-1", created, warnings: [] });
    const onImported = renderDialog();

    expect((screen.getByTestId("api-import-preview") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("api-import-content"), { target: { value: "openapi: 3.0.3" } });
    fireEvent.click(screen.getByTestId("api-import-preview"));
    await screen.findByTestId("api-import-review");
    expect(actions.previewOpenApiOperationsAction).toHaveBeenCalledWith("e1", { kind: "text", content: "openapi: 3.0.3" });
    expect(screen.getByTestId("api-import-warnings").textContent).toMatch(/1 warning/);
    expect(screen.getByText(/Refers to/).textContent).toContain("Order");

    // uncheck GET /orders: only POST is imported
    fireEvent.click(screen.getByLabelText("GET /orders"));
    expect(screen.getByTestId("api-import-confirm").textContent).toBe("Import 1 operation");
    fireEvent.click(screen.getByTestId("api-import-confirm"));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(created));
    expect(actions.importOpenApiOperationsAction).toHaveBeenCalledWith({ serviceId: null, domainId: "d1", entityId: "e1", entityName: "Order", operations: [OPS[1]] });
    expect(toast.success).toHaveBeenCalledWith("Imported 1 operation");
    await waitFor(() => expect(screen.queryByTestId("api-import-dialog")).toBeNull());
  });

  it("sends a URL source from the URL tab", async () => {
    actions.previewOpenApiOperationsAction.mockResolvedValue({ success: true, data: FOUND });
    renderDialog();
    fireEvent.click(screen.getByRole("tab", { name: /From URL/ }));
    fireEvent.change(screen.getByTestId("api-import-url"), { target: { value: " https://example.com/openapi.yaml " } });
    fireEvent.click(screen.getByTestId("api-import-preview"));
    await screen.findByTestId("api-import-review");
    expect(actions.previewOpenApiOperationsAction).toHaveBeenCalledWith("e1", { kind: "url", url: "https://example.com/openapi.yaml" });
  });

  it("shows the parse error and stays on the input", async () => {
    actions.previewOpenApiOperationsAction.mockResolvedValue({ success: false, error: { code: "PARSE_ERROR", message: "The OpenAPI document is not valid YAML or JSON" } });
    renderDialog();
    fireEvent.change(screen.getByTestId("api-import-content"), { target: { value: "{" } });
    fireEvent.click(screen.getByTestId("api-import-preview"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/not valid YAML/);
    expect(screen.getByTestId("api-import-content")).toBeTruthy();
  });

  it("shows the import refusal and keeps the dialog open", async () => {
    actions.previewOpenApiOperationsAction.mockResolvedValue({ success: true, data: FOUND });
    actions.importOpenApiOperationsAction.mockResolvedValue({ error: "Entity not found", code: "NOT_FOUND" });
    const onImported = renderDialog();
    fireEvent.change(screen.getByTestId("api-import-content"), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("api-import-preview"));
    await screen.findByTestId("api-import-review");
    fireEvent.click(screen.getByTestId("api-import-confirm"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Entity not found/);
    expect(onImported).not.toHaveBeenCalled();
  });
});
