"use client";

import { useEffect, useMemo, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import { SessionProvider } from "next-auth/react";
import { TopBar } from "@/components/layout/TopBar";
import { LeftSidebar } from "@/components/layout/LeftSidebar";
import { RightPanel } from "@/components/layout/RightPanel";
import { StatusBar } from "@/components/layout/StatusBar";
import { CommandPalette } from "@/components/custom/CommandPalette/CommandPalette";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import {
  useCommandPaletteProvider,
  CommandPaletteContext,
} from "@/hooks/useCommandPalette";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { modKey } from "@/lib/platform";
import { Plus, Save, Zap, FileCode, Download } from "lucide-react";
import {
  RightPanelContentProvider,
  useRightPanelContent,
} from "@/hooks/useRightPanelContent";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const responsive = useResponsiveLayout();
  const palette = useCommandPaletteProvider();
  const router = useRouter();
  const pathname = usePathname();

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

  const mod = modKey();

  // Keyboard shortcut handlers
  const handleSave = useCallback(() => {
    // Field edits auto-save on blur; Cmd+S just prevents browser default
    // Dispatch a custom event so StatusBar can show "All changes saved"
    document.dispatchEvent(new CustomEvent("super-schema:save-flash"));
  }, []);

  const handleNewEntity = useCallback(() => {
    // Navigate to current domain page to trigger entity creation
    const domainMatch = pathname.match(/^\/schemas\/([^/]+)/);
    if (domainMatch) {
      // Dispatch event for domain-workspace to open create form
      document.dispatchEvent(new CustomEvent("super-schema:new-entity"));
      // If not already on domain page, navigate there
      if (pathname !== `/schemas/${domainMatch[1]}`) {
        router.push(`/schemas/${domainMatch[1]}`);
      }
    } else {
      // Not on a domain page — open command palette filtered
      palette.open();
    }
  }, [pathname, router, palette]);

  const handleEmit = useCallback(() => {
    document.dispatchEvent(new CustomEvent("super-schema:emit"));
  }, []);

  const handleSlashCommand = useCallback(() => {
    document.dispatchEvent(new CustomEvent("super-schema:slash-command"));
  }, []);

  const handleEscape = useCallback(() => {
    // Palette handles its own escape; this is for other panels
    if (!palette.isOpen) {
      document.dispatchEvent(new CustomEvent("super-schema:escape"));
    }
  }, [palette.isOpen]);

  useKeyboardShortcuts({
    onSave: handleSave,
    onNewEntity: handleNewEntity,
    onEmit: handleEmit,
    onSlashCommand: handleSlashCommand,
    onEscape: handleEscape,
  });

  // Build actions for command palette
  const paletteActions = useMemo(
    () => [
      {
        id: "new-entity",
        label: "New Entity",
        icon: <Plus className="w-4 h-4 text-muted-foreground" />,
        shortcut: `${mod}+N`,
        onSelect: () => handleNewEntity(),
      },
      {
        id: "save",
        label: "Save",
        icon: <Save className="w-4 h-4 text-muted-foreground" />,
        shortcut: `${mod}+S`,
        onSelect: () => handleSave(),
      },
      {
        id: "emit",
        label: "Emit TypeSpec",
        icon: <Zap className="w-4 h-4 text-muted-foreground" />,
        shortcut: `${mod}+E`,
        onSelect: () => handleEmit(),
      },
      {
        id: "show-diff",
        label: "Show Diff",
        icon: <FileCode className="w-4 h-4 text-muted-foreground" />,
        onSelect: () => {
          document.dispatchEvent(new CustomEvent("super-schema:show-diff"));
        },
      },
      {
        id: "export",
        label: "Export",
        icon: <Download className="w-4 h-4 text-muted-foreground" />,
        onSelect: () => {
          document.dispatchEvent(new CustomEvent("super-schema:export"));
        },
      },
    ],
    [mod, handleNewEntity, handleSave, handleEmit]
  );

  return (
    <SessionProvider>
      <CommandPaletteContext.Provider value={palette}>
        <RightPanelContentProvider>
          <DashboardShell
            responsive={responsive}
            sidebar={sidebar}
            rightPanel={rightPanel}
            palette={palette}
            paletteActions={paletteActions}
          >
            {children}
          </DashboardShell>
        </RightPanelContentProvider>
      </CommandPaletteContext.Provider>
    </SessionProvider>
  );
}

/** Inner component that can read RightPanelContentContext */
function DashboardShell({
  responsive,
  sidebar,
  rightPanel,
  palette,
  paletteActions,
  children,
}: {
  responsive: ReturnType<typeof useResponsiveLayout>;
  sidebar: ReturnType<typeof useResizablePanel>;
  rightPanel: ReturnType<typeof useResizablePanel>;
  palette: ReturnType<typeof useCommandPaletteProvider>;
  paletteActions: { id: string; label: string; icon: React.ReactNode; shortcut?: string; onSelect: () => void }[];
  children: React.ReactNode;
}) {
  const { content: rightPanelContent, registerExpandHandler, registerToggleHandler, registerCollapsedState } = useRightPanelContent();

  // Register the right panel expand handler so content pushes auto-expand the panel
  useEffect(() => {
    registerExpandHandler(() => rightPanel.expand());
  }, [registerExpandHandler, rightPanel]);

  // Register the right panel toggle handler
  useEffect(() => {
    registerToggleHandler(() => {
      if (rightPanel.isCollapsed) {
        rightPanel.expand();
      } else {
        rightPanel.collapse();
      }
    });
  }, [registerToggleHandler, rightPanel]);

  // Sync collapsed state to context
  useEffect(() => {
    registerCollapsedState(rightPanel.isCollapsed);
  }, [registerCollapsedState, rightPanel.isCollapsed]);

  return (
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
        >
          {rightPanelContent}
        </RightPanel>
      </div>

      <StatusBar />
      <CommandPalette
        isOpen={palette.isOpen}
        onClose={palette.close}
        actions={paletteActions}
      />
    </div>
  );
}
