// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SECTION_COMPONENTS, type BuilderOptions } from "@/features/events/builder/EventBuilder";
import { AdvancedSection } from "@/features/events/builder/sections/AdvancedSection";
import type { SaveDocument } from "@/features/events/builder/use-event-draft";
import { whenMatches } from "@/features/events/builder/template/value";
import { parseEventDocument } from "@/lib/events/document/parse";
import { emptyEventDocument, SECURITY_SCHEME_TYPES, type DocSecurityScheme, type EventDocument } from "@/lib/events/document/types";
import { TEMPLATES } from "@/lib/events/templates";
import { ENTITY_OPTIONS, renderBuilder, renderSection, sampleDocument } from "./builder-harness";

// The Messages section (opened by one shell test) draws entity pickers whose version list goes through a server action.
const h = vi.hoisted(() => ({ listPinnableVersionsAction: vi.fn() }));
vi.mock("@/features/events/pin-actions", () => ({ listPinnableVersionsAction: h.listPinnableVersionsAction }));

beforeEach(() => {
  vi.clearAllMocks();
  h.listPinnableVersionsAction.mockResolvedValue({ success: true, data: [] });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const OPTIONS: BuilderOptions = { entityOptions: ENTITY_OPTIONS, libraryTraits: [] };

const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const click = (testId: string) => fireEvent.click(screen.getByTestId(testId));
const box = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;
const select = (testId: string) => screen.getByTestId(testId) as HTMLSelectElement;
const button = (testId: string) => screen.getByTestId(testId) as HTMLButtonElement;
const text = (testId: string) => screen.getByTestId(testId).textContent;
const missing = (testId: string) => screen.queryByTestId(testId) === null;
const schemeOf = (doc: EventDocument, name: string) => doc.components?.securitySchemes?.[name] as DocSecurityScheme & Record<string, unknown>;
const names = (doc: EventDocument) => Object.keys(doc.components?.securitySchemes ?? {});
/** The spec of the local trait at `index`. */
const traitSpec = (doc: EventDocument, index: number) => (doc.traits[index] as unknown as { spec: Record<string, unknown> }).spec;

/**
 * Two schemes. `api-key` is used by server `kafka-prod`, operation `publishOrder` and the operation trait `secured`;
 * `basic` by `kafka-dev` only.
 */
function schemesDoc(): EventDocument {
  const doc = sampleDocument();
  doc.servers[0] = { ...doc.servers[0], security: ["api-key"] };
  doc.servers[1] = { ...doc.servers[1], security: ["basic"] };
  doc.operations[0] = { ...doc.operations[0], traitKeys: ["secured"], security: ["api-key"] };
  doc.traits = [{ key: "secured", kind: "OPERATION", spec: { title: "Secured", security: ["api-key"] } }];
  doc.components = {
    securitySchemes: { "api-key": { type: "httpApiKey", name: "X-API-Key", in: "header" }, basic: { type: "http", scheme: "basic" } },
  };
  return doc;
}

it("the fixture is a valid document, so any problem below comes from the edit under test", () => {
  expect(parseEventDocument(schemesDoc()).success).toBe(true);
});

it("is registered as the advanced section of the builder", () => {
  expect(SECTION_COMPONENTS.advanced).toBe(AdvancedSection);
});

it("the template offers exactly the thirteen scheme types the document model accepts", () => {
  const offered = TEMPLATES.securityScheme.fields.find((f) => f.key === "type")!.options!.map((o) => o.value);
  expect(offered).toEqual([...SECURITY_SCHEME_TYPES]);
  expect(offered).toHaveLength(13);
});

describe("AdvancedSection: empty state and add", () => {
  it("shows an empty state with the primary action when there are no schemes", () => {
    renderSection(AdvancedSection, { doc: sampleDocument(), options: OPTIONS });
    expect(text("scheme-empty")).toContain("No security schemes yet");
    expect(missing("scheme-add")).toBe(true);
    expect(missing("scheme-form")).toBe(true);
  });

  it("adds a scheme named `scheme` with a default type that needs nothing more, selects it and creates components", () => {
    const { probe } = renderSection(AdvancedSection, { doc: sampleDocument(), options: OPTIONS });
    click("scheme-empty-add");
    expect(probe.draft.doc.components).toEqual({ securitySchemes: { scheme: { type: "userPassword" } } });
    expect(probe.item).toBe("scheme");
    expect(box("scheme-key").value).toBe("scheme");
    expect(select("scheme-type").value).toBe("userPassword");
    expect(probe.draft.problems).toEqual([]);
    expect(missing("scheme-empty")).toBe(true);
  });

  it("the header button adds more schemes under names that never collide", () => {
    const { probe } = renderSection(AdvancedSection, { doc: sampleDocument(), options: OPTIONS });
    click("scheme-empty-add");
    click("scheme-add");
    click("scheme-add");
    expect(names(probe.draft.doc)).toEqual(["scheme", "scheme-2", "scheme-3"]);
    expect(probe.item).toBe("scheme-3");
    expect(screen.getByTestId("scheme-row-scheme-3").getAttribute("aria-current")).toBe("true");
  });

  it("keeps the other parts of components when the first scheme is added", () => {
    const doc = sampleDocument();
    doc.components = { parameters: { id: {} } };
    const { probe } = renderSection(AdvancedSection, { doc, options: OPTIONS });
    click("scheme-empty-add");
    expect(probe.draft.doc.components).toEqual({ parameters: { id: {} }, securitySchemes: { scheme: { type: "userPassword" } } });
  });
});

describe("AdvancedSection: list and selection", () => {
  it("lists the schemes by name with their type under it", () => {
    renderSection(AdvancedSection, { doc: schemesDoc(), options: OPTIONS });
    expect(text("scheme-row-api-key")).toContain("api-key");
    expect(text("scheme-row-api-key")).toContain("HTTP API key");
    expect(text("scheme-row-basic")).toContain("HTTP authentication");
  });

  it("opens the first scheme's form and selects another on click", () => {
    renderSection(AdvancedSection, { doc: schemesDoc(), options: OPTIONS });
    expect(screen.getByTestId("scheme-row-api-key").getAttribute("aria-current")).toBe("true");
    expect(box("scheme-key").value).toBe("api-key");
    click("scheme-row-basic");
    expect(screen.getByTestId("scheme-row-basic").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("scheme-row-api-key").hasAttribute("aria-current")).toBe(false);
    expect(box("scheme-key").value).toBe("basic");
    expect(box("scheme-scheme").value).toBe("basic");
  });

  it("opens the scheme named by the selected item and falls back to the first when it is gone", () => {
    renderSection(AdvancedSection, { doc: schemesDoc(), options: OPTIONS, item: "basic" });
    expect(box("scheme-key").value).toBe("basic");
    cleanup();
    renderSection(AdvancedSection, { doc: schemesDoc(), options: OPTIONS, item: "gone" });
    expect(box("scheme-key").value).toBe("api-key");
  });

  it("shows a problem dot on the row of a scheme the document reports a problem on", () => {
    const doc = schemesDoc();
    doc.components = { securitySchemes: { "api-key": { type: "httpApiKey", in: "header" }, basic: { type: "http", scheme: "basic" } } as never };
    renderSection(AdvancedSection, { doc, options: OPTIONS });
    expect(text("scheme-row-api-key")).toContain("has problems");
    expect(text("scheme-row-basic")).not.toContain("has problems");
  });
});

describe("AdvancedSection: the name is a visible, required field", () => {
  it("is labelled Name, marked required, and sits in the form without any disclosure to open", () => {
    renderSection(AdvancedSection, { doc: schemesDoc(), options: OPTIONS });
    const input = screen.getByLabelText("Name") as HTMLInputElement;
    expect(input).toBe(box("scheme-key"));
    expect(input.getAttribute("aria-required")).toBe("true");
    expect(text("scheme-key-required")).toBe("*");
    expect(input.closest("details")).toBeNull();
    expect(screen.getByTestId("scheme-form").contains(input)).toBe(true);
    expect(text("scheme-key-hint")).toContain("Renaming it updates them");
    expect(input.getAttribute("aria-describedby")).toContain("scheme-key-hint");
  });

  it("is not the template's 'Parameter name' of an HTTP API key: both exist, with different ids", () => {
    renderSection(AdvancedSection, { doc: schemesDoc(), options: OPTIONS });
    expect(box("scheme-name").value).toBe("X-API-Key");
    expect(screen.getByLabelText("Parameter name")).toBe(box("scheme-name"));
    expect(box("scheme-key").value).toBe("api-key");
  });

  it("commits a valid new name when focus leaves, and not while typing", () => {
    const { probe } = renderSection(AdvancedSection, { doc: schemesDoc(), options: OPTIONS });
    type(box("scheme-key"), "gateway-key");
    expect(names(probe.draft.doc)).toEqual(["api-key", "basic"]);
    fireEvent.blur(box("scheme-key"));
    expect(names(probe.draft.doc)).toEqual(["gateway-key", "basic"]);
    expect(probe.item).toBe("gateway-key");
    expect(screen.getByTestId("scheme-row-gateway-key").getAttribute("aria-current")).toBe("true");
  });

  it("commits on Enter too", () => {
    const { probe } = renderSection(AdvancedSection, { doc: schemesDoc(), options: OPTIONS });
    type(box("scheme-key"), "gateway-key");
    fireEvent.keyDown(box("scheme-key"), { key: "Enter" });
    expect(names(probe.draft.doc)).toEqual(["gateway-key", "basic"]);
  });

  it("keeps the order of the schemes and every property of the renamed one", () => {
    const { probe } = renderSection(AdvancedSection, { doc: schemesDoc(), options: OPTIONS, item: "basic" });
    type(box("scheme-key"), "http-basic");
    fireEvent.blur(box("scheme-key"));
    expect(Object.entries(probe.draft.doc.components!.securitySchemes!)).toEqual([
      ["api-key", { type: "httpApiKey", name: "X-API-Key", in: "header" }], ["http-basic", { type: "http", scheme: "basic" }],
    ]);
  });

  it("refuses a name another scheme already has, with a message, and keeps the old name", () => {
    const { probe } = renderSection(AdvancedSection, { doc: schemesDoc(), options: OPTIONS });
    type(box("scheme-key"), "basic");
    expect(text("scheme-key-error")).toBe('A security scheme named "basic" already exists.');
    expect(box("scheme-key").getAttribute("aria-invalid")).toBe("true");
    expect(box("scheme-key").getAttribute("aria-describedby")).toContain("scheme-key-error");
    fireEvent.blur(box("scheme-key"));
    expect(names(probe.draft.doc)).toEqual(["api-key", "basic"]);
    expect(probe.draft.dirty).toBe(false);
  });

  it("the uniqueness error goes away when the name is fixed", () => {
    renderSection(AdvancedSection, { doc: schemesDoc(), options: OPTIONS });
    type(box("scheme-key"), "basic");
    expect(missing("scheme-key-error")).toBe(false);
    type(box("scheme-key"), "basic-2");
    expect(missing("scheme-key-error")).toBe(true);
  });

  it("requires a name: an empty one is refused", () => {
    const { probe } = renderSection(AdvancedSection, { doc: schemesDoc(), options: OPTIONS });
    type(box("scheme-key"), "");
    expect(text("scheme-key-error")).toBe("A name is required.");
    fireEvent.blur(box("scheme-key"));
    expect(names(probe.draft.doc)).toEqual(["api-key", "basic"]);
  });

  it("refuses a name with a space, a reserved name and a name that is too long", () => {
    const { probe } = renderSection(AdvancedSection, { doc: schemesDoc(), options: OPTIONS });
    type(box("scheme-key"), "my scheme");
    expect(text("scheme-key-error")).toContain("no spaces");
    type(box("scheme-key"), "constructor");
    expect(text("scheme-key-error")).toContain("is reserved");
    type(box("scheme-key"), "x".repeat(65));
    expect(text("scheme-key-error")).toContain("at most 64");
    fireEvent.blur(box("scheme-key"));
    expect(names(probe.draft.doc)).toEqual(["api-key", "basic"]);
  });

  it("puts the committed name back on Escape", () => {
    renderSection(AdvancedSection, { doc: schemesDoc(), options: OPTIONS });
    type(box("scheme-key"), "half-typed");
    fireEvent.keyDown(box("scheme-key"), { key: "Escape" });
    expect(box("scheme-key").value).toBe("api-key");
    expect(missing("scheme-key-error")).toBe(true);
  });

  it("shows the name of the scheme that was selected, not what was typed for the previous one", () => {
    renderSection(AdvancedSection, { doc: schemesDoc(), options: OPTIONS });
    type(box("scheme-key"), "half-typed");
    click("scheme-row-basic");
    expect(box("scheme-key").value).toBe("basic");
    click("scheme-row-api-key");
    expect(box("scheme-key").value).toBe("api-key");
  });

  it("shows the problem the document has with a name it cannot use, and lets the user fix it", () => {
    const doc = sampleDocument();
    doc.components = { securitySchemes: { "my scheme": { type: "plain" } } };
    const { probe } = renderSection(AdvancedSection, { doc, options: OPTIONS });
    expect(text("scheme-key-error")).toContain('may only contain letters');
    type(box("scheme-key"), "my-scheme");
    fireEvent.blur(box("scheme-key"));
    expect(names(probe.draft.doc)).toEqual(["my-scheme"]);
    expect(probe.draft.problems).toEqual([]);
  });
});

describe("AdvancedSection: renaming rewrites the references", () => {
  it("rewrites servers[].security, operations[].security and a trait's spec.security", () => {
    const { probe } = renderSection(AdvancedSection, { doc: schemesDoc(), options: OPTIONS });
    type(box("scheme-key"), "gateway-key");
    fireEvent.blur(box("scheme-key"));
    const doc = probe.draft.doc;
    expect(doc.servers.map((s) => s.security)).toEqual([["gateway-key"], ["basic"]]);
    expect(doc.operations[0].security).toEqual(["gateway-key"]);
    expect(traitSpec(doc, 0).security).toEqual(["gateway-key"]);
    expect(parseEventDocument(doc).success).toBe(true);
  });

  it("leaves the references to other schemes alone", () => {
    const { probe } = renderSection(AdvancedSection, { doc: schemesDoc(), options: OPTIONS, item: "basic" });
    type(box("scheme-key"), "http-basic");
    fireEvent.blur(box("scheme-key"));
    expect(probe.draft.doc.servers.map((s) => s.security)).toEqual([["api-key"], ["http-basic"]]);
    expect(probe.draft.doc.operations[0].security).toEqual(["api-key"]);
    expect(parseEventDocument(probe.draft.doc).success).toBe(true);
  });

  it("a rename that is refused changes no reference", () => {
    const { probe } = renderSection(AdvancedSection, { doc: schemesDoc(), options: OPTIONS });
    type(box("scheme-key"), "basic");
    fireEvent.blur(box("scheme-key"));
    expect(probe.draft.doc).toEqual(schemesDoc());
  });
});

describe("AdvancedSection: the form follows the AsyncAPI security scheme template", () => {
  /** Test ids the form must show for `type`: every template field that applies to it, in the always-open basics group. */
  const applicable = (kind: string) => TEMPLATES.securityScheme.fields.filter((f) => whenMatches(f, { type: kind }));

  it.each([...SECURITY_SCHEME_TYPES])("a new %s scheme shows the type first and every property that type needs, required ones marked", (kind) => {
    const { probe } = renderSection(AdvancedSection, { doc: sampleDocument(), options: OPTIONS });
    click("scheme-empty-add");
    type(select("scheme-type"), kind);
    expect(schemeOf(probe.draft.doc, "scheme").type).toBe(kind);

    const form = screen.getByTestId("scheme-form");
    // the type select is the first template field in the form
    const controls = Array.from(form.querySelectorAll("[data-testid^='scheme-']")).map((e) => e.getAttribute("data-testid"));
    expect(controls.indexOf("scheme-type")).toBeGreaterThan(-1);
    expect(controls.indexOf("scheme-type")).toBeLessThan(controls.indexOf("scheme-description"));

    for (const f of applicable(kind)) {
      if (f.group === "basics") expect(screen.queryByTestId(`scheme-${f.key}`), `${kind}: ${f.key}`).not.toBeNull();
      expect(screen.queryByTestId(`scheme-${f.key}-required`) !== null, `${kind}: ${f.key} required marker`).toBe(Boolean(f.required));
    }
    // fields that belong to other types are not there
    for (const f of TEMPLATES.securityScheme.fields.filter((x) => !whenMatches(x, { type: kind }))) {
      expect(screen.queryByTestId(`scheme-${f.key}`), `${kind}: ${f.key} must be hidden`).toBeNull();
    }
    // the rest of what applies sits under More properties
    const more = applicable(kind).filter((f) => f.group === "more");
    if (more.length > 0) {
      click("scheme-more-toggle");
      for (const f of more) expect(screen.queryByTestId(`scheme-${f.key}`), `${kind}: ${f.key} under More properties`).not.toBeNull();
    } else {
      expect(missing("scheme-more-toggle")).toBe(true);
    }
  });

  it.each([...SECURITY_SCHEME_TYPES])("a new %s scheme tells the user what is still missing, and only that", (kind) => {
    const { probe } = renderSection(AdvancedSection, { doc: sampleDocument(), options: OPTIONS });
    click("scheme-empty-add");
    type(select("scheme-type"), kind);
    const requiredHere = applicable(kind).filter((f) => f.required && f.key !== "type").map((f) => f.key);
    const pointers = probe.draft.problems.map((p) => p.pointer.replace("/components/securitySchemes/scheme/", ""));
    expect(pointers.sort()).toEqual([...requiredHere].sort());
    for (const key of requiredHere) expect(screen.queryByTestId(`scheme-${key}-error`), `${kind}: ${key}`).not.toBeNull();
  });

  it("an HTTP API key becomes valid once its parameter name and location are given", () => {
    const { probe } = renderSection(AdvancedSection, { doc: sampleDocument(), options: OPTIONS });
    click("scheme-empty-add");
    type(select("scheme-type"), "httpApiKey");
    type(box("scheme-name"), "X-API-Key");
    type(select("scheme-in"), "header");
    expect(schemeOf(probe.draft.doc, "scheme")).toEqual({ type: "httpApiKey", name: "X-API-Key", in: "header" });
    expect(probe.draft.problems).toEqual([]);
  });

  it("a bearer HTTP scheme takes a token format; another scheme does not keep it", () => {
    const { probe } = renderSection(AdvancedSection, { doc: sampleDocument(), options: OPTIONS });
    click("scheme-empty-add");
    type(select("scheme-type"), "http");
    type(box("scheme-scheme"), "bearer");
    click("scheme-more-toggle");
    type(box("scheme-bearerFormat"), "JWT");
    expect(schemeOf(probe.draft.doc, "scheme")).toEqual({ type: "http", scheme: "bearer", bearerFormat: "JWT" });
    expect(probe.draft.problems).toEqual([]);
    type(select("scheme-type"), "userPassword");
    expect(schemeOf(probe.draft.doc, "scheme")).toEqual({ type: "userPassword" });
  });

  it("an OpenID Connect scheme takes a discovery URL and scopes", () => {
    const { probe } = renderSection(AdvancedSection, { doc: sampleDocument(), options: OPTIONS });
    click("scheme-empty-add");
    type(select("scheme-type"), "openIdConnect");
    type(box("scheme-openIdConnectUrl"), "https://auth.example.com/.well-known/openid-configuration");
    expect(schemeOf(probe.draft.doc, "scheme")).toEqual({ type: "openIdConnect", openIdConnectUrl: "https://auth.example.com/.well-known/openid-configuration" });
    expect(probe.draft.problems).toEqual([]);
  });

  it("an OAuth 2.0 scheme has its flows editable: URL, scopes and the flows the user opens", () => {
    const { probe } = renderSection(AdvancedSection, { doc: sampleDocument(), options: OPTIONS });
    click("scheme-empty-add");
    type(select("scheme-type"), "oauth2");
    expect(screen.getByTestId("scheme-flows-required")).toBeDefined();
    // all four flows are offered
    for (const flow of ["implicit", "password", "clientCredentials", "authorizationCode"]) expect(screen.queryByTestId(`scheme-flows-${flow}`), flow).not.toBeNull();
    type(box("scheme-flows-implicit-authorizationUrl"), "https://auth.example.com/authorize");
    click("scheme-flows-implicit-availableScopes-add");
    type(box("scheme-flows-implicit-availableScopes-0-key"), "read");
    type(box("scheme-flows-implicit-availableScopes-0-value"), "Read orders");
    expect(schemeOf(probe.draft.doc, "scheme")).toEqual({
      type: "oauth2",
      flows: { implicit: { authorizationUrl: "https://auth.example.com/authorize", availableScopes: { read: "Read orders" } } },
    });
    expect(probe.draft.problems).toEqual([]);
    // a second flow, with the URLs that flow needs
    type(box("scheme-flows-clientCredentials-tokenUrl"), "https://auth.example.com/token");
    click("scheme-flows-clientCredentials-availableScopes-add");
    type(box("scheme-flows-clientCredentials-availableScopes-0-key"), "write");
    expect(Object.keys(schemeOf(probe.draft.doc, "scheme").flows as object)).toEqual(["implicit", "clientCredentials"]);
    expect(probe.draft.problems).toEqual([]);
  });

  it("shows the flow-specific problems the parser reports under the flow's own field", () => {
    const { probe } = renderSection(AdvancedSection, { doc: sampleDocument(), options: OPTIONS });
    click("scheme-empty-add");
    type(select("scheme-type"), "oauth2");
    type(box("scheme-flows-implicit-authorizationUrl"), "not a url");
    expect(probe.draft.problems.length).toBeGreaterThan(0);
    expect(screen.getByTestId("scheme-flows-implicit-authorizationUrl").getAttribute("aria-invalid")).toBe("true");
  });

  it("writes the description for any type, keeps it when the type changes, and drops fields the new type does not use", () => {
    const { probe } = renderSection(AdvancedSection, { doc: sampleDocument(), options: OPTIONS });
    click("scheme-empty-add");
    type(select("scheme-type"), "httpApiKey");
    type(box("scheme-name"), "X-Key");
    type(select("scheme-in"), "query");
    type(box("scheme-description"), "Sent as a query parameter");
    expect(schemeOf(probe.draft.doc, "scheme")).toEqual({ type: "httpApiKey", name: "X-Key", in: "query", description: "Sent as a query parameter" });
    type(select("scheme-type"), "plain");
    expect(schemeOf(probe.draft.doc, "scheme")).toEqual({ type: "plain", description: "Sent as a query parameter" });
    expect(probe.draft.problems).toEqual([]);
  });

  it("keeps properties it has no field for (x- extensions) untouched when something else is edited", () => {
    const doc = sampleDocument();
    doc.components = { securitySchemes: { custom: { type: "plain", "x-owner": "platform" } } };
    const { probe } = renderSection(AdvancedSection, { doc, options: OPTIONS });
    type(box("scheme-description"), "SASL PLAIN");
    expect(schemeOf(probe.draft.doc, "custom")).toEqual({ type: "plain", "x-owner": "platform", description: "SASL PLAIN" });
    expect(text("scheme-other")).toContain("x-owner");
  });

  it("edits the selected scheme only", () => {
    const { probe } = renderSection(AdvancedSection, { doc: schemesDoc(), options: OPTIONS, item: "basic" });
    type(box("scheme-scheme"), "digest");
    expect(schemeOf(probe.draft.doc, "basic")).toEqual({ type: "http", scheme: "digest" });
    expect(schemeOf(probe.draft.doc, "api-key")).toEqual({ type: "httpApiKey", name: "X-API-Key", in: "header" });
  });
});

describe("AdvancedSection: used by", () => {
  it("names how many servers, operations and traits use the scheme", () => {
    renderSection(AdvancedSection, { doc: schemesDoc(), options: OPTIONS });
    expect(text("scheme-usage")).toBe("Used by 1 server, 1 operation and 1 trait");
    click("scheme-row-basic");
    expect(text("scheme-usage")).toBe("Used by 1 server");
  });

  it("says when nothing uses the scheme", () => {
    const doc = schemesDoc();
    doc.components!.securitySchemes!.spare = { type: "plain" };
    renderSection(AdvancedSection, { doc, options: OPTIONS, item: "spare" });
    expect(text("scheme-usage")).toBe("Not used by any server, operation or trait yet.");
  });

  it("follows an edit made elsewhere in the document", () => {
    const { probe } = renderSection(AdvancedSection, { doc: schemesDoc(), options: OPTIONS, item: "basic" });
    act(() => probe.draft.update((d) => ({ ...d, servers: d.servers.map((s) => ({ ...s, security: ["basic"] })) })));
    expect(text("scheme-usage")).toBe("Used by 2 servers");
  });
});

describe("AdvancedSection: removing", () => {
  it("removes a scheme nothing uses without asking and selects the first remaining one", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const doc = schemesDoc();
    doc.components!.securitySchemes!.spare = { type: "plain" };
    const { probe } = renderSection(AdvancedSection, { doc, options: OPTIONS, item: "spare" });
    click("scheme-remove");
    expect(confirm).not.toHaveBeenCalled();
    expect(names(probe.draft.doc)).toEqual(["api-key", "basic"]);
    expect(probe.item).toBeNull();
    expect(box("scheme-key").value).toBe("api-key");
  });

  it("asks before removing a scheme that is used, naming who uses it, then removes the references", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { probe } = renderSection(AdvancedSection, { doc: schemesDoc(), options: OPTIONS });
    click("scheme-remove");
    expect(confirm).toHaveBeenCalledTimes(1);
    const message = confirm.mock.calls[0][0] as string;
    expect(message).toContain('"api-key"');
    expect(message).toContain("1 server (kafka-prod)");
    expect(message).toContain("1 operation (publishOrder)");
    expect(message).toContain("1 trait (secured)");
    expect(names(probe.draft.doc)).toEqual(["basic"]);
    expect(probe.draft.doc.servers.map((s) => s.security)).toEqual([undefined, ["basic"]]);
    expect("security" in probe.draft.doc.operations[0]).toBe(false);
    expect("security" in traitSpec(probe.draft.doc, 0)).toBe(false);
    expect(traitSpec(probe.draft.doc, 0).title).toBe("Secured");
    expect(parseEventDocument(probe.draft.doc).success).toBe(true);
  });

  it("only takes the removed scheme out of a list that names others too", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const doc = schemesDoc();
    doc.servers[0] = { ...doc.servers[0], security: ["api-key", "basic"] };
    const { probe } = renderSection(AdvancedSection, { doc, options: OPTIONS, item: "basic" });
    click("scheme-remove");
    expect(probe.draft.doc.servers.map((s) => s.security)).toEqual([["api-key"], undefined]);
    expect(parseEventDocument(probe.draft.doc).success).toBe(true);
  });

  it("changes nothing when the confirmation is declined", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { probe } = renderSection(AdvancedSection, { doc: schemesDoc(), options: OPTIONS });
    click("scheme-remove");
    expect(probe.draft.doc).toEqual(schemesDoc());
    expect(probe.draft.dirty).toBe(false);
  });

  it("drops securitySchemes and components when the last scheme is removed, so the saved document has neither", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const doc = sampleDocument();
    doc.components = { securitySchemes: { only: { type: "plain" } } };
    const { probe } = renderSection(AdvancedSection, { doc, options: OPTIONS });
    click("scheme-remove");
    expect("components" in probe.draft.doc).toBe(false);
    expect(JSON.stringify(probe.draft.doc)).not.toContain("components");
    expect(JSON.stringify(probe.draft.doc)).not.toContain("securitySchemes");
    expect(text("scheme-empty")).toContain("No security schemes yet");
    expect(parseEventDocument(probe.draft.doc).success).toBe(true);
    expect(probe.draft.dirty).toBe(true);
  });

  it("drops securitySchemes but keeps the other components when the last scheme is removed", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const doc = sampleDocument();
    doc.components = { parameters: { id: {} }, securitySchemes: { only: { type: "plain" } } };
    const { probe } = renderSection(AdvancedSection, { doc, options: OPTIONS });
    click("scheme-remove");
    expect(probe.draft.doc.components).toEqual({ parameters: { id: {} } });
  });

  it("adding a scheme and removing it again leaves a document equal to the one it started from", () => {
    const { probe } = renderSection(AdvancedSection, { doc: sampleDocument(), options: OPTIONS });
    click("scheme-empty-add");
    click("scheme-remove");
    expect(probe.draft.doc).toEqual(sampleDocument());
    expect(probe.draft.dirty).toBe(false);
  });
});

describe("AdvancedSection: problems that belong to no one scheme", () => {
  it("shows a problem about components itself at the top of the section", () => {
    const doc = sampleDocument();
    doc.components = "nope" as unknown as EventDocument["components"];
    renderSection(AdvancedSection, { doc, options: OPTIONS });
    expect(text("advanced-problems")).toBe("components must be an object");
    expect(text("scheme-empty")).toContain("No security schemes yet");
  });

  it("says nothing when there is no such problem", () => {
    renderSection(AdvancedSection, { doc: schemesDoc(), options: OPTIONS });
    expect(missing("advanced-problems")).toBe(true);
  });
});

describe("EventBuilder: the Advanced section in the shell", () => {
  it("is the content of the Advanced outline node, with the number of schemes as its count", () => {
    const { probe } = renderBuilder({ doc: schemesDoc(), options: OPTIONS });
    expect(text("outline-count-advanced")).toBe("2");
    click("outline-advanced");
    expect(probe.section).toBe("advanced");
    expect(screen.getByTestId("section-advanced")).toBeDefined();
    expect(screen.getByTestId("outline-advanced").getAttribute("aria-current")).toBe("true");
  });

  it("counts zero for a document without schemes and follows an added scheme", () => {
    renderBuilder({ doc: sampleDocument(), options: OPTIONS, section: "advanced" });
    expect(text("outline-count-advanced")).toBe("0");
    click("scheme-empty-add");
    expect(text("outline-count-advanced")).toBe("1");
  });

  it("shows a problem badge on Advanced for a scheme with a missing required field, and clears it when filled", () => {
    renderBuilder({ doc: sampleDocument(), options: OPTIONS, section: "advanced" });
    click("scheme-empty-add");
    expect(screen.queryByTestId("outline-problems-advanced")).toBeNull();
    type(select("scheme-type"), "httpApiKey");
    expect(screen.getByTestId("outline-problems-advanced").textContent).toContain("2");
    type(box("scheme-name"), "X-Key");
    type(select("scheme-in"), "header");
    expect(screen.queryByTestId("outline-problems-advanced")).toBeNull();
  });

  it("a scheme added here is offered to servers and operations by its name, and a rename follows", () => {
    renderBuilder({ doc: sampleDocument(), options: OPTIONS, section: "advanced" });
    click("scheme-empty-add");
    type(box("scheme-key"), "gateway-key");
    fireEvent.blur(box("scheme-key"));
    click("outline-servers");
    click("server-more-toggle");
    click("server-security-option-gateway-key");
    click("outline-advanced");
    expect(text("scheme-usage")).toBe("Used by 1 server");
  });

  it("lists a failed save's scheme problems and jumps to the scheme", async () => {
    const saveDocument = vi.fn<SaveDocument>().mockResolvedValue({
      success: false, error: "1 problem(s) in the event document", code: "VALIDATION_ERROR",
      details: { problems: [{ pointer: "/components/securitySchemes/basic/scheme", message: "scheme is required" }] },
    });
    const { probe } = renderBuilder({ doc: schemesDoc(), options: OPTIONS, saveDocument });
    type(screen.getByTestId("metadata-title"), "Orders v2");
    await act(async () => { fireEvent.click(button("builder-save")); });
    const alert = within(screen.getByRole("alert"));
    fireEvent.click(alert.getByRole("button", { name: "Advanced · basic: scheme is required" }));
    expect(probe.section).toBe("advanced");
    expect(probe.item).toBe("basic");
    expect(screen.getByTestId("scheme-row-basic").getAttribute("aria-current")).toBe("true");
  });

  it("saves the scheme through the shell, and a document without schemes saves without any components key", async () => {
    const { probe } = renderBuilder({ doc: emptyEventDocument("Orders"), options: OPTIONS, section: "advanced" });
    click("scheme-empty-add");
    type(select("scheme-type"), "plain");
    await act(async () => { fireEvent.click(button("builder-save")); });
    expect(probe.saveDocument.mock.calls[0][2]).toMatchObject({ components: { securitySchemes: { scheme: { type: "plain" } } } });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    click("scheme-remove");
    await act(async () => { fireEvent.click(button("builder-save")); });
    expect(probe.saveDocument).toHaveBeenCalledTimes(2);
    expect(probe.saveDocument.mock.calls[1][2]).not.toHaveProperty("components");
  });
});
