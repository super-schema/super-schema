"use client";

import { useEffect } from "react";
import { SessionProvider } from "next-auth/react";
import { TopBar } from "@/components/layout/TopBar";
import { LeftSidebar } from "@/components/layout/LeftSidebar";
import { RightPanel } from "@/components/layout/RightPanel";
import { StatusBar } from "@/components/layout/StatusBar";
import { CommandPalette } from "@/components/custom/CommandPalette/CommandPalette";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const responsive = useResponsiveLayout();

  const sidebar = useResizablePanel({
    minWidth: 240,
    maxWidth: 320,
    defaultWidth: responsive.sidebar || 240,
    panelId: "left-sidebar",
    side: "left",
  });

  const rightPanel = useResizablePanel({
    minWidth: 320,
    maxWidth: 480,
    defaultWidth: responsive.rightPanel || 320,
    panelId: "right-panel",
    side: "right",
  });

  // Auto-collapse on compact viewports
  useEffect(() => {
    if (responsive.autoCollapse) {
      sidebar.collapse();
      rightPanel.collapse();
    }
  }, [responsive.autoCollapse]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <SessionProvider>
    <div className="flex flex-col h-screen overflow-hidden">
      <TopBar />

      {responsive.autoCollapse && (
        <div
          data-testid="responsive-warning"
          className="bg-warning/15 text-warning text-caption px-space-4 py-1 text-center"
        >
          Viewport too narrow — panels auto-collapsed for best experience
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <LeftSidebar
          width={sidebar.width}
          isCollapsed={sidebar.isCollapsed}
          onMouseDown={sidebar.handleMouseDown}
          onDoubleClick={sidebar.handleDoubleClick}
        />
        <main
          data-testid="center-panel"
          className="flex-1 surface-base p-space-6 overflow-auto"
          style={
            responsive.breakpoint === "spacious"
              ? { maxWidth: 1200, margin: "0 auto" }
              : undefined
          }
        >
          {children}
        </main>

        <RightPanel
          width={rightPanel.width}
          isCollapsed={rightPanel.isCollapsed}
          onMouseDown={rightPanel.handleMouseDown}
          onDoubleClick={rightPanel.handleDoubleClick}
          onCollapse={rightPanel.collapse}
        />
      </div>

      <StatusBar />
      <CommandPalette />
    </div>
    </SessionProvider>
  );
}
