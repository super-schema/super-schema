"use client";

import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRightPanelContent } from "@/hooks/useRightPanelContent";

export function EntityToolbar() {
  const { togglePanel, isPanelCollapsed: isCollapsed } = useRightPanelContent();

  return (
    <div className="flex items-center gap-space-2">
      {/* Panel toggle button */}
      <Button
        variant="outline"
        onClick={togglePanel}
        className="gap-1.5"
        title={isCollapsed ? "Open side panel" : "Close side panel"}
      >
        {isCollapsed ? (
          <PanelRightOpen className="w-4 h-4" />
        ) : (
          <PanelRightClose className="w-4 h-4" />
        )}
      </Button>
    </div>
  );
}
