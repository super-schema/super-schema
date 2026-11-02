/**
 * @vitest-environment jsdom
 */
/**
 * The TypeSpec Source tab answers a rejected action (a network drop, a server action id that went stale after a deploy): the loading state
 * ends, and the save button comes back with the error said, instead of spinning or reading "Compiling…" for the rest of the session.
 *
 * The tab also reports its unsaved source to the page (`onDirtyChange`), so the page's leave guard can ask about it, and it saves or
 * discards that source through the refs the guard calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { toastMock } = vi.hoisted(() => ({ toastMock: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions", () => ({
  getTypeSpecSourceAction: vi.fn(),
  compileAndApplyTypeSpecSourceAction: vi.fn(),
  setFieldReferenceAction: vi.fn(),
}));

import { TypeSpecSourceTab } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/TypeSpecSourceTab";

const actions = await import("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions");
const getSource = actions.getTypeSpecSourceAction as unknown as ReturnType<typeof vi.fn>;
const save = actions.compileAndApplyTypeSpecSourceAction as unknown as ReturnType<typeof vi.fn>;

const SOURCE = "model Customer {\n  @key id: string;\n}\n";
const EDITED = "model Customer {\n  @key id: string;\n  email: string;\n}\n";
const SAVED = { success: true, diagnostics: [], applied: { added: 1, updated: 0, removed: [] } };

beforeEach(() => {
  vi.clearAllMocks();
  getSource.mockResolvedValue({ success: true, source: SOURCE, generated: false });
});
afterEach(() => cleanup());

describe("TypeSpec Source tab: a rejected action does not leave the tab stuck", () => {
  it("a load that rejects ends the loading state, says why, and shows the editor", async () => {
    getSource.mockRejectedValueOnce(new Error("Failed to fetch"));
    render(<TypeSpecSourceTab entityId="ent-1" entityName="Customer" />);

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));
    expect(toastMock.error.mock.calls[0][0]).toMatch(/Could not load the TypeSpec source/);
    expect(screen.queryByText(/Compiling current fields/)).toBeNull();
    expect(screen.getByTestId("typespec-source-textarea")).toBeDefined();
  });

  it("a save that rejects says why, brings Save back, and the next save can go through", async () => {
    save.mockRejectedValueOnce(new Error("Failed to fetch")).mockResolvedValueOnce(SAVED);
    const onSaved = vi.fn();
    render(<TypeSpecSourceTab entityId="ent-1" entityName="Customer" onSaved={onSaved} />);
    fireEvent.change((await screen.findByTestId("typespec-source-textarea")) as HTMLTextAreaElement, { target: { value: EDITED } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));
    expect(toastMock.error.mock.calls[0][0]).toMatch(/Could not save the TypeSpec source/);
    expect(screen.queryByText("Compiling…")).toBeNull();
    const saveButton = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    expect((screen.getByTestId("typespec-source-textarea") as HTMLTextAreaElement).value).toBe(EDITED);

    fireEvent.click(saveButton);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it("the page's save (through its ref) resolves to whether the source was saved, and sends the text as typed", async () => {
    const saveRef = { current: null as null | (() => Promise<boolean>) };
    save.mockResolvedValueOnce({ success: false, diagnostics: [], error: "TypeSpec did not compile" }).mockResolvedValueOnce(SAVED);
    render(<TypeSpecSourceTab entityId="ent-1" entityName="Customer" saveRef={saveRef} />);
    fireEvent.change(await screen.findByTestId("typespec-source-textarea"), { target: { value: EDITED } });

    let first: boolean | undefined;
    let second: boolean | undefined;
    await act(async () => { first = await saveRef.current?.(); });
    expect(first).toBe(false);
    await act(async () => { second = await saveRef.current?.(); });
    expect(second).toBe(true);
    expect(save).toHaveBeenLastCalledWith("ent-1", EDITED, {});
  });
});

describe("TypeSpec Source tab: its unsaved source is the page's to guard", () => {
  it("reports an unsaved source to the page, and releases it when the tab goes away", async () => {
    const onDirtyChange = vi.fn();
    const { unmount } = render(<TypeSpecSourceTab entityId="ent-1" entityName="Customer" onDirtyChange={onDirtyChange} />);
    fireEvent.change(await screen.findByTestId("typespec-source-textarea"), { target: { value: EDITED } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    unmount();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("the page's discard (through its ref) drops the unsaved text and reports the source clean", async () => {
    const onDirtyChange = vi.fn();
    const discardRef = { current: null as null | (() => void) };
    render(<TypeSpecSourceTab entityId="ent-1" entityName="Customer" onDirtyChange={onDirtyChange} discardRef={discardRef} />);
    const textarea = (await screen.findByTestId("typespec-source-textarea")) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: EDITED } });

    act(() => discardRef.current?.());

    expect(textarea.value).toBe(SOURCE);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(save).not.toHaveBeenCalled();
  });
});
