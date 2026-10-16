// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TEMPLATES, type FieldTemplate } from "@/lib/events/templates";
import { field, renderField } from "./harness";

afterEach(cleanup);

const input = () => screen.getByTestId("f-thing") as HTMLInputElement;
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
const press = (key: string) => fireEvent.keyDown(input(), { key });
const chips = () => Array.from(document.querySelectorAll('li[data-testid^="f-thing-chip-"]')).map((el) => el.querySelector("[data-chip-text]")?.textContent);
const paste = (text: string) => fireEvent.paste(input(), { clipboardData: { getData: () => text } });

describe("stringList control", () => {
  const LIST = field("stringList", { label: "Allowed values" });

  it("is a text input with a visible label, and shows the existing items as chips", () => {
    renderField(LIST, { value: { thing: ["production", "staging"] } });
    expect(screen.getByLabelText("Allowed values")).toBe(input());
    expect(chips()).toEqual(["production", "staging"]);
  });

  it("Enter adds the typed text as a chip and clears the input", () => {
    const { probe } = renderField(LIST);
    type("production");
    press("Enter");
    expect(probe.value).toEqual({ thing: ["production"] });
    expect(input().value).toBe("");
    type("staging");
    press("Enter");
    expect(probe.value).toEqual({ thing: ["production", "staging"] });
    expect(chips()).toEqual(["production", "staging"]);
  });

  it("a comma adds the chip too, without typing the comma into the input", () => {
    const { probe } = renderField(LIST);
    type("one");
    const notPrevented = fireEvent.keyDown(input(), { key: "," });
    expect(notPrevented).toBe(false);
    expect(probe.value).toEqual({ thing: ["one"] });
    expect(input().value).toBe("");
  });

  it("Enter never submits an enclosing form", () => {
    renderField(LIST);
    type("one");
    expect(fireEvent.keyDown(input(), { key: "Enter" })).toBe(false);
  });

  it("Enter on an empty input does nothing", () => {
    const { probe } = renderField(LIST);
    press("Enter");
    expect(probe.onChange).not.toHaveBeenCalled();
  });

  it("adds the pending text when the input loses focus, so typed text is never lost", () => {
    const { probe } = renderField(LIST);
    type("kept");
    fireEvent.blur(input());
    expect(probe.value).toEqual({ thing: ["kept"] });
    expect(input().value).toBe("");
  });

  it("trims the text and ignores whitespace-only input", () => {
    const { probe } = renderField(LIST);
    type("   ");
    press("Enter");
    expect(probe.onChange).not.toHaveBeenCalled();
    type("  spaced  ");
    press("Enter");
    expect(probe.value).toEqual({ thing: ["spaced"] });
  });

  it("does not add a duplicate", () => {
    const { probe } = renderField(LIST, { value: { thing: ["a"] } });
    type("a");
    press("Enter");
    expect(probe.value).toEqual({ thing: ["a"] });
    expect(chips()).toEqual(["a"]);
    expect(input().value).toBe("");
  });

  it("splits pasted text on commas and newlines and adds every piece", () => {
    const { probe } = renderField(LIST);
    paste("alpha, beta\ngamma,, delta\r\n");
    expect(probe.value).toEqual({ thing: ["alpha", "beta", "gamma", "delta"] });
    expect(input().value).toBe("");
  });

  it("leaves a paste without separators to the browser (it lands in the input)", () => {
    const { probe } = renderField(LIST);
    expect(paste("single")).toBe(true);
    expect(probe.onChange).not.toHaveBeenCalled();
  });

  it("pasted pieces skip items that are already there", () => {
    const { probe } = renderField(LIST, { value: { thing: ["a"] } });
    paste("a, b");
    expect(probe.value).toEqual({ thing: ["a", "b"] });
  });

  it("removes a chip with its labelled button, and the key when the last one goes", () => {
    const { probe } = renderField(LIST, { value: { thing: ["a", "b"] } });
    fireEvent.click(screen.getByRole("button", { name: "Remove value a" }));
    expect(probe.value).toEqual({ thing: ["b"] });
    fireEvent.click(screen.getByRole("button", { name: "Remove value b" }));
    expect(probe.value).toEqual({});
    expect(chips()).toEqual([]);
  });

  it("chip buttons are real buttons the keyboard can reach", () => {
    renderField(LIST, { value: { thing: ["a"] } });
    const button = screen.getByRole("button", { name: "Remove value a" }) as HTMLButtonElement;
    expect(button.tagName).toBe("BUTTON");
    expect(button.type).toBe("button");
    expect(button.tabIndex).not.toBe(-1);
  });

  it("offers the template's suggestions in a datalist", () => {
    renderField(field("stringList", { suggestions: ["GET", "POST"] }));
    expect(input().getAttribute("list")).toBe("f-thing-options");
    expect(Array.from(document.querySelectorAll("#f-thing-options option")).map((o) => o.getAttribute("value"))).toEqual(["GET", "POST"]);
  });

  it("marks required, shows help and the error, and is disabled with the form", () => {
    renderField(field("stringList", { required: true, help: "Press Enter after each." }), { errors: [{ pointer: "/thing", message: "Needs one" }], disabled: true, value: { thing: ["a"] } });
    expect(input().getAttribute("aria-required")).toBe("true");
    expect(input().getAttribute("aria-describedby")).toBe("f-thing-error f-thing-hint");
    expect(input().disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Remove value a" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("an error on one item shows at the list", () => {
    renderField(LIST, { errors: [{ pointer: "/thing/1", message: "Second value is not allowed" }], value: { thing: ["a", "b"] } });
    expect(screen.getByTestId("f-thing-error").textContent).toBe("Second value is not allowed");
  });
});

describe("tags control", () => {
  const TAGS: FieldTemplate = TEMPLATES.info.fields.find((f) => f.key === "tags")!;
  const tagField = { ...TAGS, group: "basics" as const };

  it("shows tag objects as chips named by their name", () => {
    renderField(tagField, { value: { tags: [{ name: "orders" }, { name: "billing", description: "Money" }] }, idPrefix: "f" });
    expect(screen.getByLabelText("Tags")).toBeTruthy();
    expect(Array.from(document.querySelectorAll('li[data-testid^="f-tags-chip-"] [data-chip-text]')).map((e) => e.textContent)).toEqual(["orders", "billing"]);
  });

  it("adds a tag as an object with a name, and removes it by name", () => {
    const { probe } = renderField(tagField);
    const tagInput = screen.getByTestId("f-tags") as HTMLInputElement;
    fireEvent.change(tagInput, { target: { value: "orders" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });
    expect(probe.value).toEqual({ tags: [{ name: "orders" }] });
    fireEvent.change(tagInput, { target: { value: "billing" } });
    fireEvent.keyDown(tagInput, { key: "," });
    expect(probe.value).toEqual({ tags: [{ name: "orders" }, { name: "billing" }] });
    fireEvent.click(screen.getByRole("button", { name: "Remove tag orders" }));
    expect(probe.value).toEqual({ tags: [{ name: "billing" }] });
    fireEvent.click(screen.getByRole("button", { name: "Remove tag billing" }));
    expect(probe.value).toEqual({});
  });

  it("pasting several tags adds them all and keeps the details of tags already there", () => {
    const { probe } = renderField(tagField, { value: { tags: [{ name: "a", description: "Kept" }] } });
    const tagInput = screen.getByTestId("f-tags") as HTMLInputElement;
    fireEvent.paste(tagInput, { clipboardData: { getData: () => "a, b, c" } });
    expect(probe.value).toEqual({ tags: [{ name: "a", description: "Kept" }, { name: "b" }, { name: "c" }] });
  });

  it("each tag has details (description and external docs) behind a button, so they are available but out of the way", () => {
    const { probe } = renderField(tagField, { value: { tags: [{ name: "orders" }] } });
    expect(screen.queryByTestId("f-tags-0-description")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Edit details of tag orders" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    // the tag's name is the chip, so it is not repeated as a field
    expect(screen.queryByTestId("f-tags-0-name")).toBeNull();
    fireEvent.change(screen.getByTestId("f-tags-0-description"), { target: { value: "Everything about orders" } });
    expect(probe.value).toEqual({ tags: [{ name: "orders", description: "Everything about orders" }] });
    // external docs come with the details
    expect(screen.getByTestId("f-tags-0-externalDocs")).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.queryByTestId("f-tags-0-description")).toBeNull();
  });

  it("a tag whose details are set shows that on its button", () => {
    renderField(tagField, { value: { tags: [{ name: "orders", description: "x" }, { name: "plain" }] } });
    expect(screen.getByRole("button", { name: "Edit details of tag orders" }).getAttribute("data-has-details")).toBe("true");
    expect(screen.getByRole("button", { name: "Edit details of tag plain" }).getAttribute("data-has-details")).toBe("false");
  });

  it("an error inside a tag's details shows on that field", () => {
    renderField(tagField, { value: { tags: [{ name: "orders", externalDocs: { url: "nope" } }] }, errors: [{ pointer: "/tags/0/externalDocs/url", message: "Not a URL" }] });
    fireEvent.click(screen.getByRole("button", { name: "Edit details of tag orders" }));
    expect(within(screen.getByTestId("f-tags-0-externalDocs")).getByTestId("f-tags-0-externalDocs-url-error").textContent).toBe("Not a URL");
  });

  it("without a nested template, tags are plain strings", () => {
    const { probe } = renderField({ key: "thing", label: "Thing", kind: "tags", group: "basics" });
    type("x");
    press("Enter");
    expect(probe.value).toEqual({ thing: ["x"] });
  });
});
