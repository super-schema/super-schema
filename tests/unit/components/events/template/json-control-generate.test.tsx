// @vitest-environment jsdom
// tests/unit/components/events/template/json-control-generate.test.tsx
// The "Generate from payload" button of JsonControl on its own (the editor stays a textarea here: no CodeMirror stand-ins). The generator
// is a lazy chunk, so the first click takes a moment: the button is off meanwhile, a second click is ignored, and the example never
// overwrites text that was typed in the meantime. While the entity's schema is still being rendered the hint says so.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonControl } from "@/features/events/builder/template/controls/JsonControl";
import type { ControlProps } from "@/features/events/builder/template/controls/types";
import type { Result } from "@/types/result";

const h = vi.hoisted(() => ({ exampleFromSchema: vi.fn() }));
vi.mock("@/lib/events/example-from-schema", () => ({ exampleFromSchema: h.exampleFromSchema }));

type Schema = Record<string, unknown>;
const ORDER: Schema = { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] };
const GENERATED = { orderId: "string" };
const FIELD = { key: "payload", label: "Payload", kind: "json", group: "basics" } as ControlProps["field"];

function deferred() {
  let resolve!: (result: Result<unknown>) => void;
  const promise = new Promise<Result<unknown>>((r) => { resolve = r; });
  return { promise, resolve };
}
const answer = (data: unknown): Result<unknown> => ({ success: true, data });

function mount(over: Partial<ControlProps> = {}) {
  const onChange = vi.fn();
  const props: ControlProps = {
    field: FIELD, id: "f", value: undefined, onChange, required: false, invalid: false, path: "/messages/0/examples/0/payload",
    renderFields: () => null, schema: ORDER, context: { pinSchemas: { payload: ORDER, headers: null } }, ...over,
  };
  const utils = render(<JsonControl {...props} />);
  return { ...utils, onChange, props };
}
const generate = () => screen.getByTestId("f-generate") as HTMLButtonElement;
const box = () => screen.getByTestId("f") as HTMLTextAreaElement;
const type = (value: string) => fireEvent.change(box(), { target: { value } });

beforeEach(() => {
  vi.clearAllMocks();
  h.exampleFromSchema.mockReturnValue(answer(GENERATED));
});
afterEach(() => cleanup());

describe("JsonControl: Generate while the example is being built", () => {
  it("turns the button off while it works, ignores a second click, and writes the example once; the button is back and has the focus", async () => {
    const pending = deferred();
    h.exampleFromSchema.mockReturnValue(pending.promise);
    const { onChange } = mount();
    expect(generate().disabled).toBe(false);
    fireEvent.click(generate());
    await waitFor(() => expect(generate().disabled).toBe(true));
    fireEvent.click(generate());
    fireEvent.click(generate());
    await act(async () => {});
    expect(h.exampleFromSchema).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();

    await act(async () => pending.resolve(answer(GENERATED)));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(GENERATED));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(box().value).toBe(JSON.stringify(GENERATED, null, 2));
    await waitFor(() => expect(generate().disabled).toBe(false));
    expect(document.activeElement).toBe(generate());
  });

  it("does not overwrite text typed while the example was being built, and does not take the focus from the user", async () => {
    const pending = deferred();
    h.exampleFromSchema.mockReturnValue(pending.promise);
    const { onChange } = mount();
    fireEvent.click(generate());
    await waitFor(() => expect(generate().disabled).toBe(true));
    box().focus();
    type('{"mine": 1}');
    expect(onChange).toHaveBeenLastCalledWith({ mine: 1 });
    onChange.mockClear();

    await act(async () => pending.resolve(answer(GENERATED)));
    await waitFor(() => expect(generate().disabled).toBe(false));
    expect(box().value).toBe('{"mine": 1}');
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(box());
    expect(screen.queryByTestId("f-generate-error")).toBeNull();
  });

  it("does not overwrite text typed while a REPLACE was being built either", async () => {
    const pending = deferred();
    h.exampleFromSchema.mockReturnValue(pending.promise);
    const { onChange } = mount({ value: { old: true } });
    fireEvent.click(generate());
    fireEvent.click(screen.getByTestId("f-generate-replace"));
    await waitFor(() => expect(generate().disabled).toBe(true));
    type('{"newer": 2}');
    onChange.mockClear();
    await act(async () => pending.resolve(answer(GENERATED)));
    await waitFor(() => expect(generate().disabled).toBe(false));
    expect(box().value).toBe('{"newer": 2}');
    expect(onChange).not.toHaveBeenCalled();
  });

  it("turns the button back on after a failure too, with the message", async () => {
    const pending = deferred();
    h.exampleFromSchema.mockReturnValue(pending.promise);
    const { onChange } = mount();
    fireEvent.click(generate());
    await waitFor(() => expect(generate().disabled).toBe(true));
    await act(async () => pending.resolve({ success: false, error: { code: "EXAMPLE_FAILED", message: "no" } }));
    await waitFor(() => expect(generate().disabled).toBe(false));
    expect(screen.getByTestId("f-generate-error").textContent).toBe("Could not generate an example from this schema.");
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("JsonControl: the hint while Generate has no schema", () => {
  const hint = () => screen.getByTestId("f-generate-hint").textContent;

  it("says 'Loading the schema…' while the pinned schema is still being rendered, and the button is off", () => {
    mount({ schema: null, context: { pinSchemas: { payload: null }, pinSchemasLoading: { payload: true } } });
    expect(hint()).toBe("Loading the schema…");
    expect(generate().disabled).toBe(true);
  });

  it("says 'Needs a payload entity with a schema.' only when there is truly no schema coming", () => {
    mount({ schema: null, context: { pinSchemas: { payload: null }, pinSchemasLoading: { payload: false } } });
    expect(hint()).toBe("Needs a payload entity with a schema.");
    cleanup();
    mount({ schema: null, context: { pinSchemas: { payload: null } } });
    expect(hint()).toBe("Needs a payload entity with a schema.");
  });

  it("asks about the field's own role: the headers example is not 'loading' because the payload is", () => {
    mount({
      schema: null, path: "/messages/0/examples/0/headers",
      context: { pinSchemas: { payload: null, headers: null }, pinSchemasLoading: { payload: true, headers: false } },
    });
    expect(hint()).toBe("Needs a headers entity with a schema.");
    cleanup();
    mount({
      schema: null, path: "/messages/0/examples/0/headers",
      context: { pinSchemas: { payload: ORDER, headers: null }, pinSchemasLoading: { payload: false, headers: true } },
    });
    expect(hint()).toBe("Loading the schema…");
  });

  it("goes when the schema arrives, and the button works", () => {
    const { rerender, props } = mount({ schema: null, context: { pinSchemas: { payload: null }, pinSchemasLoading: { payload: true } } });
    rerender(<JsonControl {...props} schema={ORDER} context={{ pinSchemas: { payload: ORDER }, pinSchemasLoading: { payload: false } }} />);
    expect(screen.queryByTestId("f-generate-hint")).toBeNull();
    expect(generate().disabled).toBe(false);
  });
});
