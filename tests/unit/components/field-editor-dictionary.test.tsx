/**
 * Picking a dictionary suggestion in the New Field form fills type / description / classification, links the entry, and puts the entry's default
 * attribute values into the decorators the field is created with. Derivation (data_class) is the server action's job on save; the last test
 * runs the decorators through the same derivation the action uses.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FieldEditor } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/field-editor";
import { deriveFieldDecorators } from "@/services/metadata-rederive.service";
import { readFieldAttributes } from "@/lib/metadata-attributes/values";
import type { DictionaryEntry } from "@/types/schemas/field-dictionary";
import type { MetadataAttributeDefinition } from "@/types/schemas/metadata-attribute";

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/db", () => ({ prisma: {} }));

afterEach(cleanup);

const email: DictionaryEntry = {
  id: "dict-email",
  tenantId: "t1",
  name: "email",
  aliases: ["emailAddress"],
  type: "string",
  description: "Contact email of the customer",
  classification: "PII",
  attributes: { "x-securityClassification": { data_category: "ConsumerPersonal" } },
  conceptId: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function renderEditor(onAddField: (...a: unknown[]) => Promise<unknown>) {
  return render(
    <FieldEditor
      entityId="ent-1"
      entitySlug="customer"
      domainSlug="payments"
      productSlug="checkout"
      fields={[]}
      dictionary={[email]}
      domainPolicy={null}
      onAddField={onAddField as never}
      onUpdateField={async () => {}}
      onDeleteField={async () => {}}
      onReorderFields={async () => true}
    />,
  );
}

async function pickEmail() {
  fireEvent.click(screen.getByText("Add Field"));
  const input = screen.getByPlaceholderText("field_name") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "emailAdd" } });
  const option = await screen.findByText("dictionary");
  fireEvent.mouseDown(option);
  fireEvent.click(option);
  return input;
}

describe("FieldEditor dictionary pick", () => {
  it("creates the field with the entry's type, description, classification, link and attributes", async () => {
    const onAddField = vi.fn(async () => ({ success: true }));
    renderEditor(onAddField);
    const input = await pickEmail();
    expect(input.value).toBe("email");

    fireEvent.click(screen.getByText("Quick Create"));
    await waitFor(() => expect(onAddField).toHaveBeenCalled());
    const [name, type, opts] = onAddField.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(name).toBe("email");
    expect(type).toBe("string");
    expect(opts).toMatchObject({
      description: "Contact email of the customer",
      classification: "PII",
      dictionaryEntryId: "dict-email",
    });
    expect(readFieldAttributes(opts.decorators)).toEqual({ "x-securityClassification": { data_category: "ConsumerPersonal" } });
  });

  it("forgets the entry when the name is edited away from it", async () => {
    const onAddField = vi.fn(async () => ({ success: true }));
    renderEditor(onAddField);
    const input = await pickEmail();
    fireEvent.change(input, { target: { value: "other_field" } });
    fireEvent.click(screen.getByText("Quick Create"));
    await waitFor(() => expect(onAddField).toHaveBeenCalled());
    expect(onAddField.mock.calls[0]).toEqual(["other_field", "string"]);
  });

  it("the saved decorators derive data_class class2 for a PII field", async () => {
    const onAddField = vi.fn(async () => ({ success: true }));
    renderEditor(onAddField);
    await pickEmail();
    fireEvent.click(screen.getByText("Quick Create"));
    await waitFor(() => expect(onAddField).toHaveBeenCalled());
    const [name, type, opts] = onAddField.mock.calls[0] as unknown as [string, string, { classification: string; decorators: Record<string, unknown> }];

    const def = {
      key: "x-securityClassification",
      label: "Security classification",
      description: "",
      valueSchema: { type: "object", properties: { data_category: { type: "string" }, data_class: { type: "string" } } },
      targets: ["field"],
      scope: "schema",
      placement: "field",
      derive: { data_class: "class{class}" },
      requiredWhen: "never",
    } as unknown as MetadataAttributeDefinition;
    const saved = deriveFieldDecorators({ defs: [def], custom: new Map() }, { name, type, classification: opts.classification, decorators: opts.decorators });
    expect(readFieldAttributes(saved)["x-securityClassification"]).toEqual({ data_category: "ConsumerPersonal", data_class: "class2" });
  });
});
