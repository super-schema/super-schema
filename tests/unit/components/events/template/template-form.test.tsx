// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEMPLATES, type FieldTemplate } from "@/lib/events/templates";
import { field, renderForm, template } from "./harness";

// The entity picker's default version loader is a server action: keep it out of the test process.
vi.mock("@/features/events/pin-actions", () => ({ listPinnableVersionsAction: vi.fn() }));

afterEach(cleanup);

const el = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;
const type = (testId: string, text: string) => fireEvent.change(el(testId), { target: { value: text } });
const toggle = (prefix = "f") => screen.getByTestId(`${prefix}-more-toggle`);

describe("TemplateForm with the real server template", () => {
  it("renders a labelled field for every basics property, in template order", () => {
    renderForm(TEMPLATES.server);
    const basics = TEMPLATES.server.fields.filter((f) => f.group === "basics");
    for (const f of basics) expect(screen.getByLabelText(f.label), f.key).toBe(el(`f-${f.key}`));
    const order = basics.map((f) => f.key);
    const domOrder = Array.from(document.querySelectorAll('[data-testid^="f-"]'))
      .map((n) => n.getAttribute("data-testid")!)
      .filter((id) => order.some((k) => id === `f-${k}`));
    expect(domOrder).toEqual(order.map((k) => `f-${k}`));
  });

  it("filling host and protocol hands back exactly those two values", () => {
    const { probe } = renderForm(TEMPLATES.server);
    type("f-host", "kafka.example.com:9092");
    type("f-protocol", "kafka");
    expect(probe.value).toEqual({ host: "kafka.example.com:9092", protocol: "kafka" });
    expect(probe.onChange).toHaveBeenCalledTimes(2);
    expect(probe.onChange).toHaveBeenLastCalledWith({ host: "kafka.example.com:9092", protocol: "kafka" });
  });

  it("never calls onChange just for rendering", () => {
    const { probe } = renderForm(TEMPLATES.server, { value: { host: "h", protocol: "kafka" } });
    expect(probe.onChange).not.toHaveBeenCalled();
  });

  it("marks exactly the required properties (host, protocol) and nothing else", () => {
    renderForm(TEMPLATES.server, { defaultOpenMore: true });
    const required = TEMPLATES.server.fields.filter((f) => f.required).map((f) => f.key);
    expect(required).toEqual(["host", "protocol"]);
    for (const f of TEMPLATES.server.fields) {
      const marker = screen.queryByTestId(`f-${f.key}-required`);
      expect(marker !== null, f.key).toBe(Boolean(f.required));
    }
    expect(el("f-host").getAttribute("aria-required")).toBe("true");
    expect(el("f-protocol").getAttribute("aria-required")).toBe("true");
    expect(el("f-title").hasAttribute("aria-required")).toBe(false);
  });

  it("shows each property's help text under it, wired with aria-describedby", () => {
    renderForm(TEMPLATES.server);
    const host = TEMPLATES.server.fields.find((f) => f.key === "host")!;
    expect(screen.getByTestId("f-host-hint").textContent).toBe(host.help);
    expect(el("f-host").getAttribute("aria-describedby")).toContain("f-host-hint");
  });

  it("uses idPrefix for every id and test id", () => {
    renderForm(TEMPLATES.server, { idPrefix: "srv-prod" });
    expect(el("srv-prod-host").id).toBe("srv-prod-host");
    expect(screen.queryByTestId("f-host")).toBeNull();
    expect(screen.getByTestId("srv-prod-more-toggle")).toBeTruthy();
  });

  it("offers the protocol as free text with the known protocols as suggestions", () => {
    renderForm(TEMPLATES.server);
    expect(el("f-protocol").getAttribute("list")).toBe("f-protocol-options");
    const options = Array.from(document.querySelectorAll("#f-protocol-options option")).map((o) => o.getAttribute("value"));
    expect(options).toContain("kafka");
    expect(options).toContain("googlepubsub");
  });

  it("disables every control when the form is disabled", () => {
    renderForm(TEMPLATES.server, { disabled: true, defaultOpenMore: true });
    // Only the buttons that change what is shown (open a group, preview markdown) stay usable in a read-only form.
    const viewOnly = (testId: string | null) => Boolean(testId && /-(more-toggle|write|preview-toggle)$/.test(testId));
    for (const control of document.querySelectorAll("input, select, textarea, button")) {
      expect((control as HTMLInputElement).disabled || viewOnly(control.getAttribute("data-testid")), control.outerHTML.slice(0, 80)).toBeTruthy();
    }
  });
});

describe("TemplateForm: basics and More properties", () => {
  const MORE_KEYS = TEMPLATES.server.fields.filter((f) => f.group === "more").map((f) => f.key);

  it("hides the more properties until the group is opened", () => {
    renderForm(TEMPLATES.server);
    for (const key of MORE_KEYS) expect(screen.queryByTestId(`f-${key}`), key).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().textContent).toBe("More properties (0 set)");
  });

  it("opens and closes the group with its button, which reports the state", () => {
    renderForm(TEMPLATES.server);
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(toggle().getAttribute("aria-controls")).toBe("f-more");
    for (const key of MORE_KEYS) expect(screen.getByTestId(`f-${key}`), key).toBeTruthy();
    expect(within(screen.getByTestId("f-more")).getByLabelText("Summary")).toBe(el("f-summary"));
    fireEvent.click(toggle());
    expect(screen.queryByTestId("f-summary")).toBeNull();
  });

  it("counts the more properties that are set, and opens by itself when any is", () => {
    renderForm(TEMPLATES.server, { value: { host: "h", protocol: "kafka", summary: "S", tags: [{ name: "t" }] } });
    expect(toggle().textContent).toBe("More properties (2 set)");
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(el("f-summary").value).toBe("S");
  });

  it("does not count basics, empty values or unknown keys", () => {
    renderForm(TEMPLATES.server, { value: { host: "h", protocol: "kafka", summary: "", "x-owner": "a" } });
    expect(toggle().textContent).toBe("More properties (0 set)");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("the count follows edits made in the group", () => {
    renderForm(TEMPLATES.server);
    fireEvent.click(toggle());
    expect(toggle().textContent).toBe("More properties (0 set)");
    type("f-summary", "A summary");
    expect(toggle().textContent).toBe("More properties (1 set)");
    type("f-summary", "");
    expect(toggle().textContent).toBe("More properties (0 set)");
    // it stays open: the user opened it
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
  });

  it("defaultOpenMore opens it from the start", () => {
    renderForm(TEMPLATES.server, { defaultOpenMore: true });
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    for (const key of MORE_KEYS) expect(screen.getByTestId(`f-${key}`), key).toBeTruthy();
  });

  it("opens when a problem points into it, so the user can see the error", () => {
    renderForm(TEMPLATES.server, { errors: [{ pointer: "/summary", message: "Too long" }] });
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("f-summary-error").textContent).toBe("Too long");
  });

  it("a user who closes the group keeps it closed even though a field in it is set", () => {
    renderForm(TEMPLATES.server, { value: { summary: "S" } });
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().textContent).toBe("More properties (1 set)");
  });

  it("opens the group from the start when the template has no basics at all", () => {
    renderForm(template([field("text", { key: "only", label: "Only", group: "more" })]));
    expect(screen.getByTestId("f-only")).toBeTruthy();
  });

  it("has no More properties button when there are no more properties", () => {
    renderForm(template([field("text", { key: "a", label: "A" })]));
    expect(screen.queryByTestId("f-more-toggle")).toBeNull();
  });

  it("the more group is a labelled group for assistive tech", () => {
    renderForm(TEMPLATES.server, { defaultOpenMore: true });
    expect(screen.getByRole("group", { name: "More properties (0 set)" }).getAttribute("data-testid")).toBe("f-more");
  });

  it("passes defaultOpenMore down to nested objects", () => {
    renderForm(TEMPLATES.info, { defaultOpenMore: true });
    // info.contact is an object; every nested group is open, and so is the tags control
    expect(screen.getByTestId("f-contact-name")).toBeTruthy();
    expect(screen.getByTestId("f-license-name")).toBeTruthy();
    expect(screen.getByTestId("f-externalDocs-url")).toBeTruthy();
    expect(screen.getByTestId("f-termsOfService")).toBeTruthy();
  });
});

describe("TemplateForm: errors", () => {
  it("shows a problem under the field whose pointer is errorPrefix/key, and only there", () => {
    renderForm(TEMPLATES.server, {
      errorPrefix: "/servers/prod",
      errors: [
        { pointer: "/servers/prod/host", message: "Host is required" },
        { pointer: "/servers/dev/host", message: "belongs to another server" },
        { pointer: "/servers/prod/hostname", message: "not the host field" },
        { pointer: "/info/title", message: "elsewhere" },
      ],
    });
    expect(screen.getByTestId("f-host-error").textContent).toBe("Host is required");
    expect(el("f-host").getAttribute("aria-invalid")).toBe("true");
    expect(el("f-protocol").hasAttribute("aria-invalid")).toBe(false);
    expect(screen.queryByText("belongs to another server")).toBeNull();
    expect(screen.queryByText("not the host field")).toBeNull();
    expect(screen.queryByText("elsewhere")).toBeNull();
  });

  it("without an errorPrefix a pointer is /key", () => {
    renderForm(TEMPLATES.server, { errors: [{ pointer: "/protocol", message: "Unknown protocol" }] });
    expect(screen.getByTestId("f-protocol-error").textContent).toBe("Unknown protocol");
  });

  it("joins several problems for one field", () => {
    renderForm(TEMPLATES.server, { errors: [{ pointer: "/host", message: "First." }, { pointer: "/host", message: "Second." }] });
    expect(screen.getByTestId("f-host-error").textContent).toBe("First. Second.");
  });

  it("reaches nested fields through the nested pointer", () => {
    renderForm(TEMPLATES.info, { defaultOpenMore: true, errorPrefix: "/info", errors: [{ pointer: "/info/contact/email", message: "Bad email" }] });
    expect(screen.getByTestId("f-contact-email-error").textContent).toBe("Bad email");
  });
});

describe("TemplateForm: hideKeys", () => {
  it("does not render fields the caller draws itself", () => {
    renderForm(TEMPLATES.server, { hideKeys: ["host", "summary"], defaultOpenMore: true });
    expect(screen.queryByTestId("f-host")).toBeNull();
    expect(screen.queryByTestId("f-summary")).toBeNull();
    expect(screen.getByTestId("f-protocol")).toBeTruthy();
  });

  it("keeps the hidden field's value untouched when another field changes, and does not list it under Other properties", () => {
    const { probe } = renderForm(TEMPLATES.server, { hideKeys: ["host"], value: { host: "kept.example.com", protocol: "kafka" } });
    expect(screen.queryByTestId("f-other")).toBeNull();
    type("f-protocol", "mqtt");
    expect(probe.value).toEqual({ host: "kept.example.com", protocol: "mqtt" });
  });

  it("does not count a hidden more field in the count", () => {
    renderForm(TEMPLATES.server, { hideKeys: ["summary"], value: { summary: "S" } });
    expect(toggle().textContent).toBe("More properties (0 set)");
  });
});

describe("TemplateForm: properties it does not know", () => {
  const VALUE = { host: "h", protocol: "kafka", "x-owner": "payments", futureProperty: { deep: [1] } };

  it("passes them through untouched on every change, including when a field is cleared", () => {
    const { probe } = renderForm(TEMPLATES.server, { value: VALUE });
    type("f-host", "new.example.com");
    expect(probe.value).toEqual({ ...VALUE, host: "new.example.com" });
    type("f-host", "");
    expect(probe.value).toEqual({ protocol: "kafka", "x-owner": "payments", futureProperty: { deep: [1] } });
  });

  it("lists their names in a read-only Other properties line", () => {
    renderForm(TEMPLATES.server, { value: VALUE });
    const line = screen.getByTestId("f-other");
    expect(line.textContent).toBe("Other properties (kept as they are): x-owner, futureProperty");
    expect(line.querySelector("input, textarea, select, button")).toBeNull();
  });

  it("shows no such line when there are none", () => {
    renderForm(TEMPLATES.server, { value: { host: "h" } });
    expect(screen.queryByTestId("f-other")).toBeNull();
  });

  it("keeps unknown keys inside a nested object too", () => {
    const { probe } = renderForm(TEMPLATES.info, { value: { title: "T", contact: { name: "N", "x-slack": "#help" } }, defaultOpenMore: true });
    expect(screen.getByTestId("f-contact-other").textContent).toContain("x-slack");
    type("f-contact-name", "M");
    expect(probe.value).toEqual({ title: "T", contact: { name: "M", "x-slack": "#help" } });
  });

  it("an object holding only unknown keys is not removed when its last known field is cleared", () => {
    const { probe } = renderForm(TEMPLATES.info, { value: { title: "T", contact: { name: "N", "x-slack": "#help" } }, defaultOpenMore: true });
    type("f-contact-name", "");
    expect(probe.value).toEqual({ title: "T", contact: { "x-slack": "#help" } });
  });
});

describe("TemplateForm: conditional fields (`when`)", () => {
  const SECURITY = TEMPLATES.securityScheme;
  const keys = () => ["name", "in", "scheme", "bearerFormat", "flows", "scopes", "openIdConnectUrl"].filter((k) => screen.queryByTestId(`f-${k}`));

  it("shows only the always-on fields until a type is chosen", () => {
    renderForm(SECURITY, { defaultOpenMore: true });
    expect(keys()).toEqual([]);
    expect(screen.getByTestId("f-type")).toBeTruthy();
    expect(screen.getByTestId("f-description")).toBeTruthy();
  });

  it.each([
    ["httpApiKey", ["name", "in"]],
    ["apiKey", ["in"]],
    ["http", ["scheme", "bearerFormat"]],
    ["oauth2", ["flows", "scopes"]],
    ["openIdConnect", ["scopes", "openIdConnectUrl"]],
    ["plain", []],
  ])("type %s shows %j", (type_, expected) => {
    renderForm(SECURITY, { defaultOpenMore: true, value: { type: type_ } });
    expect(keys()).toEqual(expected);
  });

  it("shows and hides fields as the type changes", () => {
    renderForm(SECURITY, { defaultOpenMore: true });
    fireEvent.change(screen.getByTestId("f-type"), { target: { value: "http" } });
    expect(keys()).toEqual(["scheme", "bearerFormat"]);
    fireEvent.change(screen.getByTestId("f-type"), { target: { value: "oauth2" } });
    expect(keys()).toEqual(["flows", "scopes"]);
  });

  it("drops the values of fields the new type hides, so the output is valid for the type", () => {
    const { probe } = renderForm(SECURITY, { defaultOpenMore: true, value: { type: "httpApiKey", name: "X-Key", in: "header", description: "d" } });
    fireEvent.change(screen.getByTestId("f-type"), { target: { value: "http" } });
    expect(probe.value).toEqual({ type: "http", description: "d" });
  });

  it("keeps the values of fields the new type still shows", () => {
    const { probe } = renderForm(SECURITY, { defaultOpenMore: true, value: { type: "apiKey", in: "user" } });
    fireEvent.change(screen.getByTestId("f-type"), { target: { value: "httpApiKey" } });
    expect(probe.value).toEqual({ type: "httpApiKey", in: "user" });
  });

  it("leaves a hidden field's stale value alone when something else changes", () => {
    const { probe } = renderForm(SECURITY, { value: { type: "http", name: "stale" } });
    type("f-description", "d");
    expect(probe.value).toEqual({ type: "http", name: "stale", description: "d" });
  });

  it("marks a conditional field required only while it is shown", () => {
    renderForm(SECURITY, { value: { type: "httpApiKey" } });
    expect(screen.getByTestId("f-name-required")).toBeTruthy();
    expect(el("f-name").getAttribute("aria-required")).toBe("true");
  });

  it("does not count a hidden conditional field in the More properties count", () => {
    // `scopes` only applies to oauth2 and openIdConnect; `bearerFormat` keeps the group present for http
    renderForm(SECURITY, { value: { type: "http", scopes: ["a"] } });
    expect(toggle().textContent).toBe("More properties (0 set)");
  });
});

describe("TemplateForm: other template shapes", () => {
  it("gives a field of an unexpected kind no control but does not throw", () => {
    const odd = { key: "odd", label: "Odd", kind: "nope" as FieldTemplate["kind"], group: "basics" as const };
    expect(() => renderForm(template([odd]))).not.toThrow();
  });

  it("renders the message template's required entity pin and its optional ones", async () => {
    renderForm(TEMPLATES.message, { defaultOpenMore: true });
    expect(await screen.findByLabelText("Payload entity")).toBeTruthy();
    expect(await screen.findByLabelText("Headers entity")).toBeTruthy();
    expect(await screen.findByLabelText("Message key entity")).toBeTruthy();
  });

  it("works with the contact template alone", () => {
    const { probe } = renderForm(TEMPLATES.contact);
    type("f-email", "a@b.co");
    expect(probe.value).toEqual({ email: "a@b.co" });
  });
});
