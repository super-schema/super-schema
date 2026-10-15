/**
 * Legacy safety net for STORED TypeSpec sources (Story 16.6).
 *
 * Before Story 16.6 the generator emitted `@tag("<tag>")` on the model (entity tags) and
 * `@tag("classification:<LEVEL>")` on properties. Real TypeSpec allows `@tag` only on
 * Namespace | Interface | Operation, so such text fails `decorator-wrong-target`. The generator no longer
 * emits it, so nothing that compiles fresh generator output needs a workaround (the old
 * `toCompilableTypeSpec` strip is gone). But a publish wrote the generator's text back into
 * `entity.typespecSource`, so sources stored before 16.6 can still carry those lines, and the TypeSpec
 * Source tab (which compiles for real) could not save them.
 *
 * `upgradeLegacyTagDecorators` rewrites them — losslessly, unlike the old strip — into the decorators the
 * generator emits now (governance-decorators.ts), adding any import they need. It is applied where a stored
 * source is handed to the Source tab (`getTypeSpecSourceAction`). Frozen `resolvedSource` text is display-only
 * and never recompiled; importers keep reading the legacy form directly.
 *
 * Only a line that is nothing but a `@tag("...")` decorator is considered (the generator put every decorator
 * on its own line and escaped quotes / backslashes / newlines, so a string never spans lines). It is
 * rewritten only when the declaration it decorates is a model (→ one `x-tags` extension per model) or a
 * model property with a `classification:` tag. `@tag` on an operation, interface or namespace is valid and
 * left alone, as is anything else.
 *
 * A document that itself declares or uses the name `Enterprise` (a model, a namespace segment, a bare
 * reference) cannot resolve `Enterprise.dataClassification` to the governance library, so its classifications
 * are rewritten to the lossless `x-classification` extension and the library is not imported (R53).
 *
 * Pure — no I/O.
 */

import {
  LIBRARY_IMPORTS,
  classificationDecorator,
  classificationFromLegacyTag,
  sourceShadowsEnterprise,
  tagsDecorator,
  unescapeTypeSpecString,
  type GovernanceLibrary,
} from "./governance-decorators";

const TAG_LINE = /^([ \t]*)@tag\("((?:[^"\\\n]|\\.)*)"\)[ \t]*\r?$/;
const PROPERTY_LINE = /^\w+\??\s*:/;
const MODEL_LINE = /^model\s/;

/** Index of the declaration a decorator line decorates: the next line that is not a decorator, blank or comment. */
function decoratedLineIndex(lines: string[], from: number): number {
  for (let j = from + 1; j < lines.length; j++) {
    const t = lines[j].trim();
    if (t === "" || t.startsWith("@") || t.startsWith("#") || t.startsWith("//")) continue;
    return j;
  }
  return -1;
}

export function upgradeLegacyTagDecorators(source: string): string {
  const lines = source.split("\n");
  const replaced = new Map<number, string | null>(); // line index → new text (null = remove)
  const modelTags = new Map<number, { first: number; indent: string; tags: string[] }>();
  const used = new Set<GovernanceLibrary>();
  // A document that uses the name `Enterprise` itself cannot call `@Enterprise.dataClassification` (R53).
  const enterpriseShadowed = sourceShadowsEnterprise(source);

  lines.forEach((line, i) => {
    const m = line.match(TAG_LINE);
    if (!m) return;
    const [, indent, escaped] = m;
    const value = unescapeTypeSpecString(escaped);
    const target = decoratedLineIndex(lines, i);
    if (target === -1) return;
    const decl = lines[target].trim();

    if (MODEL_LINE.test(decl)) {
      const group = modelTags.get(target);
      if (group) {
        group.tags.push(value);
        replaced.set(i, null);
      } else {
        modelTags.set(target, { first: i, indent, tags: [value] });
      }
      return;
    }

    const level = classificationFromLegacyTag(value);
    if (level && PROPERTY_LINE.test(decl)) {
      const { line: decorator, library } = classificationDecorator(level, enterpriseShadowed);
      replaced.set(i, `${indent}${decorator}`);
      used.add(library);
    }
  });

  for (const { first, indent, tags } of modelTags.values()) {
    replaced.set(first, `${indent}${tagsDecorator(tags)}`);
    used.add("openapi");
  }

  if (replaced.size === 0) return source;

  const body = lines
    .map((line, i) => (replaced.has(i) ? replaced.get(i) : line))
    .filter((line): line is string => line !== null)
    .join("\n");

  const missing = (["enterprise", "openapi"] as const)
    .filter((lib) => used.has(lib))
    .map((lib) => LIBRARY_IMPORTS[lib])
    .filter((imp) => !body.split("\n").some((l) => l.trim() === imp));
  if (missing.length === 0) return body;
  const separator = /^\s*import\s/.test(body) ? "\n" : "\n\n";
  return `${missing.join("\n")}${separator}${body}`;
}
