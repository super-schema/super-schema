"use client";

import { useState, useEffect } from "react";

export function StatusBar() {
  const [saveFlash, setSaveFlash] = useState(false);

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
        No domain selected
      </span>
      <span className="border-r border-border pr-space-3">
        0 errors, 0 warnings
      </span>
      <span className="text-mono-small border-r border-border pr-space-3">
        v0
      </span>
      <span>Not connected</span>

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
