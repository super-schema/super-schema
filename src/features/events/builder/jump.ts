// src/features/events/builder/jump.ts
// What the jump palette lists: every section, then every item of every section, as one flat list the user can type into. Pure — no React.
import type { OutlineNode } from "./outline";
import type { BuilderSection } from "./sections";

/** `item` is null for a section (and for an item with no key, which can only be reached by its section). `group` is the heading it is listed under. */
export interface JumpEntry { section: BuilderSection; item: string | null; label: string; group: string; problems: number }

/** The group the sections themselves are listed under. */
export const SECTIONS_GROUP = "Sections";

export function jumpEntries(outline: OutlineNode[]): JumpEntry[] {
  const sections = outline.map((node): JumpEntry => ({ section: node.section, item: null, label: node.label, group: SECTIONS_GROUP, problems: node.problems }));
  const items = outline.flatMap((node) => node.items.map((item): JumpEntry => ({
    section: node.section, item: item.key === "" ? null : item.key, label: item.label || "(no key)", group: node.label, problems: item.problems,
  })));
  return [...sections, ...items];
}
