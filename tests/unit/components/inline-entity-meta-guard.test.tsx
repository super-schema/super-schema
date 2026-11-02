/**
 * @vitest-environment jsdom
 */
/**
 * The inline tags, owner and description of the entity are unsaved edits like the field panel's: the component reports them to the page
 * (`onDirtyChange`, so the leave guard asks before the page is left), and the page saves or discards them through the refs. A save the server
 * refuses keeps the draft and says why. A refresh of the page that brings the same tags (a new array) does not wipe the draft.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const { toastMock } = vi.hoisted(() => ({ toastMock: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions", () => ({
  updateEntityMetadataAction: vi.fn(),
  updateEntityDescriptionAction: vi.fn(),
}));

import { InlineEntityMeta } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/InlineEntityMeta";

const actions = await import("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions");
const saveMetadata = actions.updateEntityMetadataAction as unknown as ReturnType<typeof vi.fn>;
const saveDescription = actions.updateEntityDescriptionAction as unknown as ReturnType<typeof vi.fn>;

type Refs = { saveRef: { current: null | (() => Promise<boolean>) }; discardRef: { current: null | (() => void) } };

const entityOf = (metadata: Record<string, unknown>, description = "") => ({ id: "ent-1", name: "Customer", description, metadata });

function renderMeta(entity = entityOf({ tags: ["silver"], owner: "Ana" }), refs?: Refs, onDirtyChange = vi.fn(), onMetaSaved = vi.fn()) {
  const view = render(
    <InlineEntityMeta
      entity={entity}
      isReadOnly={false}
      onMetaSaved={onMetaSaved}
      onDirtyChange={onDirtyChange}
      saveRef={refs?.saveRef}
      discardRef={refs?.discardRef}
    />
  );
  return { ...view, onDirtyChange, onMetaSaved };
}

function freshRefs(): Refs {
  return { saveRef: { current: null }, discardRef: { current: null } };
}

function addGoldTag() {
  fireEvent.click(screen.getByTestId("add-tag-button"));
  const input = screen.getByTestId("inline-tag-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "Gold" } });
  fireEvent.keyDown(input, { key: "Enter" });
}

beforeEach(() => {
  vi.clearAllMocks();
  saveMetadata.mockResolvedValue({ success: true });
  saveDescription.mockResolvedValue({ success: true });
});
afterEach(() => cleanup());

describe("InlineEntityMeta: unsaved tags, owner and description are the page's to guard", () => {
  it("a pending tag is reported to the page, saved through its ref, and released once the saved tags catch up", async () => {
    const refs = freshRefs();
    const { rerender, onDirtyChange, onMetaSaved } = renderMeta(undefined, refs);
    addGoldTag();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    let saved: boolean | undefined;
    await act(async () => { saved = await refs.saveRef.current?.(); });

    expect(saved).toBe(true);
    expect(saveMetadata).toHaveBeenCalledWith("ent-1", { tags: ["silver", "gold"], owner: "Ana" });
    expect(onMetaSaved).toHaveBeenCalledTimes(1);
    // The page re-renders with the saved tags: nothing is pending any more.
    rerender(
      <InlineEntityMeta entity={entityOf({ tags: ["silver", "gold"], owner: "Ana" })} isReadOnly={false} onDirtyChange={onDirtyChange} saveRef={refs.saveRef} discardRef={refs.discardRef} />
    );
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("a refresh that brings the same tags (as a new array) keeps the unsaved draft", () => {
    const { rerender, onDirtyChange } = renderMeta();
    addGoldTag();

    rerender(
      <InlineEntityMeta entity={entityOf({ tags: ["silver"], owner: "Ana" })} isReadOnly={false} onDirtyChange={onDirtyChange} />
    );

    expect(screen.getByText("gold")).toBeDefined();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it("a save the server refuses keeps the draft and says why", async () => {
    saveMetadata.mockResolvedValue({ error: "You do not have permission to do this", code: "FORBIDDEN" });
    const refs = freshRefs();
    const { onDirtyChange } = renderMeta(undefined, refs);
    addGoldTag();

    let saved: boolean | undefined;
    await act(async () => { saved = await refs.saveRef.current?.(); });

    expect(saved).toBe(false);
    expect(toastMock.error).toHaveBeenCalledWith("You do not have permission to do this");
    expect(screen.getByText("gold")).toBeDefined();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it("the page's discard (through its ref) drops the pending tags and owner", async () => {
    const refs = freshRefs();
    const { onDirtyChange } = renderMeta(undefined, refs);
    addGoldTag();

    act(() => refs.discardRef.current?.());

    expect(screen.queryByText("gold")).toBeNull();
    expect(screen.getByText("silver")).toBeDefined();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(saveMetadata).not.toHaveBeenCalled();
  });

  it("a description being edited is an unsaved edit: the page's save writes it, its discard cancels it", async () => {
    const refs = freshRefs();
    const { onDirtyChange, onMetaSaved } = renderMeta(entityOf({ tags: [], owner: "" }, ""), refs);
    fireEvent.click(screen.getByTestId("entity-add-description"));
    fireEvent.change(screen.getByTestId("entity-description-input"), { target: { value: "Customer account" } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    act(() => refs.discardRef.current?.());
    expect(screen.queryByTestId("entity-description-input")).toBeNull();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByTestId("entity-add-description"));
    fireEvent.change(screen.getByTestId("entity-description-input"), { target: { value: "Customer account" } });
    let saved: boolean | undefined;
    await act(async () => { saved = await refs.saveRef.current?.(); });
    expect(saved).toBe(true);
    expect(saveDescription).toHaveBeenCalledWith("ent-1", "Customer account");
    expect(screen.getByTestId("entity-description").textContent).toBe("Customer account");
    // A saved description is a draft change: the page marks it and flashes "Saved" (KD-008).
    expect(onMetaSaved).toHaveBeenCalledTimes(1);
  });

  it("a description save the server refuses keeps the editor open with its text, says why, and is not marked as saved", async () => {
    saveDescription.mockResolvedValue({ error: "The description is too long", code: "VALIDATION_ERROR" });
    const refs = freshRefs();
    const { onDirtyChange, onMetaSaved } = renderMeta(entityOf({ tags: [], owner: "" }, ""), refs);
    fireEvent.click(screen.getByTestId("entity-add-description"));
    fireEvent.change(screen.getByTestId("entity-description-input"), { target: { value: "Customer account" } });

    let saved: boolean | undefined;
    await act(async () => { saved = await refs.saveRef.current?.(); });

    expect(saved).toBe(false);
    expect(toastMock.error).toHaveBeenCalledWith("The description is too long");
    expect((screen.getByTestId("entity-description-input") as HTMLTextAreaElement).value).toBe("Customer account");
    expect(onMetaSaved).not.toHaveBeenCalled();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it("a description save that throws keeps the editor open with its text, says why, and is not marked as saved", async () => {
    saveDescription.mockRejectedValue(new Error("Failed to fetch"));
    const refs = freshRefs();
    const { onMetaSaved } = renderMeta(entityOf({ tags: [], owner: "" }, ""), refs);
    fireEvent.click(screen.getByTestId("entity-add-description"));
    fireEvent.change(screen.getByTestId("entity-description-input"), { target: { value: "Customer account" } });

    let saved: boolean | undefined;
    await act(async () => { saved = await refs.saveRef.current?.(); });

    expect(saved).toBe(false);
    expect(toastMock.error).toHaveBeenCalledWith("Could not save the description: Failed to fetch");
    expect((screen.getByTestId("entity-description-input") as HTMLTextAreaElement).value).toBe("Customer account");
    expect(onMetaSaved).not.toHaveBeenCalled();
  });

  it("releases its report when it goes away", () => {
    const { unmount, onDirtyChange } = renderMeta();
    addGoldTag();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    unmount();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });
});
