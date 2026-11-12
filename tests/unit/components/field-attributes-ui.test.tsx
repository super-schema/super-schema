/** @vitest-environment jsdom */
import { afterEach, describe, it, expect, vi } from "vitest";
import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { FieldQuickEditPanel } from "@/components/custom/FieldQuickEditPanel";
import { FieldStudio } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/fields/[fieldId]/field-studio";
import { DocumentationPanel } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/fields/[fieldId]/panels/DocumentationPanel";
import { ExtensionsPanel } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/fields/[fieldId]/panels/ExtensionsPanel";
import { IdentityPanel } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/fields/[fieldId]/panels/IdentityPanel";
import { FIELD_ATTRIBUTE_SECTIONS } from "@/lib/field-attributes";
import type {
  Documentation,
  Extensions,
  Identity,
} from "@/types/schemas/typespec-decorator.schema";
const h = vi.hoisted(() => ({
  update: vi.fn().mockResolvedValue({ success: true }),
  push: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock(
  "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions",
  () => ({ updateFieldAction: h.update }),
);
const field = {
  id: "f",
  name: "value",
  type: "string",
  precision: null,
  scale: null,
  nullable: true,
  isKey: false,
  fieldNumber: 1,
  description: "Canonical description",
  classification: null,
  aliases: [],
  decorators: {},
  sortOrder: 0,
};
const entity = {
  id: "e",
  name: "Record",
  slug: "record",
  domainSlug: "sales",
  productSlug: "accounts",
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const change = (name: string, value: string) =>
  fireEvent.change(screen.getByLabelText(name), { target: { value } });
function mount(mode: "quick" | "full", overrides = {}) {
  const update = vi.fn().mockResolvedValue(undefined);
  render(
    mode === "quick" ? (
      <FieldQuickEditPanel
        field={{ ...field, ...overrides }}
        entityId="e"
        domainSlug="sales"
        onUpdateField={update}
      />
    ) : (
      <FieldStudio
        field={{ ...field, ...overrides }}
        entity={entity}
        domain={{ name: "Sales", policy: null }}
      />
    ),
  );
  return update;
}

describe("shared attribute editors", () => {
  it.each(["quick", "full"] as const)(
    "%s presents one description and the same categories",
    (mode) => {
      mount(mode, {
        decorators: {
          typespec: { documentation: { summary: "Legacy short text" } },
        },
      });
      expect(
        (screen.getByLabelText("Description") as HTMLTextAreaElement).value,
      ).toBe("Canonical description");
      expect(screen.queryByRole("textbox", { name: /summary/i })).toBeNull();
      for (const label of FIELD_ATTRIBUTE_SECTIONS)
        expect(screen.getByRole("button", { name: label })).toBeDefined();
      expect(
        screen.queryByRole("button", { name: "Access Control" }),
      ).toBeNull();
    },
  );
  it("the full editor writes the canonical description, not a decorator mirror", async () => {
    mount("full");
    change("Description", "A better description");
    await waitFor(() => expect(h.update).toHaveBeenCalled(), { timeout: 2500 });
    expect(h.update.mock.calls[0][1]).toMatchObject({
      description: "A better description",
    });
    expect(
      h.update.mock.calls[0][1].decorators.typespec.documentation ?? {},
    ).not.toHaveProperty("doc");
  });
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    "the quick editor saves required=%s, null=%s distinctly",
    async (required, allowNull) => {
      const update = mount("quick");
      const req = screen.getByRole("checkbox", {
        name: /^Required/,
      }) as HTMLInputElement;
      const nullable = screen.getByRole("checkbox", {
        name: /^Allow null/,
      }) as HTMLInputElement;
      if (req.checked !== required) fireEvent.click(req);
      if (nullable.checked !== allowNull) fireEvent.click(nullable);
      change("Description", "Save these settings");
      fireEvent.click(screen.getByTestId("field-save-btn"));
      await waitFor(() => expect(update).toHaveBeenCalledOnce());
      const value = update.mock.calls[0][1];
      expect(value.nullable).toBe(!required || allowNull);
      expect(value.decorators.nullableType === true).toBe(allowNull);
      expect(value.decorators.requiredNullable === true).toBe(
        required && allowNull,
      );
    },
  );
  it("renders Markdown as safe elements", () => {
    mount("quick");
    change("Description", "**Meaningful** [link](javascript:alert(1))");
    fireEvent.click(
      screen.getByRole("button", { name: "Preview description" }),
    );
    const preview = screen.getByLabelText("Description preview");
    expect(preview.querySelector("strong")?.textContent).toBe("Meaningful");
    expect(preview.querySelector('a[href^="javascript:"]')).toBeNull();
  });
});
describe("typed documentation and extensions", () => {
  it("keeps structured examples readable and typed", () => {
    function Harness() {
      const [v, set] = useState<Documentation>({
        example: { id: 3, active: false },
      });
      return (
        <>
          <DocumentationPanel
            documentation={v}
            fieldType="object"
            onChange={set}
          />
          <output data-testid="stored">{JSON.stringify(v.example)}</output>
        </>
      );
    }
    render(<Harness />);
    expect(
      (screen.getByLabelText("Example") as HTMLTextAreaElement).value,
    ).toContain('"active": false');
    change("Example", '{"id":4}');
    expect(screen.getByTestId("stored").textContent).toBe('{"id":4}');
  });
  it("keeps string-like numbers as strings, distinguishes null, edits entries, and refuses duplicates", () => {
    function Harness() {
      const [v, set] = useState<Extensions>({});
      return (
        <>
          <ExtensionsPanel extensions={v} onChange={set} />
          <output data-testid="stored">{JSON.stringify(v.openapi)}</output>
        </>
      );
    }
    render(<Harness />);
    change("Extension name", "account-code");
    change("Extension value", "00123");
    fireEvent.click(screen.getByRole("button", { name: "Add extension" }));
    expect(
      JSON.parse(screen.getByTestId("stored").textContent!)["x-account-code"],
    ).toBe("00123");
    change("Extension name", "account-code");
    change("Extension value", "replacement");
    fireEvent.click(screen.getByRole("button", { name: "Add extension" }));
    expect(screen.getByRole("alert").textContent).toContain("already exists");
    fireEvent.click(
      screen.getByRole("button", { name: "Edit extension x-account-code" }),
    );
    change("Extension value", "00456");
    fireEvent.click(screen.getByRole("button", { name: "Update extension" }));
    expect(
      JSON.parse(screen.getByTestId("stored").textContent!)["x-account-code"],
    ).toBe("00456");
    change("Extension name", "nullable");
    change("Extension value type", "null");
    fireEvent.click(screen.getByRole("button", { name: "Add extension" }));
    expect(
      JSON.parse(screen.getByTestId("stored").textContent!)["x-nullable"],
    ).toBeNull();
  });
  it("provides unset, true and false as distinct boolean defaults", () => {
    function Harness() {
      const [v, set] = useState<Identity>({});
      return (
        <>
          <IdentityPanel
            identity={v}
            fieldType="boolean"
            isOptional={false}
            onIdentityChange={set}
            onOptionalChange={() => undefined}
          />
          <output data-testid="stored">{JSON.stringify(v)}</output>
        </>
      );
    }
    render(<Harness />);
    expect(
      (screen.getByLabelText("Default value") as HTMLSelectElement).value,
    ).toBe("");
    change("Default value", "true");
    expect(
      JSON.parse(screen.getByTestId("stored").textContent!).defaultValue,
    ).toBe(true);
    change("Default value", "false");
    expect(
      JSON.parse(screen.getByTestId("stored").textContent!).defaultValue,
    ).toBe(false);
    change("Default value", "");
    expect(
      JSON.parse(screen.getByTestId("stored").textContent!).defaultValue,
    ).toBeNull();
  });
});

describe("example precision and imported schema metadata", () => {
  it("preserves int64 example digits and checks configured bounds", () => {
    function Harness() {
      const [v, set] = useState<Documentation>({ example: 1 });
      return (
        <>
          <DocumentationPanel
            documentation={v}
            fieldType="int64"
            validation={{ minValue: 10 }}
            onChange={set}
          />
          <output data-testid="stored">{JSON.stringify(v.example)}</output>
        </>
      );
    }
    render(<Harness />);
    expect(screen.getByRole("alert").textContent).toContain("at least 10");
    change("Example", "20");
    expect(screen.queryByRole("alert")).toBeNull();
    change("Example", "9223372036854775807");
    expect(screen.getByTestId("stored").textContent).toBe(
      '"9223372036854775807"',
    );
    expect(screen.getByRole("alert").textContent).toContain("cannot be written exactly as an example");
  });
  it("keeps an imported non-vendor schema key when its value is edited", () => {
    function Harness() {
      const [v, set] = useState<Extensions>({ openapi: { const: "00123" } });
      return (
        <>
          <ExtensionsPanel extensions={v} onChange={set} />
          <output data-testid="stored">{JSON.stringify(v.openapi)}</output>
        </>
      );
    }
    render(<Harness />);
    fireEvent.click(
      screen.getByRole("button", { name: "Edit extension const" }),
    );
    change("Extension value", "00124");
    fireEvent.click(screen.getByRole("button", { name: "Update extension" }));
    expect(JSON.parse(screen.getByTestId("stored").textContent!)).toEqual({
      const: "00124",
    });
  });
});

describe("enum values and validation in the field studio", () => {
  it("edits enum values as one ordered list instead of a row per value", () => {
    mount("full", { type: "enum", aliases: ["ACTIVE", "CLOSED"] });
    expect(screen.getByText("2 values")).toBeDefined();
    expect(screen.queryByLabelText("Enum value 1")).toBeNull();
    const input = screen.getByLabelText("New value");
    fireEvent.change(input, { target: { value: "PENDING," } });
    expect(screen.getByRole("button", { name: "Remove PENDING" })).toBeDefined();
    expect(screen.getByText("3 values")).toBeDefined();
  });

  it("does not present an enum's legacy pattern as a validation constraint", () => {
    mount("full", {
      type: "enum",
      aliases: [],
      decorators: { typespec: { validation: { pattern: "A|B|C" } } },
    });
    expect(screen.queryByText("Configured")).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear stored @pattern value" })).toBeNull();
  });
});
