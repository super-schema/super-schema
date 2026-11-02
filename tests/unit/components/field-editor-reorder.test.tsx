/**
 * @vitest-environment jsdom
 */
/**
 * Dragging a field to another place shows the new order at once and saves it as ONE list of ids (`onReorderFields`), not as one update for
 * every field that moved. A save the server refuses, or one that throws, puts the saved order back. The order a save answered with is what
 * the page shows once its fields arrive.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";

// jsdom has no pointer geometry, so the test performs the drop itself: the wrapper keeps the real DndContext (the sorting and the rows are real)
// and hands the `onDragEnd` the editor gives it to the test.
const drag = vi.hoisted(() => ({
  onDragEnd: undefined as undefined | ((event: { active: { id: string }; over: { id: string } | null }) => unknown),
}));
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: Parameters<typeof actual.DndContext>[0]) => {
      drag.onDragEnd = props.onDragEnd as unknown as typeof drag.onDragEnd;
      return <actual.DndContext {...props} />;
    },
  };
});

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { FieldEditor } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/field-editor";

afterEach(cleanup);

const FIELDS = ["email", "name", "phone"].map((name, index) => ({
  id: `f${index + 1}`,
  slug: name,
  name,
  type: "string",
  precision: null,
  scale: null,
  nullable: false,
  isKey: false,
  fieldNumber: null,
  description: "",
  classification: null,
  aliases: [],
  decorators: {},
  sortOrder: index,
}));

function editor(fields: typeof FIELDS, onReorderFields: (ids: string[]) => Promise<boolean>, onUpdateField = vi.fn(async () => {})): ReactElement {
  return (
    <FieldEditor
      entityId="ent-1"
      entitySlug="customer"
      domainSlug="payments"
      productSlug="checkout"
      fields={fields}
      domainPolicy={null}
      onAddField={async () => undefined}
      onUpdateField={onUpdateField}
      onDeleteField={async () => {}}
      onReorderFields={onReorderFields}
    />
  );
}

/** The names of the rows, top to bottom, as the screen shows them (the drag handle of each row is labelled with its name). */
const shownOrder = () => screen.getAllByLabelText(/^Reorder /).map((handle) => (handle.getAttribute("aria-label") ?? "").replace("Reorder ", ""));
/** Drag `active` onto the place of `over`. */
const dropOn = (active: string, over: string) => ({ active: { id: active }, over: { id: over } });

describe("FieldEditor drag reorder", () => {
  it("a drop shows the new order at once and is saved as one list of ids, without a per-field update", async () => {
    let finish!: (saved: boolean) => void;
    const onReorderFields = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const onUpdateField = vi.fn(async () => {});
    render(editor(FIELDS, onReorderFields, onUpdateField));

    await act(async () => { void drag.onDragEnd?.(dropOn("f1", "f3")); });

    expect(onReorderFields).toHaveBeenCalledTimes(1);
    expect(onReorderFields).toHaveBeenCalledWith(["f2", "f3", "f1"]);
    expect(onUpdateField).not.toHaveBeenCalled();
    expect(shownOrder()).toEqual(["name", "phone", "email"]);

    // The save is in flight: the new order stays on screen (no flash back to the stored order).
    await act(async () => finish(true));
    expect(shownOrder()).toEqual(["name", "phone", "email"]);
  });

  it("a save the server refuses puts the saved order back", async () => {
    const onReorderFields = vi.fn(async () => false);
    render(editor(FIELDS, onReorderFields));

    await act(async () => { await drag.onDragEnd?.(dropOn("f1", "f3")); });

    expect(onReorderFields).toHaveBeenCalledWith(["f2", "f3", "f1"]);
    expect(shownOrder()).toEqual(["email", "name", "phone"]);
  });

  it("a save that throws puts the saved order back too", async () => {
    render(editor(FIELDS, vi.fn(async () => { throw new Error("network down"); })));

    await act(async () => { await drag.onDragEnd?.(dropOn("f1", "f3")); });

    expect(shownOrder()).toEqual(["email", "name", "phone"]);
  });

  it("when the page's fields arrive they replace the shown order, whatever the server stored", async () => {
    const onReorderFields = vi.fn(async () => true);
    const { rerender } = render(editor(FIELDS, onReorderFields));
    await act(async () => { await drag.onDragEnd?.(dropOn("f1", "f3")); });
    expect(shownOrder()).toEqual(["name", "phone", "email"]);

    // The page re-renders with the stored sort order (here: the server kept `phone` first).
    const stored = [FIELDS[2], FIELDS[1], FIELDS[0]].map((field, sortOrder) => ({ ...field, sortOrder }));
    rerender(editor(stored, onReorderFields));
    expect(shownOrder()).toEqual(["phone", "name", "email"]);
  });
});
