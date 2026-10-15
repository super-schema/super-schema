export type SpecTab = "editor" | "document" | "preview" | "versions" | "diagnostics";
export const SPEC_TABS: Array<{ id: SpecTab; label: string }> = [
  { id: "editor", label: "Editor" },
  { id: "document", label: "Document" },
  { id: "preview", label: "Preview" },
  { id: "versions", label: "Versions" },
  { id: "diagnostics", label: "Diagnostics" },
];

/** A published version is read-only: it opens on Document and never on the Editor. */
export function normalizeSpecTab(raw: string | null, viewingVersion: string | null): SpecTab {
  const known = SPEC_TABS.some((t) => t.id === raw) ? (raw as SpecTab) : null;
  if (viewingVersion) return known && known !== "editor" ? known : "document";
  return known ?? "editor";
}
