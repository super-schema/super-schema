// @vitest-environment jsdom
// The hover text of a schema property is TEXT: `codemirror-json-schema` renders a description as markdown into innerHTML, and a description
// is the schema author's (an imported AsyncAPI document brings third-party ones into entities), so `![x](https://third.party/p.png)` would
// make the browser fetch that URL on hover. `plainHover` is handed to the library as its `formatHover`; these tests pin both the formatter
// and that it is the one the editor's hover really uses (the REAL library, jsdom with the stand-ins of ./codemirror-jsdom).
import "./codemirror-jsdom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createEditor, plainHover, type EditorHandle, type EditorOptions } from "@/features/events/builder/template/controls/codemirror-setup";

// The first test pays the cold dynamic import of the setup and the schema library; under a loaded machine that exceeds the default 5 s.
vi.setConfig({ testTimeout: 30_000 });
beforeAll(async () => {
  await import("@/features/events/builder/template/controls/codemirror-setup");
  await import("codemirror-json-schema");
  await import("@codemirror/autocomplete");
}, 60_000);

const h = vi.hoisted(() => ({ hovers: [] as Array<(view: unknown, pos: number, side: 1 | -1) => Promise<{ create: (view: unknown) => { dom: HTMLElement } } | null>> }));
vi.mock("codemirror-json-schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("codemirror-json-schema")>();
  return {
    ...actual,
    // the hover source the editor installs, kept so a test can ask it for a tooltip without a mouse (jsdom has no layout to hover over)
    jsonSchemaHover: (...args: Parameters<typeof actual.jsonSchemaHover>) => {
      const hover = actual.jsonSchemaHover(...args);
      h.hovers.push(hover as unknown as (typeof h.hovers)[number]);
      return hover;
    },
  };
});

const OPTIONS: EditorOptions = {
  language: "json", readOnly: false, disabled: false, fill: false, id: "ed", ariaLabel: "Payload",
  invalid: false, required: false, describedBy: undefined, placeholder: undefined,
};

const IMAGE = "![x](http://localhost/p.png)";
const SCRIPTED = "<img src=x onerror=alert(1)> and <script>alert(2)</script>";
const DESCRIPTION = `Tracks the order. ${IMAGE}\n${SCRIPTED}\n[a link](https://example.com) **bold**`;

const handles: EditorHandle[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.destroy();
  document.body.innerHTML = "";
  h.hovers.length = 0;
});

/** The elements a tooltip may contain: plain containers and the code of the type, nothing that loads or runs or links. */
const tagsIn = (root: HTMLElement) => Array.from(root.querySelectorAll("*"), (element) => element.tagName);

describe("plainHover", () => {
  it("shows a description with an image link and HTML as literal text: no <img>, <script>, <a> or any element it did not make itself", () => {
    const dom = plainHover({ message: DESCRIPTION, typeInfo: "string" });
    expect(dom.querySelector("img, script, a, iframe, svg, object, embed")).toBeNull();
    expect(new Set(tagsIn(dom))).toEqual(new Set(["DIV", "CODE"]));
    expect(dom.textContent).toContain(IMAGE);
    expect(dom.textContent).toContain(SCRIPTED);
    expect(dom.textContent).toContain("[a link](https://example.com) **bold**");
    expect(dom.textContent).toContain("string");
    expect(dom.innerHTML).not.toContain("<img");
    expect(dom.innerHTML).not.toContain("onerror=alert(1)>"); // only as escaped text
    expect(Array.from(dom.querySelectorAll("*")).every((element) => element.attributes.length === 1 && element.hasAttribute("class"))).toBe(true);
  });

  it("keeps the library's class names, which the editor's theme styles, and puts the type in a code element", () => {
    const dom = plainHover({ message: "The id.", typeInfo: "string" });
    expect(dom.className).toBe("cm6-json-schema-hover");
    expect(dom.querySelector(".cm6-json-schema-hover--description")?.textContent).toBe("The id.");
    expect(dom.querySelector(".cm6-json-schema-hover--code-wrapper > code.cm6-json-schema-hover--code")?.textContent).toBe("string");
  });

  it("drops the markdown backticks of the library's own type line (`enum`: `a` or `b`), and shows the description as it was written", () => {
    const dom = plainHover({ message: "snake_case and *stars* stay", typeInfo: "`enum`: `a` or `b``format`: date-time" });
    expect(dom.querySelector("code")?.textContent).toBe("enum: a or b format: date-time");
    // a code span right after a bare word keeps a gap too
    expect(plainHover({ typeInfo: "string`format`: date-time" }).querySelector("code")?.textContent).toBe("string format: date-time");
    expect(dom.querySelector(".cm6-json-schema-hover--description")?.textContent).toBe("snake_case and *stars* stay");
    expect(plainHover({ typeInfo: "``" }).childElementCount).toBe(0);
  });

  it("leaves out what is not text or is empty: no description (null), a number, an object, and no type information", () => {
    for (const message of [null, undefined, "", 5, { a: 1 }, ["x"]]) {
      expect(plainHover({ message, typeInfo: "integer" }).querySelector(".cm6-json-schema-hover--description"), String(message)).toBeNull();
    }
    expect(plainHover({ message: "only text", typeInfo: "" }).querySelector("code")).toBeNull();
    expect(plainHover({ message: "only text", typeInfo: undefined }).querySelector("code")).toBeNull();
    expect(plainHover({ message: undefined, typeInfo: undefined }).childElementCount).toBe(0);
  });
});

describe("the editor's schema hover", () => {
  it("builds its tooltip from text only: a description with an image link and an <img onerror> has no element in the tooltip", async () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const handle = createEditor({ parent, doc: '{"orderId": "o-1"}', options: OPTIONS, onChange: vi.fn(), onFocusChange: vi.fn() });
    handles.push(handle);
    await handle.setSchema({ type: "object", properties: { orderId: { type: "string", description: DESCRIPTION } } });

    expect(h.hovers).toHaveLength(1);
    const tooltip = await h.hovers[0](handle.view, 3, 1);
    expect(tooltip).not.toBeNull();
    const dom = tooltip?.create(handle.view).dom as HTMLElement;
    expect(dom.textContent).toContain(IMAGE);
    expect(dom.textContent).toContain(SCRIPTED);
    expect(dom.querySelector("img, script, a, iframe, svg")).toBeNull();
    expect(new Set(tagsIn(dom))).toEqual(new Set(["DIV", "CODE"]));
  });

  it("still shows the type of a property that has no description", async () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const handle = createEditor({ parent, doc: '{"quantity": 2}', options: OPTIONS, onChange: vi.fn(), onFocusChange: vi.fn() });
    handles.push(handle);
    await handle.setSchema({ type: "object", properties: { quantity: { type: "integer" } } });
    const tooltip = await h.hovers[0](handle.view, 3, 1);
    expect(tooltip?.create(handle.view).dom.textContent).toContain("integer");
  });
});
