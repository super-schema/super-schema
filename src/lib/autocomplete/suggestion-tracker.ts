const STORAGE_KEY = "super-schema:dismissed-suggestions";

type SuggestionAction = "accepted" | "dismissed";

function getStore(): Record<string, SuggestionAction> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveStore(store: Record<string, SuggestionAction>) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage full or unavailable
  }
}

export function trackSuggestion(fieldNamePattern: string, action: SuggestionAction) {
  const store = getStore();
  store[fieldNamePattern.toLowerCase()] = action;
  saveStore(store);
}

export function isDismissed(fieldNamePattern: string): boolean {
  const store = getStore();
  return store[fieldNamePattern.toLowerCase()] === "dismissed";
}

export function getSuggestionAction(fieldNamePattern: string): SuggestionAction | null {
  const store = getStore();
  return store[fieldNamePattern.toLowerCase()] ?? null;
}
