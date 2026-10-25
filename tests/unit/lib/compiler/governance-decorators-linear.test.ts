/**
 * `sourceShadowsEnterprise` runs on every stored-source read (`upgradeLegacyTagDecorators`). Its block-comment and triple-quote strippers were
 * lazy regexes (`/\/\*[\s\S]*?\*\//g`): on a source with many unterminated openers each one scanned to the end of the text, so 240 KB of `/*a`
 * took 3.7 s on the event loop. They are index scans now: linear, and the same answer.
 */
import { describe, it, expect } from "vitest";
import { sourceShadowsEnterprise, ENTERPRISE_NAMESPACE } from "@/lib/compiler/governance-decorators";
import { upgradeLegacyTagDecorators } from "@/lib/compiler/legacy-tag-decorators";

/** The previous implementation, as the oracle of the fuzz comparison. */
function oracle(source: string): boolean {
  const code = source
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, "");
  const DECLARATION = /\b(?:model|enum|scalar|union|interface|alias|namespace)\s+([\w.]+)/g;
  for (const [, name] of code.matchAll(DECLARATION)) {
    if (name.split(".").includes(ENTERPRISE_NAMESPACE)) return true;
  }
  return /(?<![\w.@])Enterprise(?![\w.])/.test(code);
}

describe("sourceShadowsEnterprise is linear", () => {
  it("1 MB of unterminated block comments takes under 50 ms", () => {
    const text = "/*a".repeat(350_000);
    const started = performance.now();
    expect(sourceShadowsEnterprise(text)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("1 MB of unterminated triple quotes takes under 50 ms", () => {
    const text = '"""a'.repeat(260_000);
    const started = performance.now();
    expect(sourceShadowsEnterprise(text)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("the whole stored-source read (upgradeLegacyTagDecorators) of such a source is fast too", () => {
    const text = `model M {\n  a: string;\n}\n${"/*a".repeat(350_000)}`;
    const started = performance.now();
    expect(upgradeLegacyTagDecorators(text)).toBe(text);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("answers as before: comments, strings and triple quotes are ignored, an unterminated opener is not a comment", () => {
    expect(sourceShadowsEnterprise("model Enterprise { }")).toBe(true);
    expect(sourceShadowsEnterprise("/* model Enterprise { } */ model A { }")).toBe(false);
    expect(sourceShadowsEnterprise('@doc("""model Enterprise""") model A { }')).toBe(false);
    expect(sourceShadowsEnterprise("// model Enterprise\nmodel A { }")).toBe(false);
    expect(sourceShadowsEnterprise("/* model Enterprise { } ")).toBe(true); // never closed: not a comment (as the regex)
    expect(sourceShadowsEnterprise('"""x model Enterprise { }')).toBe(true);
  });

  it("agrees with the previous implementation on 3000 random sources", () => {
    const pieces = ["/*", "*/", "//", '"', '"""', "\n", "model Enterprise {", "model A {", " ", "a", "Enterprise", "namespace Enterprise.X;", "\\"];
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let n = 0; n < 3000; n++) {
      let text = "";
      for (let i = 0, len = next() % 14; i < len; i++) text += pieces[next() % pieces.length];
      expect(sourceShadowsEnterprise(text), JSON.stringify(text)).toBe(oracle(text));
    }
  });
});
