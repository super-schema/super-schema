/**
 * @vitest-environment jsdom
 */
/**
 * Opening the Field Studio is a navigation like any other. A page with unsaved edits can veto it (`canNavigate`, which the page's leave guard
 * answers by asking the user), so the studio opens only when nothing vetoed it. Both ways in are covered: the row's Field Studio button and
 * a double click on the row.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FieldEditor } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/field-editor";
import { BEFORE_NAVIGATE_EVENT, type BeforeNavigateDetail } from "@/lib/navigation/before-navigate";

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const EMAIL = {
  id: "f1",
  slug: "email",
  name: "email",
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
  sortOrder: 0,
};

function renderEditor(onAddField: () => Promise<unknown> = async () => undefined) {
  return render(
    <FieldEditor
      entityId="ent-1"
      entitySlug="customer"
      domainSlug="payments"
      productSlug="checkout"
      fields={[EMAIL]}
      domainPolicy={null}
      onAddField={onAddField as never}
      onUpdateField={async () => {}}
      onDeleteField={async () => {}}
      onReorderFields={async () => true}
    />
  );
}

/** A page with unsaved work: it vetoes every navigation the shell asks about (as the entity workspace does while its drafts are dirty). */
function vetoShellNavigation() {
  const veto = (event: Event) => event.preventDefault();
  document.addEventListener(BEFORE_NAVIGATE_EVENT, veto);
  return () => document.removeEventListener(BEFORE_NAVIGATE_EVENT, veto);
}

describe("FieldEditor: opening the Field Studio is guarded like any other navigation", () => {
  it("the Field Studio button opens the studio when no page vetoes the navigation", () => {
    renderEditor();
    fireEvent.click(screen.getByTestId("field-open-studio"));
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(expect.stringContaining("/fields/email"));
  });

  it("the Field Studio button does not navigate when the page vetoes it", () => {
    const restore = vetoShellNavigation();
    renderEditor();
    fireEvent.click(screen.getByTestId("field-open-studio"));
    restore();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("a double click on the row does not navigate when the page vetoes it", () => {
    const restore = vetoShellNavigation();
    renderEditor();
    fireEvent.doubleClick(screen.getByTestId("field-card"));
    restore();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("a double click on the row opens the studio when no page vetoes the navigation", () => {
    renderEditor();
    fireEvent.doubleClick(screen.getByTestId("field-card"));
    expect(router.push).toHaveBeenCalledWith(expect.stringContaining("/fields/email"));
  });

  it("Create & Add Details asks the page before it opens the studio of the new field; a veto keeps the field and resets the dialog", async () => {
    const restore = vetoShellNavigation();
    const asked: string[] = [];
    const record = (event: Event) => asked.push((event as CustomEvent<BeforeNavigateDetail>).detail.href);
    document.addEventListener(BEFORE_NAVIGATE_EVENT, record);
    const onAddField = vi.fn(async () => ({ field: { id: "f2", slug: "region" } }));
    renderEditor(onAddField);

    fireEvent.click(screen.getByTestId("field-add-button"));
    fireEvent.change(screen.getByPlaceholderText("field_name"), { target: { value: "region" } });
    fireEvent.click(screen.getByRole("button", { name: "Create & Add Details" }));

    await waitFor(() => expect(screen.queryByPlaceholderText("field_name")).toBeNull());
    document.removeEventListener(BEFORE_NAVIGATE_EVENT, record);
    restore();
    expect(onAddField).toHaveBeenCalledTimes(1);
    expect(asked).toEqual([expect.stringContaining("/fields/region")]);

    // The attempt is over: a new name can be typed and the button is live again.
    fireEvent.click(screen.getByTestId("field-add-button"));
    fireEvent.change(screen.getByPlaceholderText("field_name"), { target: { value: "again" } });
    expect((screen.getByRole("button", { name: "Create & Add Details" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
