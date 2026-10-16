"use client";

// src/features/events/event-page/event-code-source.tsx
// What the live Code panel reads: the page's UNSAVED draft and the labels of its entities.
//
// The shell's right panel is rendered by the shell, ABOVE the page in the React tree, so a context provided inside the page cannot
// reach it. The page therefore pushes the panel element into the shell ONCE (`useRightPanelContent().setContent`), wrapped in a
// provider of this small store, and keeps the store's value current from an effect. The panel subscribes to the store: an edit
// re-renders the panel alone, not the whole shell, and the shell's `setContent` (which re-expands a collapsed panel) is not
// called again for it.
import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { InstantLibraryTrait } from "@/lib/events/document/instant-asyncapi";
import type { DocumentProblem, EventDocument } from "@/lib/events/document/types";

export interface EventCodeSource {
  eventId: string;
  productId: string;
  productSlug: string;
  /** The builder's current document, saved or not. */
  doc: EventDocument;
  /** Client-side parse problems of `doc` (empty = it parses, so the server can render it). */
  problems: DocumentProblem[];
  /** entityId → entity name. */
  entityLabels: ReadonlyMap<string, string>;
  /** entityVersionId → version label, for the versions the client knows by label (the entities' latest). */
  versionLabels: ReadonlyMap<string, string>;
  /** libraryTraitId → the trait's stored definition, so the instant code shows the real message properties of a built-in / library trait (absent = stubs). */
  libraryTraits?: ReadonlyMap<string, InstantLibraryTrait>;
}

export interface EventCodeSourceStore {
  get: () => EventCodeSource;
  /** A value that is the same object as the current one does nothing. */
  set: (next: EventCodeSource) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createEventCodeSourceStore(initial: EventCodeSource): EventCodeSourceStore {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

const StoreContext = createContext<EventCodeSourceStore | null>(null);

export function EventCodeSourceProvider({ store, children }: { store: EventCodeSourceStore; children: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

/** The current source; re-renders the caller whenever the page publishes a new one. */
export function useEventCodeSource(): EventCodeSource {
  const store = useContext(StoreContext);
  if (store === null) throw new Error("useEventCodeSource must be used inside an <EventCodeSourceProvider>");
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
