// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { InfoTip } from "@/features/events/builder/template/InfoTip";
import { field, renderForm, template } from "./template/harness";

afterEach(cleanup);

const tip = () => document.getElementById("t") as HTMLElement;

describe("InfoTip", () => {
  it("is a button with an aria-label, described by a tooltip that is always in the DOM and hidden until asked for", () => {
    render(<InfoTip id="t" label="About Summary">A one-line summary.</InfoTip>);
    const button = screen.getByRole("button", { name: "About Summary" });
    expect(button.getAttribute("aria-describedby")).toBe("t");
    expect(tip().getAttribute("role")).toBe("tooltip");
    expect(tip().textContent).toBe("A one-line summary.");
    expect(tip().hasAttribute("hidden")).toBe(true);
  });

  it("shows on focus and hides on blur", () => {
    render(<InfoTip id="t" label="About X">help</InfoTip>);
    const button = screen.getByRole("button", { name: "About X" });
    fireEvent.focus(button);
    expect(tip().hasAttribute("hidden")).toBe(false);
    fireEvent.blur(button);
    expect(tip().hasAttribute("hidden")).toBe(true);
  });

  it("shows on hover and keeps showing while the pointer is over the tip, and hides when it leaves", () => {
    render(<InfoTip id="t" label="About X">help</InfoTip>);
    const wrapper = screen.getByRole("button", { name: "About X" }).parentElement as HTMLElement;
    fireEvent.mouseEnter(wrapper);
    expect(tip().hasAttribute("hidden")).toBe(false);
    fireEvent.mouseLeave(wrapper);
    expect(tip().hasAttribute("hidden")).toBe(true);
  });

  it("toggles on click (touch) and closes with Escape", () => {
    render(<InfoTip id="t" label="About X">help</InfoTip>);
    const button = screen.getByRole("button", { name: "About X" });
    fireEvent.click(button);
    expect(tip().hasAttribute("hidden")).toBe(false);
    fireEvent.keyDown(button, { key: "Escape" });
    expect(tip().hasAttribute("hidden")).toBe(true);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(tip().hasAttribute("hidden")).toBe(true);
  });

  it("is a plain button that does not submit a form", () => {
    render(<InfoTip id="t" label="About X">help</InfoTip>);
    expect(screen.getByRole("button", { name: "About X" }).getAttribute("type")).toBe("button");
  });
});

describe("TemplateForm compactHelp", () => {
  const optional = field("text", { key: "summary", label: "Summary", help: "A one-line summary." });
  const required = field("text", { key: "name", label: "Name", help: "Required help stays inline.", required: true });

  it("moves the help of an optional field behind an info button that keeps the hint id", () => {
    renderForm(template([optional]), { compactHelp: true });
    expect(screen.getByRole("button", { name: "About Summary" }).getAttribute("aria-describedby")).toBe("f-summary-hint");
    expect(screen.getByTestId("f-summary-hint").getAttribute("role")).toBe("tooltip");
    expect(screen.getByTestId("f-summary-hint").textContent).toBe("A one-line summary.");
    // the control itself is described by the same text
    expect(screen.getByTestId("f-summary").getAttribute("aria-describedby")).toBe("f-summary-hint");
  });

  it("keeps the help of a required field inline, as a plain line", () => {
    renderForm(template([required]), { compactHelp: true });
    expect(screen.queryByRole("button", { name: /About/ })).toBeNull();
    const hint = screen.getByTestId("f-name-hint");
    expect(hint.tagName).toBe("P");
    expect(hint.hasAttribute("role")).toBe(false);
    expect(hint.textContent).toBe("Required help stays inline.");
  });

  it("works for a field in a group (fieldset) too", () => {
    renderForm(template([field("stringList", { key: "tags", label: "Tags", help: "Labels." })]), { compactHelp: true });
    expect(screen.getByRole("button", { name: "About Tags" })).toBeDefined();
    expect(screen.getByTestId("f-tags-hint").textContent).toBe("Labels.");
  });

  it("is off by default: the help stays a line under every field", () => {
    renderForm(template([optional, required]));
    expect(screen.queryByRole("button", { name: /About/ })).toBeNull();
    expect(screen.getByTestId("f-summary-hint").tagName).toBe("P");
    expect(screen.getByTestId("f-name-hint").tagName).toBe("P");
  });

  it("does not change what the field writes", () => {
    const { probe } = renderForm(template([optional]), { compactHelp: true });
    fireEvent.change(screen.getByTestId("f-summary"), { target: { value: "hello" } });
    expect(probe.value).toEqual({ summary: "hello" });
  });

  it("shows no button for a field without help", () => {
    renderForm(template([field("text", { key: "plain", label: "Plain" })]), { compactHelp: true });
    expect(screen.queryByRole("button", { name: /About/ })).toBeNull();
  });
});
