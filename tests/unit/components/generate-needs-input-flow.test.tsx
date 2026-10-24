// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SchemaTargetChooser } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/SchemaTargetChooser";

const { toastMock } = vi.hoisted(() => ({ toastMock: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions", () => ({
  generateSchemaAction: vi.fn(),
  setEntityPrimaryKeyAction: vi.fn(),
}));

const actions = await import("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions");
const generate = actions.generateSchemaAction as unknown as ReturnType<typeof vi.fn>;
const setKey = actions.setEntityPrimaryKeyAction as unknown as ReturnType<typeof vi.fn>;

const NEEDS = {
  needsInput: [
    { code: "primary-key", message: "Order has no primary key.", candidates: ["tenant", "note"], suggested: ["tenant"] },
  ],
};
const GENERATED = { success: true, schemaVersion: { version: 1 }, validationStatus: "VALID", warnings: [], errors: [] };

function mount(onGenerated = vi.fn()) {
  render(
    <SchemaTargetChooser
      entityId="ent-1"
      fieldsCount={2}
      availableTargets={[{ key: "bigquery", displayName: "BigQuery", icon: null, supportsFieldOverrides: false }]}
      onGenerated={onGenerated}
    />,
  );
  return onGenerated;
}

describe("generating a target that needs a primary key", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("asks, saves the answer on the entity, then retries and generates", async () => {
    generate.mockResolvedValueOnce(NEEDS).mockResolvedValueOnce(GENERATED);
    setKey.mockResolvedValue({ success: true, primaryKey: ["tenant"] });
    const onGenerated = mount();

    fireEvent.click(screen.getByTestId("generate-selected-schema"));
    expect(await screen.findByText("This target needs a primary key")).toBeDefined();
    expect((screen.getByRole("checkbox", { name: "tenant" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Save key and generate/ }));

    await waitFor(() => expect(onGenerated).toHaveBeenCalled());
    expect(setKey).toHaveBeenCalledWith("ent-1", ["tenant"]);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(screen.queryByText("This target needs a primary key")).toBeNull();
  });

  it("shows a save failure inline and does not retry generation", async () => {
    generate.mockResolvedValueOnce(NEEDS);
    setKey.mockResolvedValue({ error: "Not a field of this entity: x", code: "VALIDATION_ERROR" });
    mount();

    fireEvent.click(screen.getByTestId("generate-selected-schema"));
    fireEvent.click(await screen.findByRole("button", { name: /Save key and generate/ }));

    expect((await screen.findByRole("alert")).textContent).toBe("Not a field of this entity: x");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("cancel leaves everything as it was: no save, no retry, no error toast", async () => {
    generate.mockResolvedValueOnce(NEEDS);
    const onGenerated = mount();

    fireEvent.click(screen.getByTestId("generate-selected-schema"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByText("This target needs a primary key")).toBeNull());
    expect(setKey).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(onGenerated).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("reports a reference that matches several entities as an error, never as a generation that happened", async () => {
    generate.mockResolvedValueOnce({
      needsReference: {
        field: "addr",
        name: "Address",
        candidates: [
          { entityId: "x1", domain: "d1", product: "p1", entity: "Address" },
          { entityId: "x2", domain: "d2", product: "p2", entity: "Address" },
        ],
        entityId: "ent-1",
        fieldId: "fld-1",
      },
    });
    const onGenerated = mount();

    fireEvent.click(screen.getByTestId("generate-selected-schema"));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));
    expect(String(toastMock.error.mock.calls[0][0])).toContain('Field "addr" refers to "Address", which matches 2 entities');
    expect(onGenerated).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
