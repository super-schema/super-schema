// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { field, renderField } from "./harness";

afterEach(cleanup);

const box = () => screen.getByTestId("f-thing") as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });

describe("markdown control", () => {
  it("is a textarea with a visible label, showing the value", () => {
    renderField(field("markdown"), { value: { thing: "# Title\n\nbody" } });
    const el = screen.getByLabelText("Thing") as HTMLTextAreaElement;
    expect(el).toBe(box());
    expect(el.tagName).toBe("TEXTAREA");
    expect(el.value).toBe("# Title\n\nbody");
  });

  it("writes typed text and removes the key when it is cleared", () => {
    const { probe } = renderField(field("markdown"));
    type("Some **text**");
    expect(probe.value).toEqual({ thing: "Some **text**" });
    type("");
    expect(probe.value).toEqual({});
  });

  it("starts on Write with a Write / Preview toggle that reports which view is on", () => {
    renderField(field("markdown"));
    expect(screen.getByTestId("f-thing-write").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("f-thing-preview-toggle").getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("f-thing-preview")).toBeNull();
  });

  it("Preview renders the markdown safely and hides the textarea; Write brings it back with the text intact", () => {
    renderField(field("markdown"), { value: { thing: "Hello **world**\n\n- one\n- two\n\n[docs](https://example.com) <script>x</script>" } });
    fireEvent.click(screen.getByTestId("f-thing-preview-toggle"));
    const preview = screen.getByTestId("f-thing-preview");
    expect(preview.querySelector("strong")?.textContent).toBe("world");
    expect(preview.querySelectorAll("li")).toHaveLength(2);
    expect(preview.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    expect(preview.querySelector("script")).toBeNull();
    expect(preview.textContent).toContain("<script>x</script>");
    expect(box().hidden).toBe(true);
    expect(screen.getByTestId("f-thing-preview-toggle").getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByTestId("f-thing-write"));
    expect(screen.queryByTestId("f-thing-preview")).toBeNull();
    expect(box().hidden).toBe(false);
    expect(box().value).toContain("Hello **world**");
  });

  it("Preview of nothing says there is nothing to preview", () => {
    renderField(field("markdown"));
    fireEvent.click(screen.getByTestId("f-thing-preview-toggle"));
    expect(screen.getByTestId("f-thing-preview").textContent).toBe("Nothing to preview yet.");
  });

  it("keeps the label wired to the textarea while previewing", () => {
    renderField(field("markdown"), { value: { thing: "x" } });
    fireEvent.click(screen.getByTestId("f-thing-preview-toggle"));
    expect(screen.getByLabelText("Thing")).toBe(box());
  });

  it("marks required, shows help and the error like every control", () => {
    renderField(field("markdown", { required: true, help: "What it means." }), { errors: [{ pointer: "/thing", message: "Too short" }] });
    expect(box().getAttribute("aria-required")).toBe("true");
    expect(box().getAttribute("aria-invalid")).toBe("true");
    expect(box().getAttribute("aria-describedby")).toBe("f-thing-error f-thing-hint");
    expect(screen.getByTestId("f-thing-hint").textContent).toBe("What it means.");
    expect(screen.getByTestId("f-thing-error").textContent).toBe("Too short");
  });

  it("is disabled with the form, including the toggle's effect on text", () => {
    renderField(field("markdown"), { disabled: true });
    expect(box().disabled).toBe(true);
  });
});
