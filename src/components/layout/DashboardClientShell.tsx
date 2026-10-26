"use client";

import { useCallback, useEffect, useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";
import { SessionProvider } from "next-auth/react";
import { Download, FileCode, Plus, Save, Zap } from "lucide-react";
import { CommandPalette } from "@/components/custom/CommandPalette/CommandPalette";
import { ActivityBar } from "@/components/layout/ActivityBar";
import { LeftSidebar } from "@/components/layout/LeftSidebar";
import { RightPanel } from "@/components/layout/RightPanel";
import { StatusBar } from "@/components/layout/StatusBar";
import { TopBar } from "@/components/layout/TopBar";
import {
  CommandPaletteContext,
  useCommandPaletteProvider,
} from "@/hooks/useCommandPalette";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import {
  RightPanelContentProvider,
  useRightPanelContent,
} from "@/hooks/useRightPanelContent";
import { canNavigate } from "@/lib/navigation/before-navigate";
import { newEntityHrefForPath } from "@/lib/navigation/new-entity-target";
import { useModKey } from "@/lib/platform";

type PaletteAction = {
  id: string;
  label: string;
  icon: React.ReactNode;
  shortcut?: string;
  onSelect: () => void;
};

export function DashboardClientShell({ children, adminArea = false }: { children: React.ReactNode; adminArea?: boolean }) {
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
    maxWidth: 800,
    defaultWidth: responsive.rightPanel || 400,
    panelId: "right-panel",
    side: "right",
  });

  useEffect(() => {
    if (responsive.autoCollapse) {
      sidebar.collapse();
      rightPanel.collapse();
    }
  }, [responsive.autoCollapse]); // eslint-disable-line react-hooks/exhaustive-deps

  const mod = useModKey();

  const handleSave = useCallback(() => {
    document.dispatchEvent(new CustomEvent("super-schema:save-flash"));
  }, []);

  const handleNewEntity = useCallback(() => {
    const target = newEntityHrefForPath(pathname);

    if (!target) {
      // On the domains list or a domain page — let the user pick a target.
      palette.open();
      return;
    }

    // Leaving this page is a navigation like any other: a page with unsaved work can veto it (and asks the user itself). The
    // `new-entity` event below must not fire then either, so the check comes first.
    if (pathname !== target && !canNavigate(target)) return;

    document.dispatchEvent(new CustomEvent("super-schema:new-entity"));

    if (pathname !== target) {
      router.push(target);
    }
  }, [pathname, router, palette]);

  const handleEmit = useCallback(() => {
    document.dispatchEvent(new CustomEvent("super-schema:emit"));
  }, []);

  const handleSlashCommand = useCallback(() => {
    document.dispatchEvent(new CustomEvent("super-schema:slash-command"));
  }, []);

  const handleEscape = useCallback(() => {
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

  const paletteActions = useMemo<PaletteAction[]>(
    () => [
      {
        id: "new-entity",
        label: "New Entity",
        icon: <Plus className="w-4 h-4 text-muted-foreground" />,
        shortcut: `${mod}+N`,
        onSelect: handleNewEntity,
      },
      {
        id: "save",
        label: "Save",
        icon: <Save className="w-4 h-4 text-muted-foreground" />,
        shortcut: `${mod}+S`,
        onSelect: handleSave,
      },
      {
        id: "emit",
        label: "Emit TypeSpec",
        icon: <Zap className="w-4 h-4 text-muted-foreground" />,
        shortcut: `${mod}+E`,
        onSelect: handleEmit,
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
            adminArea={adminArea}
          >
            {children}
          </DashboardShell>
        </RightPanelContentProvider>
      </CommandPaletteContext.Provider>
    </SessionProvider>
  );
}

function DashboardShell({
  responsive,
  sidebar,
  rightPanel,
  palette,
  paletteActions,
  adminArea,
  children,
}: {
  responsive: ReturnType<typeof useResponsiveLayout>;
  sidebar: ReturnType<typeof useResizablePanel>;
  rightPanel: ReturnType<typeof useResizablePanel>;
  palette: ReturnType<typeof useCommandPaletteProvider>;
  paletteActions: PaletteAction[];
  adminArea: boolean;
  children: React.ReactNode;
}) {
  const {
    content: rightPanelContent,
    registerExpandHandler,
    registerToggleHandler,
    registerCollapseHandler,
    registerCollapsedState,
    hideWhenEmpty,
  } = useRightPanelContent();
  const { collapse, expand, isCollapsed } = rightPanel;

  useEffect(() => {
    registerExpandHandler(() => expand());
  }, [registerExpandHandler, expand]);

  useEffect(() => {
    registerCollapseHandler(() => collapse());
  }, [registerCollapseHandler, collapse]);

  useEffect(() => {
    registerToggleHandler(() => {
      if (isCollapsed) {
        expand();
      } else {
        collapse();
      }
    });
  }, [registerToggleHandler, isCollapsed, expand, collapse]);

  useEffect(() => {
    registerCollapsedState(isCollapsed);
  }, [registerCollapsedState, isCollapsed]);

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <TopBar showAdmin={adminArea} />

      {responsive.autoCollapse && (
        <div
          data-testid="responsive-warning"
          className="bg-warning/15 text-warning text-caption px-space-4 py-1 text-center"
        >
          Viewport too narrow — panels auto-collapsed for best experience
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <ActivityBar showAdmin={adminArea} />
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
          hideWhenEmpty={hideWhenEmpty}
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
