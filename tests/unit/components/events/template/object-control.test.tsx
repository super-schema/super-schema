// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { field, renderField } from "./harness";

afterEach(cleanup);

const CONTACT = field("object", {
  key: "contact", label: "Contact", help: "Who to ask about this API.",
  fields: [
    field("text", { key: "name", label: "Name" }),
    field("email", { key: "email", label: "Email address" }),
    field("text", { key: "department", label: "Department", group: "more" }),
  ],
});

describe("object control", () => {
  it("is a bordered, labelled group (fieldset with a legend) holding the child fields", () => {
    renderField(CONTACT);
    const group = screen.getByRole("group", { name: "Contact" });
    expect(group.tagName).toBe("FIELDSET");
    expect(group.getAttribute("data-testid")).toBe("f-contact");
    expect(within(group).getByLabelText("Name")).toBe(screen.getByTestId("f-contact-name"));
    expect(within(group).getByLabelText("Email address")).toBe(screen.getByTestId("f-contact-email"));
    expect(screen.getByTestId("f-contact-hint").textContent).toBe("Who to ask about this API.");
  });

  it("names child ids from the parent: `${idPrefix}-${parent}-${child}`", () => {
    renderField(CONTACT);
    expect((screen.getByTestId("f-contact-name") as HTMLInputElement).id).toBe("f-contact-name");
  });

  it("writes the child values as one nested object", () => {
    const { probe } = renderField(CONTACT);
    fireEvent.change(screen.getByTestId("f-contact-name"), { target: { value: "API Support" } });
    expect(probe.value).toEqual({ contact: { name: "API Support" } });
    fireEvent.change(screen.getByTestId("f-contact-email"), { target: { value: "support@example.com" } });
    expect(probe.value).toEqual({ contact: { name: "API Support", email: "support@example.com" } });
  });

  it("removes the whole object when every child is empty", () => {
    const { probe } = renderField(CONTACT, { value: { contact: { name: "A" }, "x-keep": 1 } });
    fireEvent.change(screen.getByTestId("f-contact-name"), { target: { value: "" } });
    expect(probe.value).toEqual({ "x-keep": 1 });
    expect("contact" in probe.value).toBe(false);
  });

  it("keeps the other children when one is cleared", () => {
    const { probe } = renderField(CONTACT, { value: { contact: { name: "A", email: "a@b.co" } } });
    fireEvent.change(screen.getByTestId("f-contact-name"), { target: { value: "" } });
    expect(probe.value).toEqual({ contact: { email: "a@b.co" } });
  });

  it("applies the same basics / More properties grouping inside the object", () => {
    renderField(CONTACT);
    expect(screen.queryByTestId("f-contact-department")).toBeNull();
    fireEvent.click(screen.getByTestId("f-contact-more-toggle"));
    expect(screen.getByTestId("f-contact-department")).toBeTruthy();
  });

  it("keeps child properties the template does not know when a child changes", () => {
    const { probe } = renderField(CONTACT, { value: { contact: { name: "A", "x-slack": "#support" } } });
    fireEvent.change(screen.getByTestId("f-contact-name"), { target: { value: "B" } });
    expect(probe.value).toEqual({ contact: { name: "B", "x-slack": "#support" } });
  });

  it("shows an error at the object only for its own pointer, and a child's error at the child", () => {
    renderField(CONTACT, {
      errors: [
        { pointer: "/contact", message: "Contact is incomplete" },
        { pointer: "/contact/email", message: "Not an email" },
      ],
    });
    expect(screen.getByTestId("f-contact-error").textContent).toBe("Contact is incomplete");
    expect(screen.getByTestId("f-contact-email-error").textContent).toBe("Not an email");
    expect(screen.getByTestId("f-contact-email").getAttribute("aria-invalid")).toBe("true");
  });

  it("is required through the legend marker and a described-by note (aria-required is not valid on a group)", () => {
    renderField({ ...CONTACT, required: true });
    expect(screen.getByTestId("f-contact-required").getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByTestId("f-contact").getAttribute("aria-describedby")).toContain("f-contact-required-note");
    expect(screen.getByTestId("f-contact-required-note").textContent).toBe("Required");
    expect(screen.getByRole("group", { name: "Contact" })).toBeTruthy();
  });

  it("nests objects inside objects", () => {
    const outer = field("object", {
      key: "flows", label: "OAuth flows",
      fields: [field("object", { key: "implicit", label: "Implicit flow", fields: [field("url", { key: "authorizationUrl", label: "Authorization URL" })] })],
    });
    const { probe } = renderField(outer);
    fireEvent.change(screen.getByTestId("f-flows-implicit-authorizationUrl"), { target: { value: "https://example.com/auth" } });
    expect(probe.value).toEqual({ flows: { implicit: { authorizationUrl: "https://example.com/auth" } } });
  });

  it("disables every child with the form", () => {
    renderField(CONTACT, { disabled: true });
    expect((screen.getByTestId("f-contact-name") as HTMLInputElement).disabled).toBe(true);
  });
});
