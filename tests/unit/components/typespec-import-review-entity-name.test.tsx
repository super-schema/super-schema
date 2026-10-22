/**
 * An entity still named with the importer placeholder cannot be imported until it is named or unregistered.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TypeSpecImportReviewScreen } from "@/components/custom/ImportDialog/TypeSpecImportReviewScreen";
import { IMPORTED_ENTITY_FALLBACK_NAME, parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { toAssetImportResult } from "@/lib/importers/multi-asset";

vi.mock("@/components/custom/ValidationIndicator", () => ({
  ValidationIndicator: () => <span />,
}));

afterEach(cleanup);

function renderFor(schema: object) {
  const parsed = parseJsonSchemaDocument(JSON.stringify(schema));
  if (!parsed.success) throw new Error("import failed");
  const importResult = toAssetImportResult(parsed.data);
  const onConfirm = vi.fn();
  render(<TypeSpecImportReviewScreen importResult={importResult} domains={[{ id: "d1", name: "Payments" }]} onConfirm={onConfirm} onCancel={vi.fn()} />);
  return { importResult, onConfirm, confirm: () => screen.getByRole("button", { name: /^Import \d+ Asset/ }) as HTMLButtonElement };
}

describe("TypeSpecImportReviewScreen: entity name", () => {
  it("disables the import and says to give the entity a name while an entity is still the placeholder", () => {
    const { importResult, confirm, onConfirm } = renderFor({ type: "object", properties: { id: { type: "string" } } });
    const placeholder = importResult.models.find((m) => m.name === IMPORTED_ENTITY_FALLBACK_NAME)!;
    expect(placeholder.recommendedAsEntity).toBe(true);

    expect(confirm().disabled).toBe(true);
    expect(screen.getByTestId("needs-entity-name").textContent).toContain("Give this entity a name");
    fireEvent.click(confirm());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("enables the import again once the placeholder is no longer registered as an entity", () => {
    const { confirm, onConfirm } = renderFor({ type: "object", properties: { id: { type: "string" } } });
    fireEvent.click(screen.getByLabelText(`${IMPORTED_ENTITY_FALLBACK_NAME} entity`));
    expect(screen.queryByTestId("needs-entity-name")).toBeNull();
    expect(confirm().disabled).toBe(false);
    fireEvent.click(confirm());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("does not interfere with a schema that names itself", () => {
    const { confirm } = renderFor({ title: "Person", type: "object", properties: { id: { type: "string" } } });
    expect(screen.queryByTestId("needs-entity-name")).toBeNull();
    expect(confirm().disabled).toBe(false);
  });
});
