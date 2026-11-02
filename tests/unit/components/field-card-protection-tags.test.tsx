/**
 * The field card's tags say what the field protects, as the Data Protection section stores it (decorators.typespec.governance), and show a legacy
 * value only where a row never had the new key. Retention is the entity's, so the card shows only a legacy value on the field.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { FieldCard } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/FieldCard";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

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
  description: "",
  classification: "PII",
  aliases: [],
  decorators: {},
  sortOrder: 0,
};

function card(decorators: Record<string, unknown>) {
  return (
    <DndContext>
      <SortableContext items={[FIELD.id]}>
        <FieldCard
          field={{ ...FIELD, decorators }}
          index={0}
          isSelected={false}
          isReadOnly={false}
          onFieldSelect={vi.fn()}
          onUpdateField={vi.fn(async () => {})}
          onDeleteField={vi.fn(async () => {})}
          onNavigateStudio={vi.fn()}
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

afterEach(cleanup);

describe("the field card's protection tags", () => {
  it("show the anonymization and the encryption the Data Protection section stored", () => {
    render(card({ typespec: { governance: { anonymization: "hash", encryption: "AES-256" } } }));

    expect(screen.getByText("anon: hash")).toBeDefined();
    expect(screen.getByText("encrypt: AES-256")).toBeDefined();
  });

  it("show no tag for a value the panel cleared", () => {
    render(card({ typespec: { governance: { anonymization: null, encryption: null } } }));

    expect(screen.queryByText(/^anon:/)).toBeNull();
    expect(screen.queryByText(/^encrypt:/)).toBeNull();
  });

  it("show a legacy value on a row that never had the new key", () => {
    render(card({ policy: { anonymization: "mask", retention: "3 years" } }));

    expect(screen.getByText("anon: mask")).toBeDefined();
    expect(screen.getByText("retention: 3 years")).toBeDefined();
  });
});
