"use client";

import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from "react";

interface RightPanelContentState {
  content: ReactNode | null;
  setContent: (content: ReactNode | null) => void;
  onExpandRequest: (() => void) | null;
  registerExpandHandler: (handler: () => void) => void;
  togglePanel: () => void;
  registerToggleHandler: (handler: () => void) => void;
  collapsePanel: () => void;
  registerCollapseHandler: (handler: () => void) => void;
  isPanelCollapsed: boolean;
  registerCollapsedState: (collapsed: boolean) => void;
}

const RightPanelContentContext = createContext<RightPanelContentState>({
  content: null,
  setContent: () => {},
  onExpandRequest: null,
  registerExpandHandler: () => {},
  togglePanel: () => {},
  registerToggleHandler: () => {},
  collapsePanel: () => {},
  registerCollapseHandler: () => {},
  isPanelCollapsed: false,
  registerCollapsedState: () => {},
});

export function RightPanelContentProvider({ children }: { children: ReactNode }) {
  const [content, setContentState] = useState<ReactNode | null>(null);
  const [isPanelCollapsed, setIsPanelCollapsed] = useState(false);

  // Use refs to avoid stale closure issues with handlers
  const expandHandlerRef = useRef<(() => void) | null>(null);
  const toggleHandlerRef = useRef<(() => void) | null>(null);
  const collapseHandlerRef = useRef<(() => void) | null>(null);

  const setContent = useCallback((node: ReactNode | null) => {
    setContentState(node);
    if (node && expandHandlerRef.current) {
      expandHandlerRef.current();
    }
  }, []);

  const registerExpandHandler = useCallback((handler: () => void) => {
    expandHandlerRef.current = handler;
  }, []);

  const registerToggleHandler = useCallback((handler: () => void) => {
    toggleHandlerRef.current = handler;
  }, []);

  const registerCollapseHandler = useCallback((handler: () => void) => {
    collapseHandlerRef.current = handler;
  }, []);

  const togglePanel = useCallback(() => {
    toggleHandlerRef.current?.();
  }, []);

  const collapsePanel = useCallback(() => {
    collapseHandlerRef.current?.();
  }, []);

  const registerCollapsedState = useCallback((collapsed: boolean) => {
    setIsPanelCollapsed(collapsed);
  }, []);

  return (
    <RightPanelContentContext.Provider value={{
      content,
      setContent,
      onExpandRequest: expandHandlerRef.current,
      registerExpandHandler,
      togglePanel,
      registerToggleHandler,
      collapsePanel,
      registerCollapseHandler,
      isPanelCollapsed,
      registerCollapsedState,
    }}>
      {children}
    </RightPanelContentContext.Provider>
  );
}

export function useRightPanelContent() {
  return useContext(RightPanelContentContext);
}
