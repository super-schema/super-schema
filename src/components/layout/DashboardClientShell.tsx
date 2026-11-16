"use client";

import { useCallback, useEffect, useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";
import { SessionProvider } from "next-auth/react";
import { Plus } from "lucide-react";
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
    minWidth: 200,
    maxWidth: 280,
    defaultWidth: responsive.sidebar || 200,
    // A new baseline gives the editor more room; subsequent drag sizes remain remembered.
    panelId: "left-sidebar-compact",
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

  const handleSlashCommand = useCallback(() => {
    document.dispatchEvent(new CustomEvent("super-schema:slash-command"));
  }, []);

  const handleEscape = useCallback(() => {
    if (!palette.isOpen) {
      document.dispatchEvent(new CustomEvent("super-schema:escape"));
    }
  }, [palette.isOpen]);

  // Mod+S and Mod+E belong to the pages that can save or emit (they register their own handlers); the shell only keeps the browser's
  // "Save page" dialog away. It never claims a save happened: the status bar's "All changes saved" comes from a page that saved.
  useKeyboardShortcuts({
    onNewEntity: handleNewEntity,
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
    ],
    [mod, handleNewEntity]
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
        <ActivityBar showAdmin={adminArea} />
        <LeftSidebar
          width={sidebar.width}
          isCollapsed={sidebar.isCollapsed}
          onMouseDown={sidebar.handleMouseDown}
          onDoubleClick={sidebar.handleDoubleClick}
        />
        {/* The center panel always fills the space between the side panels (no gutters beside them); on wide screens its content is
            held to a readable measure and centered inside it. */}
        <main
          data-testid="center-panel"
          className="min-w-0 flex-1 surface-base p-space-6 overflow-auto"
        >
          <div className={responsive.breakpoint === "spacious" ? "mx-auto w-full max-w-[1200px]" : "w-full"}>
            {children}
          </div>
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
