"use client";

import { PanelRightClose, PanelRightOpen, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRightPanelContent } from "@/hooks/useRightPanelContent";

interface EntityToolbarProps {
  onDelete?: () => void;
}

export function EntityToolbar({ onDelete }: EntityToolbarProps) {
  const { togglePanel, isPanelCollapsed: isCollapsed } = useRightPanelContent();

  return (
    <div className="flex items-center gap-space-2">
      {onDelete && (
        <Button
          variant="outline"
          onClick={onDelete}
          data-testid="entity-delete-button"
          className="gap-1.5 text-muted-foreground hover:text-destructive hover:border-destructive/50"
          title="Delete entity"
        >
          <Trash2 className="w-4 h-4" />
          Delete
        </Button>
      )}
      <Button
        variant="outline"
        onClick={togglePanel}
        data-testid="right-panel-toggle"
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
