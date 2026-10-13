import { vi } from "vitest";

// `server-only` throws when imported outside Next's RSC bundler; it has no
// meaning in a plain Node/Vitest process. Mocking it globally here means
// individual test files never need to remember to do this themselves —
// any file that transitively imports a server-only-guarded module (directly
// or via another module, e.g. a server action file) just works.
vi.mock("server-only", () => ({}));
