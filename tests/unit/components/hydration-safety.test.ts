import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(path: string) {
  return readFileSync(path, "utf8");
}

describe("hydration safety", () => {
  it("does not render raw script tags from the root layout", () => {
    const source = readSource("src/app/layout.tsx");

    expect(source).not.toContain("<script");
    expect(source).not.toContain("dangerouslySetInnerHTML");
  });

  it("applies persisted font scale from a client effect", () => {
    const source = readSource("src/components/providers.tsx");

    expect(source).toContain("useFontSize()");
  });

  it("does not rely on next-themes inline hydration scripts", () => {
    const providers = readSource("src/components/providers.tsx");
    const settingsPanel = readSource("src/components/custom/SettingsPanel/SettingsPanel.tsx");
    const sonner = readSource("src/components/ui/sonner.tsx");

    expect(providers).not.toContain("next-themes");
    expect(settingsPanel).not.toContain("next-themes");
    expect(sonner).not.toContain("next-themes");
  });

  it("renders a deterministic default theme on the server", () => {
    const layout = readSource("src/app/layout.tsx");

    expect(layout).toContain("dark");
  });

  it("does not read navigator while rendering shortcut text", () => {
    const topBar = readSource("src/components/layout/TopBar.tsx");
    const dashboardLayout = readSource("src/app/(dashboard)/layout.tsx");

    expect(topBar).not.toContain("modKey");
    expect(dashboardLayout).not.toContain("modKey");
  });

  it("does not read browser storage during first render", () => {
    const domainWorkspace = readSource("src/app/(dashboard)/schemas/[domainSlug]/domain-workspace.tsx");
    const fieldStudio = readSource("src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/fields/[fieldId]/field-studio.tsx");

    expect(domainWorkspace).not.toMatch(/useState<"tile" \| "list">\(\(\) =>[\s\S]*localStorage/);
    expect(fieldStudio).not.toMatch(/useState<number\[\]>\(\(\) =>[\s\S]*localStorage/);
  });
});
