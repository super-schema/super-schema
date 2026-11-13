import { fireEvent, screen } from "@testing-library/react";

/** The entity combobox of a pin picker (`${label} entity`). */
export const entityCombobox = (label: string) => screen.getByLabelText(`${label} entity`) as HTMLButtonElement;
/** The selected entity id of a pin picker ("" when none). */
export const entityValue = (label: string) => entityCombobox(label).getAttribute("data-value") ?? "";
/** Opens the picker and chooses the entity with `id` ("" = the "none" choice of an optional pin). */
export function pickEntity(label: string, id: string) {
  const box = entityCombobox(label);
  if (box.getAttribute("aria-expanded") !== "true") fireEvent.click(box);
  const option = document.querySelector<HTMLElement>(`#${box.getAttribute("aria-controls")} [data-entity-id="${id}"]`);
  if (!option) throw new Error(`No entity option ${JSON.stringify(id)} in the ${label} picker`);
  fireEvent.click(option);
}
/** The option labels the open picker shows (opens it first). */
export function entityOptionNames(label: string): string[] {
  const box = entityCombobox(label);
  if (box.getAttribute("aria-expanded") !== "true") fireEvent.click(box);
  return Array.from(document.querySelectorAll(`#${box.getAttribute("aria-controls")} [role="option"]`)).map((o) => o.querySelector("span span")?.textContent ?? "");
}
