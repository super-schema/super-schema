// @vitest-environment jsdom
// Render-everything smoke test: every object template and every binding template renders, every field has an accessible label,
// and every field key appears exactly once. This is the guard that "all AsyncAPI properties are available as a form" is a tested
// claim in the UI too, not only in the catalog.
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TemplateForm } from "@/features/events/builder/template";
import { whenMatches } from "@/features/events/builder/template/value";
import {
  BINDING_PROTOCOLS, bindingTemplate, TEMPLATES, type BindingTarget, type FieldTemplate, type ObjectTemplate,
} from "@/lib/events/templates";

// The entity picker's default version loader is a server action: keep it out of the test process.
vi.mock("@/features/events/pin-actions", () => ({ listPinnableVersionsAction: vi.fn() }));

afterEach(cleanup);

const TARGETS: BindingTarget[] = ["server", "channel", "operation", "message"];
const noop = () => {};

/** A value with one item in every list and every object present, so the nested fields exist in the DOM. */
function sampleValue(fields: FieldTemplate[], seed: Record<string, unknown> = {}): Record<string, unknown> {
  const value: Record<string, unknown> = { ...seed };
  for (const f of fields) {
    if (f.kind === "object" && f.fields && !(f.key in value)) {
      value[f.key] = sampleValue(f.fields);
    } else if (f.kind === "list" && f.fields && !(f.key in value)) {
      const item = sampleValue(f.fields);
      value[f.key] = f.mapKeyLabel ? { sample: item } : [item];
    }
  }
  return value;
}

/** The test ids a form must show for `fields` given `value`: one per visible field, recursing into objects and list items. */
function expectedIds(prefix: string, fields: FieldTemplate[], value: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const f of fields) {
    if (!whenMatches(f, value)) continue;
    const id = `${prefix}-${f.key}`;
    ids.push(id);
    const own = value[f.key];
    if (f.kind === "object" && f.fields) {
      ids.push(...expectedIds(id, f.fields, (own ?? {}) as Record<string, unknown>));
    } else if (f.kind === "list" && f.fields) {
      const items = f.mapKeyLabel ? Object.values((own ?? {}) as Record<string, unknown>) : ((own ?? []) as unknown[]);
      items.forEach((item, index) => ids.push(...expectedIds(`${id}-${index}`, f.fields!, item as Record<string, unknown>)));
    }
  }
  return ids;
}

/** Why `el` has no accessible label, or null when it has one. */
function labelProblem(el: Element): string | null {
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
    const labels = Array.from((el as HTMLInputElement).labels ?? []);
    return labels.some((l) => (l.textContent ?? "").trim() !== "") ? null : "no <label for> with text";
  }
  if (tag === "FIELDSET") {
    const legend = Array.from(el.children).find((c) => c.tagName === "LEGEND");
    return legend && (legend.textContent ?? "").replace("*", "").trim() !== "" ? null : "no <legend> with text";
  }
  // entity pin: a group wrapping the picker, whose own fieldset has the legend
  return el.querySelector("legend")?.textContent?.trim() ? null : "no legend inside the group";
}

async function checkForm(template: ObjectTemplate, value: Record<string, unknown>) {
  const { container } = render(<TemplateForm template={template} value={value} onChange={noop} idPrefix="x" defaultOpenMore />);
  // entity pickers load lazily
  await waitFor(() => expect(container.querySelectorAll('[data-testid$="-loading"]')).toHaveLength(0));
  const ids = expectedIds("x", template.fields, value);
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) {
    const matches = container.querySelectorAll(`[data-testid="${id}"]`);
    expect(matches.length, `${template.id}: ${id} should appear exactly once`).toBe(1);
    expect(labelProblem(matches[0]), `${template.id}: ${id}`).toBeNull();
  }
  // element ids are what labels point at: they must be unique in the document
  const elementIds = Array.from(container.querySelectorAll("[id]")).map((e) => e.id);
  const duplicates = elementIds.filter((id, i) => elementIds.indexOf(id) !== i);
  expect(duplicates, `${template.id}: duplicate element ids`).toEqual([]);
  return ids;
}

describe("render everything: AsyncAPI object templates", () => {
  const templates = Object.values(TEMPLATES);
  const cases = templates.map((t) => [t.id, t] as const);

  it("has the templates the catalog promises", () => {
    expect(templates.map((t) => t.id).sort()).toEqual([
      "channel", "channelParameter", "contact", "correlationId", "externalDocs", "info", "license", "message", "messageExample",
      "messageTrait", "operation", "operationReply", "operationReplyAddress", "operationTrait", "securityScheme", "server",
      "serverVariable", "tag",
    ]);
  });

  it.each(cases)("%s renders with an empty value: every visible field once, each labelled", async (_id, template) => {
    await checkForm(template, {});
  });

  it.each(cases)("%s renders with one item in every list and every object present", async (_id, template) => {
    const ids = await checkForm(template, sampleValue(template.fields));
    // without conditions, every top-level key of the template is shown
    if (!template.fields.some((f) => f.when)) {
      for (const f of template.fields) expect(ids, `${template.id}.${f.key}`).toContain(`x-${f.key}`);
    }
  });

  it("every property of the security scheme shows up for some type", async () => {
    const seen = new Set<string>();
    const types = TEMPLATES.securityScheme.fields.find((f) => f.key === "type")!.options!.map((o) => o.value);
    for (const type of types) {
      const ids = await checkForm(TEMPLATES.securityScheme, sampleValue(TEMPLATES.securityScheme.fields, { type }));
      for (const id of ids) seen.add(id);
      cleanup();
    }
    for (const f of TEMPLATES.securityScheme.fields) expect(seen.has(`x-${f.key}`), f.key).toBe(true);
  });

  it("the message template shows all three entity pins once the group is open", async () => {
    const { findAllByLabelText } = render(<TemplateForm template={TEMPLATES.message} value={{}} onChange={noop} idPrefix="m" defaultOpenMore />);
    expect((await findAllByLabelText(/ entity$/)).length).toBe(3);
  });
});

describe("render everything: protocol binding templates", () => {
  const cases = BINDING_PROTOCOLS.flatMap((protocol) =>
    TARGETS.flatMap((target) => {
      const template = bindingTemplate(protocol, target);
      return template ? [[`${protocol} ${target}`, template] as const] : [];
    }),
  );

  it("covers every protocol the catalog ships, at least one target each", () => {
    expect(cases.length).toBeGreaterThanOrEqual(BINDING_PROTOCOLS.length);
    for (const protocol of BINDING_PROTOCOLS) expect(cases.some(([name]) => name.startsWith(`${protocol} `)), protocol).toBe(true);
  });

  it.each(cases)("%s renders with an empty value", async (_name, template) => {
    await checkForm(template, {});
  });

  it.each(cases)("%s renders with one item in every list and every object present", async (_name, template) => {
    await checkForm(template, sampleValue(template.fields));
  });
});
