// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown, safeHref } from "@/features/events/builder/template/markdown";

afterEach(cleanup);

function renderMarkdown(source: string) {
  return render(<div data-testid="md"><Markdown source={source} /></div>);
}

describe("safeHref", () => {
  it.each([
    ["https://example.com/a?b=1", "https://example.com/a?b=1"],
    ["http://example.com", "http://example.com"],
    ["mailto:team@example.com", "mailto:team@example.com"],
    ["  https://example.com  ", "https://example.com"],
  ])("allows %s", (input, expected) => {
    expect(safeHref(input)).toBe(expected);
  });

  it.each([
    ["javascript:alert(1)"],
    ["JaVaScRiPt:alert(1)"],
    ["data:text/html;base64,PHNjcmlwdD4="],
    ["vbscript:msgbox(1)"],
    ["ftp://example.com"],
    ["/relative/path"],
    ["//example.com"],
    ["example.com"],
    [""],
  ])("refuses %s", (input) => {
    expect(safeHref(input)).toBeNull();
  });
});

describe("Markdown blocks", () => {
  it("renders paragraphs separated by blank lines, and joins the lines of one paragraph", () => {
    renderMarkdown("first line\nsecond line\n\nanother paragraph");
    const paragraphs = screen.getByTestId("md").querySelectorAll("p");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].textContent).toBe("first line second line");
    expect(paragraphs[1].textContent).toBe("another paragraph");
  });

  it("renders headings of every level as headings with their text", () => {
    renderMarkdown("# One\n## Two\n###### Six");
    expect(screen.getByRole("heading", { name: "One" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Two" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Six" })).toBeTruthy();
    expect(screen.getAllByRole("heading")).toHaveLength(3);
  });

  it("a # without a space after it is not a heading", () => {
    renderMarkdown("#hashtag");
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByTestId("md").textContent).toBe("#hashtag");
  });

  it("renders bullet lists (-, * and +) as one list", () => {
    renderMarkdown("- alpha\n* beta\n+ gamma");
    const items = screen.getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual(["alpha", "beta", "gamma"]);
    expect(screen.getByTestId("md").querySelectorAll("ul")).toHaveLength(1);
  });

  it("renders numbered lists as an ordered list", () => {
    renderMarkdown("1. first\n2. second\n3) third");
    const list = screen.getByTestId("md").querySelector("ol");
    expect(list).not.toBeNull();
    expect(Array.from(list!.querySelectorAll("li")).map((i) => i.textContent)).toEqual(["first", "second", "third"]);
  });

  it("a list ends at the first line that is not an item", () => {
    renderMarkdown("- a\n- b\n\nafter");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByTestId("md").querySelectorAll("p")).toHaveLength(1);
  });

  it("renders a fenced code block verbatim, without interpreting markdown inside it", () => {
    renderMarkdown("```json\n{ \"a\": **1** }\n- not a list\n```\nafter");
    const code = screen.getByTestId("md").querySelector("pre code");
    expect(code?.textContent).toBe('{ "a": **1** }\n- not a list');
    expect(screen.queryByRole("listitem")).toBeNull();
    expect(screen.getByTestId("md").querySelector("strong")).toBeNull();
  });

  it("an unclosed fence runs to the end of the text", () => {
    renderMarkdown("```\nline one\nline two");
    expect(screen.getByTestId("md").querySelector("pre code")?.textContent).toBe("line one\nline two");
  });

  it("renders nothing for empty text", () => {
    const { container } = renderMarkdown("   \n\n  ");
    expect(container.querySelector("p, ul, ol, pre, h3, h4")).toBeNull();
  });
});

describe("Markdown inline", () => {
  it("renders bold, italic and inline code", () => {
    renderMarkdown("a **bold** b *italic* c `code()` d __also bold__ e _also italic_");
    const root = screen.getByTestId("md");
    expect(Array.from(root.querySelectorAll("strong")).map((e) => e.textContent)).toEqual(["bold", "also bold"]);
    expect(Array.from(root.querySelectorAll("em")).map((e) => e.textContent)).toEqual(["italic", "also italic"]);
    expect(root.querySelector("code")?.textContent).toBe("code()");
  });

  it("does not interpret markdown inside inline code", () => {
    renderMarkdown("`**not bold**`");
    expect(screen.getByTestId("md").querySelector("strong")).toBeNull();
    expect(screen.getByTestId("md").querySelector("code")?.textContent).toBe("**not bold**");
  });

  it("nests italic inside bold", () => {
    renderMarkdown("**bold and *italic* inside**");
    expect(screen.getByTestId("md").querySelector("strong em")?.textContent).toBe("italic");
  });

  it("leaves an unmatched marker as literal text", () => {
    renderMarkdown("2 * 3 and **open");
    expect(screen.getByTestId("md").textContent).toBe("2 * 3 and **open");
    expect(screen.getByTestId("md").querySelector("em, strong")).toBeNull();
  });

  it("does not italicise underscores inside a word", () => {
    renderMarkdown("use snake_case_names here");
    expect(screen.getByTestId("md").querySelector("em")).toBeNull();
    expect(screen.getByTestId("md").textContent).toBe("use snake_case_names here");
  });

  it("renders http, https and mailto links as anchors that open safely", () => {
    renderMarkdown("[docs](https://example.com/docs) [plain](http://example.com) [mail](mailto:a@b.co)");
    const anchors = Array.from(screen.getByTestId("md").querySelectorAll("a"));
    expect(anchors.map((a) => a.getAttribute("href"))).toEqual(["https://example.com/docs", "http://example.com", "mailto:a@b.co"]);
    expect(anchors.map((a) => a.textContent)).toEqual(["docs", "plain", "mail"]);
    for (const a of anchors) {
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
      expect(a.getAttribute("target")).toBe("_blank");
    }
  });

  it("renders a link with any other scheme as its label only, never as an anchor", () => {
    renderMarkdown("[click](javascript:alert(1)) and [data](data:text/html;base64,AAA) and [rel](/local)");
    const root = screen.getByTestId("md");
    expect(root.querySelector("a")).toBeNull();
    expect(root.innerHTML).not.toContain("href");
    expect(root.textContent).toContain("click");
    expect(root.textContent).toContain("data");
    expect(root.textContent).toContain("rel");
  });
});

describe("Markdown safety (it builds React elements; the text is never parsed as HTML)", () => {
  it("shows HTML tags and scripts as text", () => {
    renderMarkdown('<script>alert(1)</script> <img src=x onerror="alert(1)"> <b>bold?</b>');
    const root = screen.getByTestId("md");
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("b")).toBeNull();
    expect(root.textContent).toBe('<script>alert(1)</script> <img src=x onerror="alert(1)"> <b>bold?</b>');
  });

  it("shows HTML inside a code block as text", () => {
    renderMarkdown("```\n<iframe src=evil></iframe>\n```");
    expect(screen.getByTestId("md").querySelector("iframe")).toBeNull();
    expect(screen.getByTestId("md").querySelector("code")?.textContent).toBe("<iframe src=evil></iframe>");
  });

  it("never emits an inline event handler or style attribute", () => {
    renderMarkdown("**a** [l](https://x.co) `c`\n\n- i");
    expect(screen.getByTestId("md").innerHTML).not.toMatch(/\son[a-z]+=/);
  });
});
