/**
 * Choosing a reference's target in the entity page's field editor: from the field row's type picker (an existing field turned into a
 * reference) and from the New Field form (a new reference field). The pick is saved on the field through the existing field create / update
 * path, as a fully qualified reference (id + qualified name, never a version); a typed name that matches no entity stays a plain name.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { FieldEditor } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/field-editor";
import { FieldCard } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/FieldCard";
import type { PickableEntity } from "@/lib/references/entity-reference";

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const TARGETS: PickableEntity[] = [
  { id: "e-addr-b", name: "Address", domain: "Billing", product: "Core" },
  { id: "e-addr-s", name: "Address", domain: "Sales", product: "Crm" },
  { id: "e-cust", name: "Customer", domain: "Sales", product: "Crm" },
];

const FIELD = {
  id: "f1", slug: "ship-to", name: "shipTo", type: "string", precision: null, scale: null, nullable: true, isKey: false,
  fieldNumber: null, description: "", classification: null, aliases: [], decorators: { keep: "me" }, sortOrder: 0,
};

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
});
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

/** Open the picker whose trigger shows `current`, choose `reference`, search `text` and (optionally) click the entry labelled `entry`. */
function chooseReference(current: string, text: string, entry?: string) {
  fireEvent.click(screen.getAllByRole("button", { name: new RegExp(`^${current}$`, "i") })[0]);
  fireEvent.click(screen.getByText("reference"));
  fireEvent.change(screen.getByPlaceholderText("Search or type entity name..."), { target: { value: text } });
  if (entry) fireEvent.click(screen.getByText(entry));
  fireEvent.click(screen.getByText(/Confirm ref/));
}

describe("a field row's type picker", () => {
  const handlers = { onFieldSelect: vi.fn(), onDeleteField: vi.fn(async () => {}), onNavigateStudio: vi.fn() };

  function card(onUpdateField: (id: string, data: Record<string, unknown>) => Promise<void>, referenceTargets: PickableEntity[] | null = TARGETS) {
    return render(
      <DndContext>
        <SortableContext items={["f1"]}>
          <FieldCard field={FIELD} index={0} isSelected={false} isReadOnly={false} onUpdateField={onUpdateField} referenceTargets={referenceTargets ?? undefined} {...handlers} />
        </SortableContext>
      </DndContext>,
    );
  }

  it("turns the field into a reference to the picked entity in ONE update: type and qualified reference together, other decorators kept", async () => {
    const onUpdateField = vi.fn<(id: string, data: Record<string, unknown>) => Promise<void>>(async () => {});
    card(onUpdateField);

    chooseReference("string", "Addr", "Sales / Crm / Address");

    await waitFor(() => expect(onUpdateField).toHaveBeenCalledTimes(1));
    expect(onUpdateField).toHaveBeenCalledWith("f1", {
      type: "reference",
      precision: null,
      scale: null,
      decorators: {
        keep: "me",
        referencedEntityId: "e-addr-s",
        referencedEntityName: "Address",
        referencedQualifiedName: "Sales/Crm/Address",
        referencedDomain: "Sales",
        referencedProduct: "Crm",
        referencedEntity: "Address",
      },
    });
  });

  it("never stores a version when it writes the reference", async () => {
    const onUpdateField = vi.fn<(id: string, data: Record<string, unknown>) => Promise<void>>(async () => {});
    card(onUpdateField);

    chooseReference("string", "Customer");

    await waitFor(() => expect(onUpdateField).toHaveBeenCalledTimes(1));
    const data = onUpdateField.mock.calls[0][1] as { decorators: Record<string, unknown> };
    expect("referencedEntityVersion" in data.decorators).toBe(false);
    expect(data.decorators.referencedEntityId).toBe("e-cust");
  });

  it("a name that matches no entity is saved as a plain name, with no id", async () => {
    const onUpdateField = vi.fn<(id: string, data: Record<string, unknown>) => Promise<void>>(async () => {});
    card(onUpdateField);

    chooseReference("string", "Elsewhere");

    await waitFor(() => expect(onUpdateField).toHaveBeenCalledTimes(1));
    expect(onUpdateField).toHaveBeenCalledWith("f1", { type: "reference", precision: null, scale: null, decorators: { keep: "me", referencedEntityName: "Elsewhere" } });
  });

  it("without a list of entities choosing a reference is the plain type change it always was", async () => {
    const onUpdateField = vi.fn<(id: string, data: Record<string, unknown>) => Promise<void>>(async () => {});
    card(onUpdateField, null);

    fireEvent.click(screen.getAllByRole("button", { name: /^string$/i })[0]);
    fireEvent.click(screen.getByText("reference"));

    await waitFor(() => expect(onUpdateField).toHaveBeenCalledWith("f1", { type: "reference", precision: null, scale: null }));
    expect(screen.queryByPlaceholderText("Search or type entity name...")).toBeNull();
  });
});

describe("the New Field form", () => {
  function editor(onAddField: (...args: unknown[]) => Promise<unknown>, referenceTargets: PickableEntity[] | null = TARGETS) {
    return render(
      <FieldEditor
        entityId="ent-1"
        entitySlug="customer"
        domainSlug="payments"
        productSlug="checkout"
        fields={[]}
        domainPolicy={null}
        referenceTargets={referenceTargets ?? undefined}
        onAddField={onAddField as never}
        onUpdateField={async () => {}}
        onDeleteField={async () => {}}
      />,
    );
  }

  function openNewField(name: string) {
    fireEvent.click(screen.getByText("Add Field"));
    fireEvent.change(screen.getByPlaceholderText("field_name"), { target: { value: name } });
  }

  it("creates a reference field with the picked entity as its qualified reference", async () => {
    const onAddField = vi.fn(async () => ({ success: true }));
    editor(onAddField);
    openNewField("billingAddress");

    // the New Field form's own picker is the one showing the default type
    fireEvent.click(screen.getAllByRole("button", { name: /^string$/i })[0]);
    fireEvent.click(screen.getByText("reference"));
    fireEvent.change(screen.getByPlaceholderText("Search or type entity name..."), { target: { value: "Addr" } });
    fireEvent.click(screen.getByText("Billing / Core / Address"));
    fireEvent.click(screen.getByText(/Confirm ref/));

    expect(screen.getByTestId("new-field-reference-target").textContent).toContain("Billing / Core / Address");
    fireEvent.click(screen.getByText("Quick Create"));

    await waitFor(() => expect(onAddField).toHaveBeenCalledTimes(1));
    expect(onAddField).toHaveBeenCalledWith("billingAddress", "reference", {
      decorators: {
        referencedEntityId: "e-addr-b",
        referencedEntityName: "Address",
        referencedQualifiedName: "Billing/Core/Address",
        referencedDomain: "Billing",
        referencedProduct: "Core",
        referencedEntity: "Address",
      },
    });
  });

  it("a field of any other type is created exactly as before (no options)", async () => {
    const onAddField = vi.fn(async () => ({ success: true }));
    editor(onAddField);
    openNewField("email");

    fireEvent.click(screen.getByText("Quick Create"));

    await waitFor(() => expect(onAddField).toHaveBeenCalledWith("email", "string"));
  });

  it("a reference picked and then replaced by another type is not carried into the new field", async () => {
    const onAddField = vi.fn(async () => ({ success: true }));
    editor(onAddField);
    openNewField("x");
    fireEvent.click(screen.getAllByRole("button", { name: /^string$/i })[0]);
    fireEvent.click(screen.getByText("reference"));
    fireEvent.change(screen.getByPlaceholderText("Search or type entity name..."), { target: { value: "Customer" } });
    fireEvent.click(screen.getByText(/Confirm ref/));

    fireEvent.click(screen.getAllByRole("button", { name: /^reference$/i })[0]);
    fireEvent.click(screen.getByText("integer"));
    fireEvent.click(screen.getByText("Quick Create"));

    await waitFor(() => expect(onAddField).toHaveBeenCalledWith("x", "integer"));
  });

  it("without a list of entities the form is the plain one", () => {
    editor(vi.fn(), null);
    openNewField("x");
    fireEvent.click(screen.getAllByRole("button", { name: /^string$/i })[0]);
    fireEvent.click(screen.getByText("reference"));
    expect(screen.queryByPlaceholderText("Search or type entity name...")).toBeNull();
  });
});
