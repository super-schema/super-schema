import { vi } from "vitest";

// `server-only` throws when imported outside Next's RSC bundler; it has no
// meaning in a plain Node/Vitest process. Mocking it globally here means
// individual test files never need to remember to do this themselves —
// any file that transitively imports a server-only-guarded module (directly
// or via another module, e.g. a server action file) just works.
vi.mock("server-only", () => ({}));

// The git hosts the JSON Schema importer may fetch through `gh` (read once at module load).
process.env.SCHEMA_IMPORT_GIT_HOSTS = "github.example.com";
