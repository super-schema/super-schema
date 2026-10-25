"use client";

import { X } from "lucide-react";

interface RightPanelProps {
  width: number;
  isCollapsed: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onCollapse: () => void;
  children?: React.ReactNode;
  /** Render collapsed (handle only) instead of the empty "Detail Panel" placeholder when there is no content. */
  hideWhenEmpty?: boolean;
}

export function RightPanel({
  width,
  isCollapsed,
  onMouseDown,
  onDoubleClick,
  onCollapse,
  children,
  hideWhenEmpty = false,
}: RightPanelProps) {
  if (isCollapsed || width === 0 || (hideWhenEmpty && !children)) {
    return (
      <div
        data-testid="right-panel"
        data-collapsed="true"
        className="relative"
      >
        <div
          data-testid="right-panel-handle"
          className="absolute top-0 left-0 w-1 h-full cursor-col-resize hover:bg-primary/30 animate-field-hover z-10"
          onMouseDown={onMouseDown}
          onDoubleClick={onDoubleClick}
        />
      </div>
    );
  }

  return (
    <div
      data-testid="right-panel"
      data-collapsed="false"
      className="relative surface-glass border-l border-border flex flex-col animate-panel-expand overflow-hidden"
      style={{ width, minWidth: width }}
    >
      {children ? (
        <>
          {/* Close button row */}
          <div className="flex items-center justify-end px-space-2 py-space-1 border-b border-border/50">
            <button
              onClick={onCollapse}
              aria-label="Close panel"
              className="p-1 rounded-lg hover:bg-accent animate-field-hover"
            >
              <X className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>
          {/* Dynamic content */}
          <div className="flex-1 overflow-hidden flex flex-col">
            {children}
          </div>
        </>
      ) : (
        <>
          {/* Header */}
          <div className="flex items-center justify-between px-space-4 py-space-3 border-b border-border">
            <h3 className="text-heading-3 text-foreground">Detail Panel</h3>
            <button
              onClick={onCollapse}
              aria-label="Close panel"
              className="p-1 rounded-lg hover:bg-accent animate-field-hover"
            >
              <X className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>

          {/* Content placeholder */}
          <div className="p-space-4">
            <p className="text-body-small text-muted-foreground">
              Select a field to view decorators, emission preview, and validation
              details.
            </p>
          </div>
        </>
      )}

      {/* Drag handle */}
      <div
        data-testid="right-panel-handle"
        className="absolute top-0 left-0 w-1 h-full cursor-col-resize hover:bg-primary/30 animate-field-hover z-10"
        onMouseDown={onMouseDown}
        onDoubleClick={onDoubleClick}
      />
    </div>
  );
}
