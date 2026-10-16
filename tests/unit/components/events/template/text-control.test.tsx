// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EMAIL_PROBLEM, URL_PROBLEM } from "@/features/events/builder/template/controls/validate";
import { field, renderField } from "./harness";

afterEach(cleanup);

const input = () => screen.getByTestId("f-thing") as HTMLInputElement;
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });

describe("text control", () => {
  it("shows the value, a visible label wired to the input, and the test id", () => {
    renderField(field("text"), { value: { thing: "hello" } });
    const el = screen.getByLabelText("Thing") as HTMLInputElement;
    expect(el).toBe(input());
    expect(el.tagName).toBe("INPUT");
    expect(el.value).toBe("hello");
    expect(el.id).toBe("f-thing");
  });

  it("writes what the user types", () => {
    const { probe } = renderField(field("text"));
    type("kafka.example.com");
    expect(probe.value).toEqual({ thing: "kafka.example.com" });
  });

  it("removes the key when the text is cleared, so no empty string is ever written", () => {
    const { probe } = renderField(field("text"), { value: { thing: "x", "x-keep": 1 } });
    type("");
    expect(probe.value).toEqual({ "x-keep": 1 });
    expect("thing" in probe.value).toBe(false);
  });

  it("uses the placeholder, or an example when there is no placeholder", () => {
    renderField(field("text", { placeholder: "orders.created", example: "ignored" }));
    expect(input().placeholder).toBe("orders.created");
    cleanup();
    renderField(field("text", { example: "user/{userId}/signedup" }));
    expect(input().placeholder).toBe("e.g. user/{userId}/signedup");
  });

  it("offers suggestions in a datalist while still accepting free text", () => {
    const { probe } = renderField(field("text", { suggestions: ["kafka", "mqtt", "amqp"] }));
    expect(input().getAttribute("list")).toBe("f-thing-options");
    const options = Array.from(document.querySelectorAll("#f-thing-options option")).map((o) => o.getAttribute("value"));
    expect(options).toEqual(["kafka", "mqtt", "amqp"]);
    type("my-own-protocol");
    expect(probe.value).toEqual({ thing: "my-own-protocol" });
  });

  it("has no datalist without suggestions", () => {
    renderField(field("text"));
    expect(input().hasAttribute("list")).toBe(false);
    expect(document.querySelector("datalist")).toBeNull();
  });

  it("marks a required field with * (hidden from assistive tech) and aria-required on the control", () => {
    renderField(field("text", { required: true }));
    expect(input().getAttribute("aria-required")).toBe("true");
    const marker = screen.getByTestId("f-thing-required");
    expect(marker.textContent).toBe("*");
    expect(marker.getAttribute("aria-hidden")).toBe("true");
    // the marker stays outside the label, so the label text (and the accessible name) is just "Thing"
    expect(screen.getByText("Thing").tagName).toBe("LABEL");
  });

  it("shows no marker on an optional field", () => {
    renderField(field("text"));
    expect(screen.queryByTestId("f-thing-required")).toBeNull();
    expect(input().hasAttribute("aria-required")).toBe(false);
  });

  it("shows the help text under the control and links it with aria-describedby", () => {
    renderField(field("text", { help: "The host name, with a port if needed." }));
    expect(screen.getByTestId("f-thing-hint").textContent).toBe("The host name, with a port if needed.");
    expect(input().getAttribute("aria-describedby")).toBe("f-thing-hint");
  });

  it("shows an inline error for a problem at the field's pointer, linked and flagged invalid", () => {
    renderField(field("text", { help: "help" }), { errors: [{ pointer: "/thing", message: "Host is required" }] });
    expect(screen.getByTestId("f-thing-error").textContent).toBe("Host is required");
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(input().getAttribute("aria-describedby")).toBe("f-thing-error f-thing-hint");
  });

  it("is not flagged invalid when there is no problem", () => {
    renderField(field("text"));
    expect(input().hasAttribute("aria-invalid")).toBe(false);
    expect(screen.queryByTestId("f-thing-error")).toBeNull();
  });

  it("is disabled when the form is", () => {
    renderField(field("text"), { disabled: true });
    expect(input().disabled).toBe(true);
  });
});

describe("url control", () => {
  it("shows no message before the user leaves the field, even for a bad address", () => {
    renderField(field("url"));
    type("not a url");
    expect(screen.queryByTestId("f-thing-validation")).toBeNull();
  });

  it("on blur, explains that an address must be an absolute http(s) URL", () => {
    renderField(field("url"));
    type("example.com/docs");
    fireEvent.blur(input());
    expect(screen.getByTestId("f-thing-validation").textContent).toBe(URL_PROBLEM);
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(input().getAttribute("aria-describedby")).toContain("f-thing-validation");
  });

  it.each(["javascript:alert(1)", "ftp://example.com", "/relative/path", "https://", "http:// spaced.com"])("rejects %s", (bad) => {
    renderField(field("url"));
    type(bad);
    fireEvent.blur(input());
    expect(screen.getByTestId("f-thing-validation")).toBeTruthy();
  });

  it.each(["https://example.com", "http://localhost:3000/docs?x=1#top", "HTTPS://Example.com/A"])("accepts %s", (good) => {
    renderField(field("url"));
    type(good);
    fireEvent.blur(input());
    expect(screen.queryByTestId("f-thing-validation")).toBeNull();
    expect(input().hasAttribute("aria-invalid")).toBe(false);
  });

  it("re-validates live after the first blur: the message goes away once the address is fixed", () => {
    renderField(field("url"));
    type("example.com");
    fireEvent.blur(input());
    expect(screen.getByTestId("f-thing-validation")).toBeTruthy();
    type("https://example.com");
    expect(screen.queryByTestId("f-thing-validation")).toBeNull();
    type("https://");
    expect(screen.getByTestId("f-thing-validation")).toBeTruthy();
  });

  it("an empty optional address is fine", () => {
    renderField(field("url"));
    fireEvent.blur(input());
    expect(screen.queryByTestId("f-thing-validation")).toBeNull();
  });

  it("still writes what was typed, so the text is never lost (the document check reports it too)", () => {
    const { probe } = renderField(field("url"));
    type("example.com");
    expect(probe.value).toEqual({ thing: "example.com" });
  });
});

describe("email control", () => {
  it("rejects a malformed address on blur", () => {
    renderField(field("email"));
    type("jane@");
    fireEvent.blur(input());
    expect(screen.getByTestId("f-thing-validation").textContent).toBe(EMAIL_PROBLEM);
  });

  it.each(["jane", "jane@example", "jane doe@example.com", "@example.com", "a@b@c.com"])("rejects %s", (bad) => {
    renderField(field("email"));
    type(bad);
    fireEvent.blur(input());
    expect(screen.getByTestId("f-thing-validation")).toBeTruthy();
  });

  it.each(["jane@example.com", "jane.doe+tag@sub.example.co.uk"])("accepts %s", (good) => {
    const { probe } = renderField(field("email"));
    type(good);
    fireEvent.blur(input());
    expect(screen.queryByTestId("f-thing-validation")).toBeNull();
    expect(probe.value).toEqual({ thing: good });
  });

  it("uses an email input type so mobile keyboards help", () => {
    renderField(field("email"));
    expect(input().type).toBe("email");
  });

  it("shows a server-side error next to the validation message when both apply", () => {
    renderField(field("email"), { errors: [{ pointer: "/thing", message: "Not accepted" }] });
    type("bad");
    fireEvent.blur(input());
    expect(screen.getByTestId("f-thing-error").textContent).toBe("Not accepted");
    expect(screen.getByTestId("f-thing-validation").textContent).toBe(EMAIL_PROBLEM);
  });
});
