// @vitest-environment jsdom
/**
 * The TypeSpec Source tab save asks "which entity do you mean?" when a field is typed with a name several entities of the tenant share
 * (`needsReference`), through the shared pick hook. The text may ADD that field, so the pick has no row to be saved on: it is kept by the
 * tab and goes with the retry of the save as `picks`, and `setFieldReferenceAction` is never called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { toastMock } = vi.hoisted(() => ({ toastMock: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions", () => ({
  getTypeSpecSourceAction: vi.fn(),
  compileAndApplyTypeSpecSourceAction: vi.fn(),
  setFieldReferenceAction: vi.fn(),
}));

import { TypeSpecSourceTab } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/TypeSpecSourceTab";
import { useReferencePick } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/useReferencePick";

const actions = await import("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions");
const getSource = actions.getTypeSpecSourceAction as unknown as ReturnType<typeof vi.fn>;
const save = actions.compileAndApplyTypeSpecSourceAction as unknown as ReturnType<typeof vi.fn>;
const setReference = actions.setFieldReferenceAction as unknown as ReturnType<typeof vi.fn>;

const SOURCE = "model Customer {\n  @key id: string;\n}\n";
const EDITED = "model Customer {\n  @key id: string;\n  address: Address;\n}\n";
const CANDIDATES = [
  { entityId: "addr-1", domain: "Billing", product: "Payments", entity: "Address" },
  { entityId: "addr-2", domain: "Sales", product: "Shipping", entity: "Address" },
];
const ASK = (field: string, fieldId = "") => ({
  success: false,
  diagnostics: [],
  error: `Field "${field}" refers to "Address", which matches 2 entities. Choose the entity it means on that field, then save again.`,
  needsReference: { field, name: "Address", candidates: CANDIDATES, entityId: "ent-1", fieldId },
});
const SAVED = { success: true, diagnostics: [], applied: { added: 1, updated: 0, removed: [] } };

async function editAndSave(onSaved = vi.fn()) {
  getSource.mockResolvedValue({ success: true, source: SOURCE, generated: false });
  render(<TypeSpecSourceTab entityId="ent-1" entityName="Customer" onSaved={onSaved} />);
  const textarea = (await screen.findByTestId("typespec-source-textarea")) as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: EDITED } });
  fireEvent.click(screen.getByRole("button", { name: /Save/ }));
  return onSaved;
}

describe("TypeSpec Source tab: an ambiguous name asks, the pick comes back with the retry", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("a save that does not ask is one call, with no picks", async () => {
    save.mockResolvedValueOnce(SAVED);
    const onSaved = await editAndSave();

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("ent-1", EDITED, {});
    expect(screen.queryByTestId("reference-pick-dialog")).toBeNull();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("asks (before any error toast), and a pick retries the save once with the pick; the pick is never saved on a field row", async () => {
    save.mockResolvedValueOnce(ASK("address")).mockResolvedValueOnce(SAVED);
    const onSaved = await editAndSave();

    expect(await screen.findByTestId("reference-pick-dialog")).toBeDefined();
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getAllByTestId("reference-pick-candidate")[1]);

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]).toEqual(["ent-1", EDITED, { address: "addr-2" }]);
    expect(setReference).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("reference-pick-dialog")).toBeNull();
  });

  it("two ambiguous fields are asked one after the other and every pick goes with the last retry", async () => {
    save.mockResolvedValueOnce(ASK("billing")).mockResolvedValueOnce(ASK("shipping")).mockResolvedValueOnce(SAVED);
    const onSaved = await editAndSave();

    fireEvent.click((await screen.findAllByTestId("reference-pick-candidate"))[0]);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1][2]).toEqual({ billing: "addr-1" });
    // the second question replaces the first dialog
    await waitFor(() => expect(screen.getByText(/Field "shipping" refers to/)).toBeDefined());
    fireEvent.click(screen.getAllByTestId("reference-pick-candidate")[1]);

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(save.mock.calls[2][2]).toEqual({ billing: "addr-1", shipping: "addr-2" });
  });

  it("cancel: nothing is saved, no retry, no error toast, and Save can be pressed again", async () => {
    save.mockResolvedValueOnce(ASK("address"));
    const onSaved = await editAndSave();

    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByTestId("reference-pick-dialog")).toBeNull());
    expect(save).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: /Save/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a server that still asks about the same field after its pick is shown as the error it carries, not asked again", async () => {
    save.mockResolvedValueOnce(ASK("address")).mockResolvedValueOnce(ASK("address"));
    await editAndSave();

    fireEvent.click((await screen.findAllByTestId("reference-pick-candidate"))[0]);

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));
    expect(toastMock.error.mock.calls[0][0]).toMatch(/Field "address" refers to "Address", which matches 2 entities/);
    expect(save).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("reference-pick-dialog")).toBeNull();
  });

  it("the picks of one save do not leak into the next", async () => {
    save.mockResolvedValueOnce(ASK("address")).mockResolvedValueOnce(SAVED).mockResolvedValueOnce(SAVED);
    await editAndSave();
    fireEvent.click((await screen.findAllByTestId("reference-pick-candidate"))[0]);
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId("typespec-source-textarea"), { target: { value: `${EDITED}\n// again\n` } });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(3));
    expect(save.mock.calls[2][2]).toEqual({});
  });
});

describe("useReferencePick without savePick is what it was: the pick is saved on the field row", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  function Harness() {
    const { pickReference, dialog } = useReferencePick();
    return (
      <div>
        <button onClick={() => void pickReference({ field: "a", name: "Address", candidates: CANDIDATES, entityId: "ent-1", fieldId: "f-1" })}>ask</button>
        {dialog}
      </div>
    );
  }

  it("calls setFieldReferenceAction(entityId, fieldId, { entityId: picked })", async () => {
    setReference.mockResolvedValue({ success: true, data: undefined });
    render(<Harness />);

    fireEvent.click(screen.getByText("ask"));
    fireEvent.click((await screen.findAllByTestId("reference-pick-candidate"))[0]);

    await waitFor(() => expect(setReference).toHaveBeenCalledWith("ent-1", "f-1", { entityId: "addr-1" }));
  });
});

describe("useReferencePick with savePick: a refusal is shown inside the dialog, which stays open", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  function Harness({ savePick }: { savePick: () => string | undefined }) {
    const { pickReference, dialog } = useReferencePick({ savePick });
    return (
      <div>
        <button onClick={() => void pickReference({ field: "a", name: "Address", candidates: CANDIDATES, entityId: "ent-1", fieldId: "" })}>ask</button>
        {dialog}
      </div>
    );
  }

  it("shows the message and does not call setFieldReferenceAction", async () => {
    render(<Harness savePick={() => "Not kept"} />);

    fireEvent.click(screen.getByText("ask"));
    fireEvent.click((await screen.findAllByTestId("reference-pick-candidate"))[0]);

    expect((await screen.findByRole("alert")).textContent).toBe("Not kept");
    expect(screen.getByTestId("reference-pick-dialog")).toBeDefined();
    expect(setReference).not.toHaveBeenCalled();
  });
});
