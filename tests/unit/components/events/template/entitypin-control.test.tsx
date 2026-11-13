// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateFormContext } from "@/features/events/builder/template";
import type { EntityOption } from "@/features/events/shared/EntityPinPicker";
import { field, renderField } from "./harness";
import { entityOptionNames, entityValue, pickEntity } from "../helpers/pick-entity";

const ENTITY_OPTIONS: EntityOption[] = [
  { id: "ent-1", name: "OrderCreated", ownerLabel: "Payments / Checkout", latestVersionId: "ver-1", latestVersionLabel: "v1.0" },
  { id: "ent-2", name: "OrderCancelled", ownerLabel: "Payments / Checkout", latestVersionId: "ver-2", latestVersionLabel: "v1.0" },
];

// The picker's default version loader is a server action: keep it out of the test process.
const h = vi.hoisted(() => ({ listPinnableVersionsAction: vi.fn() }));
vi.mock("@/features/events/pin-actions", () => ({ listPinnableVersionsAction: h.listPinnableVersionsAction }));

beforeEach(() => {
  vi.clearAllMocks();
  h.listPinnableVersionsAction.mockResolvedValue({ success: true, data: [{ id: "ver-1", label: "1.0" }, { id: "ver-0", label: "0.9" }] });
});
afterEach(cleanup);

const loadVersions = vi.fn(async (entityId: string) => [{ id: `${entityId}-ver-9`, label: "9.0" }]);
const CONTEXT: TemplateFormContext = { entityOptions: ENTITY_OPTIONS };

const PAYLOAD = field("entityPin", { key: "payload", label: "Payload", required: true, help: "The entity that describes the message body." });
const HEADERS = field("entityPin", { key: "headers", label: "Headers", group: "more" });

/** The picker is loaded lazily and fetches versions on mount: wait for both before acting. */
async function settle(label = "Payload") {
  await screen.findByLabelText(`${label} entity`);
  await act(async () => {});
}

describe("entityPin control", () => {
  it("renders the existing entity picker lazily, inside a group that carries the test id", async () => {
    renderField(PAYLOAD, { context: CONTEXT });
    expect(screen.getByTestId("f-payload-loading")).toBeTruthy();
    await settle();
    const group = screen.getByTestId("f-payload");
    expect(group.getAttribute("role")).toBe("group");
    expect(group.contains(screen.getByLabelText("Payload entity"))).toBe(true);
    expect(screen.getByLabelText("Payload entity").textContent).toBe("Select an entity");
    expect(entityOptionNames("Payload")).toEqual(["OrderCreated", "OrderCancelled"]);
  });

  it("choosing an entity writes the pin (entity and its latest version)", async () => {
    const { probe } = renderField(PAYLOAD, { context: CONTEXT });
    await settle();
    pickEntity("Payload", "ent-2");
    expect(probe.value).toEqual({ payload: { entityId: "ent-2", entityVersionId: "ver-2" } });
  });

  it("shows the pin it is given and lets the user pick a version", async () => {
    const { probe } = renderField(PAYLOAD, { context: CONTEXT, value: { payload: { entityId: "ent-1", entityVersionId: "ver-1" } } });
    await settle();
    expect(entityValue("Payload")).toBe("ent-1");
    await act(async () => {});
    expect((screen.getByLabelText("Payload version") as HTMLSelectElement).value).toBe("ver-1");
    fireEvent.change(screen.getByLabelText("Payload version"), { target: { value: "ver-0" } });
    expect(probe.value).toEqual({ payload: { entityId: "ent-1", entityVersionId: "ver-0" } });
  });

  it("an optional pin can be cleared, which removes the key", async () => {
    const { probe } = renderField(HEADERS, { context: CONTEXT, value: { headers: { entityId: "ent-1", entityVersionId: "ver-1" } }, defaultOpenMore: true });
    await settle("Headers");
    expect(entityOptionNames("Headers")[0]).toBe("— none —");
    pickEntity("Headers", "");
    expect(probe.value).toEqual({});
  });

  it("a required pin has no 'none' choice once an entity is chosen", async () => {
    renderField(PAYLOAD, { context: CONTEXT, value: { payload: { entityId: "ent-1", entityVersionId: "ver-1" } } });
    await settle();
    expect(entityOptionNames("Payload")).toEqual(["OrderCreated", "OrderCancelled"]);
  });

  it("uses the context's version loader instead of the server action", async () => {
    renderField(PAYLOAD, { context: { ...CONTEXT, loadVersions }, value: { payload: { entityId: "ent-1", entityVersionId: "ent-1-ver-9" } } });
    await settle();
    await act(async () => {});
    expect(loadVersions).toHaveBeenCalledWith("ent-1");
    expect(h.listPinnableVersionsAction).not.toHaveBeenCalled();
    expect(screen.getByRole("option", { name: "v9.0" })).toBeTruthy();
  });

  it("says it is required in text (aria-required is not valid on a group), shows the help and the error", async () => {
    renderField(PAYLOAD, { context: CONTEXT, errors: [{ pointer: "/payload", message: "Pick an entity" }] });
    await settle();
    expect(screen.getByTestId("f-payload-required-note").textContent).toBe("Required");
    expect(screen.getByTestId("f-payload").getAttribute("aria-describedby")).toBe("f-payload-error f-payload-hint f-payload-required-note");
    expect(screen.getByTestId("f-payload-hint").textContent).toBe("The entity that describes the message body.");
    expect(screen.getByTestId("f-payload-error").textContent).toBe("Pick an entity");
  });

  it("copes with no entity options", async () => {
    renderField(PAYLOAD);
    await settle();
    expect(screen.getByLabelText("Payload entity").textContent).toBe("Select an entity");
    expect(entityOptionNames("Payload")).toEqual([]);
  });

  it("disables the picker with the form", async () => {
    renderField(PAYLOAD, { context: CONTEXT, disabled: true });
    await settle();
    expect((screen.getByLabelText("Payload entity") as HTMLButtonElement).disabled).toBe(true);
  });
});
