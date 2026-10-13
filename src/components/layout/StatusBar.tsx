"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";

// Map the leading path segment to a human-readable section label so the status
// bar reflects real navigation state instead of hardcoded placeholder text.
function sectionLabel(pathname: string): string {
  const seg = pathname.split("/").filter(Boolean)[0];
  if (!seg) return "Home";
  const labels: Record<string, string> = {
    schemas: "Schemas",
    compliance: "Compliance",
    deployments: "Deployments",
    notifications: "Notifications",
    admin: "Administration",
    glossary: "Glossary",
    governance: "Governance",
  };
  return labels[seg] ?? seg.charAt(0).toUpperCase() + seg.slice(1);
}

export function StatusBar() {
  const [saveFlash, setSaveFlash] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    function handleSaveFlash() {
      setSaveFlash(true);
      setTimeout(() => setSaveFlash(false), 2000);
    }
    document.addEventListener("super-schema:save-flash", handleSaveFlash);
    return () =>
      document.removeEventListener("super-schema:save-flash", handleSaveFlash);
  }, []);

  return (
    <footer
      data-testid="status-bar"
      className="h-6 w-full surface-1 border-t border-border flex items-center px-space-3 gap-space-3 text-caption text-muted-foreground"
    >
      <span className="border-r border-border pr-space-3">
        {sectionLabel(pathname ?? "")}
      </span>
      <span className="text-mono-small truncate max-w-xs" title={pathname ?? ""}>
        {pathname ?? ""}
      </span>

      {/* Save flash indicator */}
      {saveFlash && (
        <span
          data-testid="save-flash"
          className="ml-auto text-success text-caption font-medium animate-auth-fade-up"
        >
          All changes saved
        </span>
      )}
    </footer>
  );
}
