/**
 * The entity API tab: contract-shaped editor (request body, typed params / responses, tags, operationId, deprecated),
 * path-parameter sync, inline client + server validation, debounced autosave, Generate CRUD, duplicate / reorder, service
 * settings, tenant-level message, save-time warnings (shown, never blocking), and the setState-in-render regression.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ApiOperationRecord } from "@/types/schemas/api-operation";

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const actions = vi.hoisted(() => ({
  getOrCreateEntityServiceAction: vi.fn(),
  createOperationAction: vi.fn(),
  replaceOperationDetailsAction: vi.fn(),
  deleteOperationAction: vi.fn(),
  reorderOperationsAction: vi.fn(),
  updateServiceAction: vi.fn(),
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/actions", () => actions);

// Phase D components: stand-ins with their exact props.
const importProps = vi.hoisted(() => ({ last: null as null | { onImported: (ops: unknown[]) => void; serviceId: string | null } }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/ApiImportDialog", () => ({
  ApiImportDialog: (props: { onImported: (ops: unknown[]) => void; serviceId: string | null }) => {
    importProps.last = props;
    return <button type="button" data-testid="api-import-stub">Import OpenAPI</button>;
  },
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/ApiPreview", () => ({
  ApiPreview: ({ entityId }: { entityId: string }) => <div data-testid="api-preview-stub">preview of {entityId}</div>,
}));
vi.mock("next/dynamic", async () => {
  const React = await import("react");
  return {
    default: (loader: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
      const Lazy = React.lazy(() => loader().then((c) => ({ default: c })));
      return function Dynamic(props: Record<string, unknown>) {
        return <React.Suspense fallback={null}><Lazy {...props} /></React.Suspense>;
      };
    },
  };
});

import { ApiTab } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/ApiTab";

const op = (over: Partial<ApiOperationRecord> = {}): ApiOperationRecord => ({
  id: "op1",
  serviceId: "svc1",
  name: "getInvoice",
  summary: "",
  description: "",
  httpMethod: "GET",
  httpPath: "/invoices/{id}",
  tags: [],
  deprecated: false,
  parameters: [{ name: "id", type: "string", isArray: false, location: "path", required: true, description: "" }],
  requestBody: null,
  responses: [{ statusCode: 200, type: "Invoice", isArray: false, contentType: "application/json", description: "ok" }],
  ...over,
});

function renderTab(props: Partial<React.ComponentProps<typeof ApiTab>> = {}) {
  return render(
    <ApiTab
      entityId="e1"
      entityName="Invoice"
      domainId="d1"
      serviceId="svc1"
      service={{ id: "svc1", name: "InvoiceApi", basePath: "/" }}
      initialOperations={[op()]}
      fields={[{ name: "invoiceId", type: "uuid", isKey: true }, { name: "lines", type: "InvoiceLine" }]}
      typeNames={["Customer"]}
      {...props}
    />
  );
}

const expand = (name = "getInvoice") => {
  const row = screen.getByText(name, { selector: "span" }).closest('[data-testid="api-operation"]') as HTMLElement;
  fireEvent.click(within(row).getAllByRole("button")[0]);
  return row;
};

let consoleError: { mock: { calls: unknown[][] }; mockRestore: () => void };
beforeEach(() => {
  vi.clearAllMocks();
  consoleError = vi.spyOn(console, "error");
  actions.replaceOperationDetailsAction.mockImplementation(async (_id: string, data: unknown) => ({ success: true, operation: data }));
  actions.deleteOperationAction.mockResolvedValue({ success: true });
  actions.reorderOperationsAction.mockResolvedValue({ success: true });
  actions.getOrCreateEntityServiceAction.mockResolvedValue({ success: true, serviceId: "svc1" });
  let n = 0;
  actions.createOperationAction.mockImplementation(async (_sid: string, data: Record<string, unknown>) => ({
    success: true,
    operationId: `new${++n}`,
    operation: { summary: "", description: "", tags: [], deprecated: false, parameters: [], requestBody: null, responses: [], ...data },
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  consoleError.mockRestore();
});

const renderWarnings = () =>
  consoleError.mock.calls.filter((args: unknown[]) => String(args[0]).includes("Cannot update a component") || String(args[0]).includes("while rendering a different component"));

describe("ApiTab editor", () => {
  it("edits never trigger a React 'Cannot update a component while rendering' warning, and saves are debounced per operation", async () => {
    vi.useFakeTimers();
    renderTab();
    expand();
    const name = screen.getByTestId("api-edit-name");
    for (const value of ["getInvoiceB", "getInvoiceBy", "getInvoiceById"]) fireEvent.change(name, { target: { value } });
    fireEvent.change(screen.getByTestId("api-edit-summary"), { target: { value: "Fetch one" } });
    fireEvent.click(screen.getByTestId("api-edit-deprecated"));
    fireEvent.click(screen.getByTestId("api-add-response"));
    expect(actions.replaceOperationDetailsAction).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(450); });
    expect(actions.replaceOperationDetailsAction).toHaveBeenCalledTimes(1);
    const [id, payload] = actions.replaceOperationDetailsAction.mock.calls[0];
    expect(id).toBe("op1");
    expect(payload).toMatchObject({ name: "getInvoiceById", summary: "Fetch one", deprecated: true, operationId: "" });
    expect(payload.responses).toHaveLength(2);
    expect(renderWarnings()).toEqual([]);
  });

  it("flushes a pending save on unmount", async () => {
    vi.useFakeTimers();
    const { unmount } = renderTab();
    expand();
    fireEvent.change(screen.getByTestId("api-edit-description"), { target: { value: "left before the debounce" } });
    unmount();
    expect(actions.replaceOperationDetailsAction).toHaveBeenCalledWith("op1", expect.objectContaining({ description: "left before the debounce" }));
  });

  it("syncs path parameters with the path: added, renamed in place (type kept), removed", async () => {
    renderTab();
    expand();
    const params = () => screen.queryAllByTestId("api-param").map((p) => `${p.getAttribute("data-location")}:${p.getAttribute("data-name")}`);
    // give {id} a non-default type first
    const typeSelect = within(screen.getAllByTestId("api-param")[0]).getByLabelText("Parameter type");
    fireEvent.change(typeSelect, { target: { value: "uuid" } });

    const path = screen.getByTestId("api-edit-path");
    fireEvent.change(path, { target: { value: "/invoices/{id}/lines/{lineId}" } });
    expect(params()).toEqual(["path:id", "path:lineId"]);

    fireEvent.change(path, { target: { value: "/invoices/{invoiceId}/lines/{lineId}" } });
    expect(params()).toEqual(["path:invoiceId", "path:lineId"]);
    expect((within(screen.getAllByTestId("api-param")[0]).getByLabelText("Parameter type") as HTMLSelectElement).value).toBe("uuid");

    // mid-edit (unbalanced) leaves the parameters alone
    fireEvent.change(path, { target: { value: "/invoices/{invoiceId}/lines/{line" } });
    expect(params()).toEqual(["path:invoiceId", "path:lineId"]);

    fireEvent.change(path, { target: { value: "/invoices" } });
    expect(params()).toEqual([]);
  });

  it("edits a request body, typed responses (array, content type, full status list), tags and operationId", async () => {
    renderTab();
    expand();
    fireEvent.click(screen.getByTestId("api-add-body"));
    const body = screen.getByTestId("api-body");
    fireEvent.change(within(body).getByLabelText("Request body type"), { target: { value: "Customer" } });
    fireEvent.click(within(body).getByLabelText("Request body type: array"));
    fireEvent.change(within(body).getByLabelText("Request content type"), { target: { value: "application/xml" } });

    const response = screen.getAllByTestId("api-response")[0];
    const status = within(response).getByLabelText("Response status") as HTMLSelectElement;
    expect([...status.options].map((o) => Number(o.value))).toEqual(expect.arrayContaining([100, 202, 418, 422, 511]));
    fireEvent.change(status, { target: { value: "202" } });
    fireEvent.click(within(response).getByLabelText("Response type: array"));

    const tagInput = screen.getByLabelText("Add tag");
    fireEvent.change(tagInput, { target: { value: "billing" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });
    fireEvent.change(tagInput, { target: { value: "public" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove tag public" }));
    fireEvent.change(screen.getByTestId("api-edit-operation-id"), { target: { value: "fetchInvoice" } });

    await waitFor(() => expect(actions.replaceOperationDetailsAction).toHaveBeenCalled());
    const payload = actions.replaceOperationDetailsAction.mock.calls.at(-1)![1];
    expect(payload).toMatchObject({
      operationId: "fetchInvoice",
      tags: ["billing"],
      requestBody: { type: "Customer", isArray: true, contentType: "application/xml", required: true },
      responses: [{ statusCode: 202, type: "Invoice", isArray: true }],
    });
  });

  it("offers primitives, this entity, other entities and field types in the type picker", () => {
    renderTab();
    expand();
    const select = within(screen.getAllByTestId("api-param")[0]).getByLabelText("Parameter type") as HTMLSelectElement;
    const values = [...select.options].map((o) => o.value);
    expect(values).toEqual(expect.arrayContaining(["string", "int64", "uuid", "date-time", "Invoice", "Customer", "InvoiceLine"]));
  });

  it("shows client-side contract errors inline and does not save an invalid draft", async () => {
    renderTab();
    expand();
    fireEvent.change(screen.getByTestId("api-edit-name"), { target: { value: "get invoice" } });
    expect(await screen.findByText(/must be an identifier/)).toBeTruthy();
    expect(screen.getByTestId("api-edit-name").getAttribute("aria-invalid")).toBe("true");
    await waitFor(() => expect(screen.getByTestId("api-save-status").getAttribute("data-state")).toBe("invalid"));
    expect(actions.replaceOperationDetailsAction).not.toHaveBeenCalled();
  });

  it("maps server issues[] to their fields and shows the error state", async () => {
    actions.replaceOperationDetailsAction.mockResolvedValue({
      error: "httpPath GET /invoices/{id} is already defined",
      code: "VALIDATION_ERROR",
      issues: [
        { path: "httpPath", message: "GET /invoices/{} is already defined by another operation" },
        { path: "", message: "OpenAPI: something global" },
      ],
    });
    renderTab();
    expand();
    fireEvent.change(screen.getByTestId("api-edit-summary"), { target: { value: "x" } });
    expect(await screen.findByText("GET /invoices/{} is already defined by another operation")).toBeTruthy();
    expect(screen.getByTestId("api-edit-path").getAttribute("aria-invalid")).toBe("true");
    expect(within(screen.getByTestId("api-op-issues")).getByText(/something global/)).toBeTruthy();
    expect(screen.getByTestId("api-save-status").getAttribute("data-state")).toBe("error");
    // the next edit clears the server issues
    fireEvent.change(screen.getByTestId("api-edit-summary"), { target: { value: "xy" } });
    expect(screen.queryByText("GET /invoices/{} is already defined by another operation")).toBeNull();
  });

  it("shows saving then saved", async () => {
    let resolve!: (v: unknown) => void;
    actions.replaceOperationDetailsAction.mockImplementation(() => new Promise((r) => { resolve = r; }));
    renderTab();
    expand();
    fireEvent.change(screen.getByTestId("api-edit-summary"), { target: { value: "x" } });
    await waitFor(() => expect(screen.getByTestId("api-save-status").getAttribute("data-state")).toBe("saving"));
    await act(async () => { resolve({ success: true }); });
    await waitFor(() => expect(screen.getByTestId("api-save-status").getAttribute("data-state")).toBe("saved"));
    expect(screen.getByTestId("api-save-status").textContent).toMatch(/saved/i);
  });
});

describe("ApiTab operations", () => {
  it("creates an operation from the New Operation form (path placeholders become path parameters)", async () => {
    renderTab({ initialOperations: [] });
    expect(screen.getByTestId("api-empty")).toBeTruthy();
    fireEvent.click(screen.getByTestId("api-add-operation"));
    expect((screen.getByTestId("api-op-path") as HTMLInputElement).value).toBe("/invoices");
    expect((screen.getByTestId("api-op-create") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("api-op-name"), { target: { value: "getInvoice" } });
    fireEvent.change(screen.getByTestId("api-op-path"), { target: { value: "/invoices/{invoiceId}" } });
    fireEvent.change(screen.getByTestId("api-op-description"), { target: { value: "One" } });
    fireEvent.click(screen.getByTestId("api-op-create"));
    await waitFor(() => expect(screen.getAllByTestId("api-operation")).toHaveLength(1));
    expect(actions.createOperationAction).toHaveBeenCalledWith("svc1", expect.objectContaining({
      name: "getInvoice",
      httpPath: "/invoices/{invoiceId}",
      parameters: [expect.objectContaining({ name: "invoiceId", location: "path", required: true })],
    }));
    expect(screen.getByTestId("api-operation").textContent).toContain("1p · 1r");
  });

  it("keeps the form open with the server's issues when a create is rejected", async () => {
    actions.createOperationAction.mockResolvedValue({ error: "dup", code: "VALIDATION_ERROR", issues: [{ path: "httpPath", message: "GET /invoices is already defined" }] });
    renderTab({ initialOperations: [] });
    fireEvent.click(screen.getByTestId("api-add-operation"));
    fireEvent.change(screen.getByTestId("api-op-name"), { target: { value: "listInvoices" } });
    fireEvent.click(screen.getByTestId("api-op-create"));
    expect(await screen.findByText("GET /invoices is already defined")).toBeTruthy();
    expect(screen.getByTestId("api-new-operation")).toBeTruthy();
  });

  it("creates the entity service on the first operation", async () => {
    actions.getOrCreateEntityServiceAction.mockResolvedValue({ success: true, serviceId: "svc-new" });
    renderTab({ initialOperations: [], serviceId: null, service: null });
    fireEvent.click(screen.getByTestId("api-add-operation"));
    fireEvent.change(screen.getByTestId("api-op-name"), { target: { value: "listInvoices" } });
    fireEvent.click(screen.getByTestId("api-op-create"));
    await waitFor(() => expect(actions.createOperationAction).toHaveBeenCalledWith("svc-new", expect.anything()));
    expect(actions.getOrCreateEntityServiceAction).toHaveBeenCalledWith("d1", "e1", "Invoice");
  });

  it("Generate CRUD adds list/get/create/update/delete, skipping an existing method + path, and is idempotent", async () => {
    renderTab();
    fireEvent.click(screen.getByTestId("api-generate-crud"));
    await waitFor(() => expect(actions.createOperationAction).toHaveBeenCalledTimes(4));
    const created = actions.createOperationAction.mock.calls.map((c) => `${c[1].httpMethod} ${c[1].httpPath} ${c[1].name}`);
    // GET /invoices/{id} already exists (as getInvoice): it is skipped, and PUT / DELETE take its spelling of the path (OpenAPI
    // reads /invoices/{invoiceId} as the same path, which the server refuses), keeping the key field's type for the parameter.
    expect(created).toEqual([
      "GET /invoices listInvoices",
      "POST /invoices createInvoice",
      "PUT /invoices/{id} updateInvoice",
      "DELETE /invoices/{id} deleteInvoice",
    ]);
    expect(actions.createOperationAction.mock.calls[2][1].parameters).toEqual([expect.objectContaining({ name: "id", type: "uuid", location: "path" })]);
    const post = actions.createOperationAction.mock.calls[1][1];
    expect(post.requestBody).toMatchObject({ type: "Invoice" });
    expect(actions.createOperationAction.mock.calls[0][1].responses[0]).toMatchObject({ statusCode: 200, type: "Invoice", isArray: true });
    await waitFor(() => expect(screen.getAllByTestId("api-operation")).toHaveLength(5));

    fireEvent.click(screen.getByTestId("api-generate-crud"));
    await waitFor(() => expect(toast.info).toHaveBeenCalled());
    expect(actions.createOperationAction).toHaveBeenCalledTimes(4);
  });

  it("duplicates an operation under a fresh name and a non-colliding path", async () => {
    renderTab();
    expand();
    fireEvent.click(screen.getByTestId("api-op-duplicate"));
    await waitFor(() => expect(screen.getAllByTestId("api-operation")).toHaveLength(2));
    expect(actions.createOperationAction).toHaveBeenCalledWith("svc1", expect.objectContaining({
      name: "getInvoiceCopy",
      httpMethod: "GET",
      httpPath: "/invoices/{id}/copy",
      parameters: [expect.objectContaining({ name: "id", location: "path" })],
    }));
  });

  it("reorders operations and persists the order", async () => {
    renderTab({ initialOperations: [op(), op({ id: "op2", name: "listInvoices", httpPath: "/invoices", parameters: [] })] });
    fireEvent.click(screen.getByRole("button", { name: "Move listInvoices up" }));
    expect(screen.getAllByTestId("api-operation").map((r) => r.getAttribute("data-name"))).toEqual(["listInvoices", "getInvoice"]);
    await waitFor(() => expect(actions.reorderOperationsAction).toHaveBeenCalledWith("svc1", ["op2", "op1"]));
  });

  it("deletes an operation and cancels its pending save", async () => {
    vi.useFakeTimers();
    renderTab();
    expand();
    fireEvent.change(screen.getByTestId("api-edit-summary"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /^Delete/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(actions.deleteOperationAction).toHaveBeenCalledWith("op1");
    expect(actions.replaceOperationDetailsAction).not.toHaveBeenCalled();
    expect(screen.getByTestId("api-empty")).toBeTruthy();
  });

  it("appends imported operations and adopts their service", async () => {
    renderTab({ initialOperations: [], serviceId: null, service: null });
    expect(importProps.last?.serviceId).toBeNull();
    act(() => importProps.last!.onImported([op({ id: "imp1", serviceId: "svc-imp", name: "importedOp" })]));
    expect(screen.getAllByTestId("api-operation")).toHaveLength(1);
    await waitFor(() => expect(importProps.last?.serviceId).toBe("svc-imp"));
  });

  it("switches to the lazily loaded preview", async () => {
    renderTab();
    fireEvent.click(screen.getByTestId("api-view-preview"));
    expect(await screen.findByTestId("api-preview-stub")).toBeTruthy();
    expect(screen.queryByTestId("api-operation")).toBeNull();
    fireEvent.click(screen.getByTestId("api-view-operations"));
    expect(screen.getAllByTestId("api-operation")).toHaveLength(1);
  });

  it("edits the service name and base path", async () => {
    actions.updateServiceAction.mockResolvedValue({ success: true, service: { id: "svc1", name: "Invoices", basePath: "/v1" } });
    renderTab();
    fireEvent.click(screen.getByTestId("api-service-settings-toggle"));
    fireEvent.change(screen.getByTestId("api-service-name"), { target: { value: "Invoices" } });
    fireEvent.change(screen.getByTestId("api-service-base-path"), { target: { value: "/v1" } });
    fireEvent.click(screen.getByTestId("api-service-save"));
    await waitFor(() => expect(actions.updateServiceAction).toHaveBeenCalledWith("svc1", { name: "Invoices", basePath: "/v1" }));
    await waitFor(() => expect(screen.queryByTestId("api-service-settings")).toBeNull());
    expect(screen.getByTestId("api-tab").textContent).toContain("Invoices /v1");
  });

  it("shows a service settings error from the server", async () => {
    actions.updateServiceAction.mockResolvedValue({ error: 'An API named "Taken" already exists', code: "NAME_CONFLICT" });
    renderTab();
    fireEvent.click(screen.getByTestId("api-service-settings-toggle"));
    fireEvent.change(screen.getByTestId("api-service-name"), { target: { value: "Taken" } });
    fireEvent.click(screen.getByTestId("api-service-save"));
    expect(await screen.findByText('An API named "Taken" already exists')).toBeTruthy();
  });

  it("explains that a tenant-level entity cannot own an API", () => {
    renderTab({ domainId: null, serviceId: null, service: null, initialOperations: [] });
    expect(screen.getByTestId("api-tenant-level").textContent).toMatch(/Enterprise level/);
    expect(screen.queryByTestId("api-add-operation")).toBeNull();
    expect(screen.queryByTestId("api-generate-crud")).toBeNull();
  });

  it("is read-only for a reader", () => {
    renderTab({ isReadOnly: true });
    expect(screen.queryByTestId("api-add-operation")).toBeNull();
    expand();
    expect((screen.getByTestId("api-edit-name") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /^Delete/ })).toBeNull();
  });
});

describe("ApiTab save-time warnings", () => {
  const OPTIONS_WARNING = "OPTIONS operations are stored but left out of the generated OpenAPI document (TypeSpec HTTP can only write GET, PUT, POST, PATCH, DELETE and HEAD)";

  it("a create that returns warnings still adds the operation, toasts each warning and shows it inline", async () => {
    actions.createOperationAction.mockImplementation(async (_sid: string, data: Record<string, unknown>) => ({
      success: true,
      operationId: "new1",
      operation: { summary: "", description: "", tags: [], deprecated: false, parameters: [], requestBody: null, responses: [], ...data },
      warnings: ["Server-only warning"],
    }));
    renderTab({ initialOperations: [] });
    fireEvent.click(screen.getByTestId("api-add-operation"));
    fireEvent.change(screen.getByTestId("api-op-name"), { target: { value: "listInvoices" } });
    fireEvent.click(screen.getByTestId("api-op-create"));
    await waitFor(() => expect(screen.getAllByTestId("api-operation")).toHaveLength(1));
    expect(toast.warning).toHaveBeenCalledWith("listInvoices: Server-only warning");
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.queryByTestId("api-new-operation")).toBeNull();
    // the created operation is expanded: the notice is in its editor, and the row is flagged without being invalid
    expect(within(screen.getByTestId("api-op-warnings")).getByText("Server-only warning")).toBeTruthy();
    expect(screen.getByTestId("api-op-warning-badge").textContent).toBe("1 warning");
    expect(screen.getByTestId("api-operation").getAttribute("data-invalid")).toBeNull();
  });

  it("shows the OPTIONS notice for a stored OPTIONS operation on load, before any save", () => {
    renderTab({ initialOperations: [op({ httpMethod: "OPTIONS", name: "optionsInvoice" })] });
    expect(screen.getByTestId("api-op-warning-badge")).toBeTruthy();
    expand("optionsInvoice");
    expect(within(screen.getByTestId("api-op-warnings")).getByText(OPTIONS_WARNING)).toBeTruthy();
  });

  it("an autosave that returns warnings is saved (not an error) and its warnings are shown inline until a clean save", async () => {
    actions.replaceOperationDetailsAction.mockImplementationOnce(async (_id: string, data: unknown) => ({ success: true, operation: data, warnings: ["Server-only warning"] }));
    renderTab();
    expand();
    expect(screen.queryByTestId("api-op-warnings")).toBeNull();
    fireEvent.change(screen.getByTestId("api-edit-summary"), { target: { value: "x" } });
    await waitFor(() => expect(screen.getByTestId("api-op-warnings").textContent).toContain("Server-only warning"));
    expect(screen.getByTestId("api-save-status").getAttribute("data-state")).toBe("saved");
    expect(toast.warning).not.toHaveBeenCalled();
    // the next save comes back clean: the notice goes away
    fireEvent.change(screen.getByTestId("api-edit-summary"), { target: { value: "xy" } });
    await waitFor(() => expect(actions.replaceOperationDetailsAction).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("api-op-warnings")).toBeNull());
  });

  it("switching an operation to OPTIONS shows the notice at once and still saves it", async () => {
    renderTab();
    expand();
    fireEvent.change(screen.getByTestId("api-edit-method"), { target: { value: "OPTIONS" } });
    expect(within(screen.getByTestId("api-op-warnings")).getByText(OPTIONS_WARNING)).toBeTruthy();
    await waitFor(() => expect(actions.replaceOperationDetailsAction).toHaveBeenCalledWith("op1", expect.objectContaining({ httpMethod: "OPTIONS" })));
  });

  it("an import that creates the entity service also enables its settings", async () => {
    renderTab({ initialOperations: [], serviceId: null, service: null });
    expect(screen.queryByTestId("api-service-settings-toggle")).toBeNull();
    act(() => importProps.last!.onImported([op({ id: "imp1", serviceId: "svc-imp", name: "importedOp" })]));
    expect(await screen.findByTestId("api-service-settings-toggle")).toBeTruthy();
    expect(screen.getByTestId("api-tab").textContent).toContain("InvoiceApi");
  });
});
