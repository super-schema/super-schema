import { createTestLibrary } from "@typespec/compiler/testing";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
export const DbTestLibrary = createTestLibrary({
    name: "@typespec/db",
    packageRoot: resolve(__dirname, "../../../"),
});
