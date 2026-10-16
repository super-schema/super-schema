// src/features/events/builder/outline.ts
// The builder's left outline as data: one node per section with its item count and problem counts. Pure — no React.
import type { DocumentProblem, EventDocument } from "@/lib/events/document/types";
import { MESSAGE_PROPERTIES } from "./labels";
import { isIndexedSection, pointerTarget, securitySchemeAt, uniqueProblems } from "./problems";
import { BUILDER_SECTIONS, type BuilderSection } from "./sections";

export interface OutlineNode {
  section: BuilderSection;
  label: string;
  /** Number of items: the list sections' entries, message properties (local and library), security schemes (Advanced); null for Metadata. */
  count: number | null;
  /** Problems located in this section. */
  problems: number;
  items: Array<{ key: string; label: string; problems: number }>;
}

/** The section id `traits` is internal (URLs, test ids); users see "Message properties". */
export const SECTION_LABELS: Record<BuilderSection, string> = {
  metadata: "Metadata", servers: "Servers", channels: "Channels", messages: "Messages", operations: "Operations",
  traits: MESSAGE_PROPERTIES, advanced: "Advanced",
};

export function buildOutline(doc: EventDocument, problems: DocumentProblem[]): OutlineNode[] {
  const targets = uniqueProblems(problems).map((p) => ({ ...pointerTarget(p.pointer), scheme: securitySchemeAt(p.pointer) }));
  return BUILDER_SECTIONS.map((section): OutlineNode => {
    const inSection = targets.filter((t) => t.section === section);
    const label = SECTION_LABELS[section];
    if (section === "advanced") {
      // Security schemes are a map, so an item is counted by its name. A problem that names no scheme (`/components`) counts on the node only.
      const names = Object.keys(doc.components?.securitySchemes ?? {});
      return {
        section, label, count: names.length, problems: inSection.length,
        items: names.map((name) => ({ key: name, label: name, problems: inSection.filter((t) => t.scheme === name).length })),
      };
    }
    if (!isIndexedSection(section)) return { section, label, count: null, problems: inSection.length, items: [] };
    const list = doc[section];
    return {
      section, label, count: list.length, problems: inSection.length,
      // By position, not by key: two items can share a (broken) key.
      items: list.map((entry, index) => ({
        key: entry.key, label: entry.key, problems: inSection.filter((t) => t.index === index).length,
      })),
    };
  });
}
