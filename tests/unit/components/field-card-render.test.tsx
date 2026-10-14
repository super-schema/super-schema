/**
 * Entity field list render cost: FieldCard is memoized, and the pickers only
 * build their popup content while open.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { FieldEditor } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/field-editor";
import { FieldCard } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/FieldCard";
import { ClassificationPicker } from "@/components/custom/ClassificationPicker";
import { TypePicker } from "@/components/custom/TypePicker";

// Like Next's, the router object is referentially stable across renders.
const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

const counters = vi.hoisted(() => ({ completeness: 0, categories: 0 }));

vi.mock("@/lib/validation/field-completeness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/validation/field-completeness")>();
  return {
    ...actual,
    getFieldCompleteness: (...args: Parameters<typeof actual.getFieldCompleteness>) => {
      counters.completeness += 1;
      return actual.getFieldCompleteness(...args);
    },
  };
});
vi.mock("@/lib/data-types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data-types")>();
  return {
    ...actual,
    getTypesByCategory: () => {
      counters.categories += 1;
      return actual.getTypesByCategory();
    },
  };
});

const FIELD = {
  id: "f1",
  slug: "customer-id",
  name: "customerId",
  type: "string",
  precision: null,
  scale: null,
  nullable: false,
  isKey: true,
  fieldNumber: null,
  description: "Primary key",
  classification: "PII",
  aliases: [],
  decorators: {},
  sortOrder: 0,
};

const handlers = {
  onFieldSelect: vi.fn(),
  onUpdateField: vi.fn(async () => {}),
  onDeleteField: vi.fn(async () => {}),
  onNavigateStudio: vi.fn(),
};

const ITEMS = [FIELD.id];

function tree(props: Partial<React.ComponentProps<typeof FieldCard>> = {}) {
  return (
    <DndContext>
      <SortableContext items={ITEMS}>
        <FieldCard
          field={FIELD}
          index={0}
          isSelected={false}
          isReadOnly={false}
          {...handlers}
          {...props}
        />
      </SortableContext>
    </DndContext>
  );
}

beforeAll(() => {
  // cmdk (TypePicker's search list) needs these browser APIs.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  counters.completeness = 0;
  counters.categories = 0;
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("FieldCard", () => {
  it("does not re-render when its parent re-renders with unchanged props", () => {
    const { rerender } = render(tree());
    const initial = counters.completeness;
    expect(initial).toBeGreaterThan(0);

    rerender(tree());
    rerender(tree());
    expect(counters.completeness).toBe(initial);
  });

  it("re-renders when a prop it depends on changes", () => {
    const { rerender } = render(tree());
    const initial = counters.completeness;

    rerender(tree({ isSelected: true }));
    expect(counters.completeness).toBeGreaterThan(initial);

    const afterSelect = counters.completeness;
    rerender(tree({ isSelected: true, field: { ...FIELD, name: "customerKey" } }));
    expect(counters.completeness).toBeGreaterThan(afterSelect);
    expect(screen.getByText("customerKey")).toBeDefined();
  });

  it("still routes field edits through the callbacks", () => {
    render(tree());
    fireEvent.click(screen.getByTitle("Open Field Studio"));
    expect(handlers.onNavigateStudio).toHaveBeenCalledWith("customer-id");
    fireEvent.click(screen.getByTitle("Delete field"));
    expect(handlers.onDeleteField).toHaveBeenCalledWith("f1");
  });
});

describe("FieldEditor field list", () => {
  const FIELDS = [
    { ...FIELD, id: "f1", name: "customerId", slug: "customer-id" },
    { ...FIELD, id: "f2", name: "email", slug: "email", isKey: false, sortOrder: 1 },
  ];

  function editor(overrides: Partial<React.ComponentProps<typeof FieldEditor>> = {}) {
    return (
      <FieldEditor
        entityId="ent-1"
        entitySlug="customer"
        domainSlug="payments"
        productSlug="checkout"
        fields={FIELDS}
        domainPolicy={null}
        onAddField={vi.fn(async () => ({ success: true }) as never)}
        onUpdateField={async () => {}}
        onDeleteField={async () => {}}
        {...overrides}
      />
    );
  }

  it("does not re-render field rows when the workspace re-renders with fresh inline handlers", () => {
    const { rerender } = render(editor());
    const initial = counters.completeness;
    // One completeness computation per row render.
    expect(initial).toBe(FIELDS.length);

    rerender(editor({ onUpdateField: async () => {}, onDeleteField: async () => {}, onFieldSelect: () => {} }));
    rerender(editor({ onUpdateField: async () => {}, onDeleteField: async () => {}, onFieldSelect: () => {} }));
    expect(counters.completeness).toBe(initial);
  });

  it("calls the latest handlers, not the ones from the first render", () => {
    const first = vi.fn(async () => {});
    const latest = vi.fn(async () => {});
    const { rerender } = render(editor({ onDeleteField: first }));
    rerender(editor({ onDeleteField: latest }));

    fireEvent.click(screen.getAllByTitle("Delete field")[0]);
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith("f1");
  });
});

describe("ClassificationPicker", () => {
  it("renders only its trigger until opened, then lists every class and reports the choice", () => {
    const onChange = vi.fn();
    render(<ClassificationPicker value="PII" onChange={onChange} />);
    expect(screen.getByText("PII")).toBeDefined();
    expect(screen.queryByText("Class 1")).toBeNull();
    expect(screen.queryByText("Never Stored")).toBeNull();

    fireEvent.click(screen.getByText("PII"));
    expect(screen.getByText("Never Stored")).toBeDefined();
    expect(screen.getByText("Public")).toBeDefined();

    fireEvent.click(screen.getByText("Internal"));
    expect(onChange).toHaveBeenCalledWith("INTERNAL");
    expect(screen.queryByText("Never Stored")).toBeNull();
  });
});

describe("TypePicker", () => {
  it("builds no type list until opened, then shows the search and reports the choice", () => {
    const onChange = vi.fn();
    render(<TypePicker value="string" onChange={onChange} compact />);
    expect(counters.categories).toBe(0);
    expect(screen.queryByPlaceholderText("Search types...")).toBeNull();

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByPlaceholderText("Search types...")).toBeDefined();

    fireEvent.change(screen.getByPlaceholderText("Search types..."), { target: { value: "int32" } });
    expect(counters.categories).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByText("int32")[0]);
    expect(onChange).toHaveBeenCalledWith("int32");
  });
});
