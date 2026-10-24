/**
 * The login of the browser suite, kept under its old name so a spec written before the fixtures existed (`import { test, expect,
 * unique } from "./helpers/auth"`) keeps working. New specs import from "./helpers/fixtures".
 *
 *   - the credentials, the saved-session path and the UI `login()`: helpers/auth-state.ts (the `setup` project calls it once per run);
 *   - `test` / `expect`: helpers/fixtures.ts. Its `authedPage` is the page of the saved session, it does not log in again;
 *   - `unique`: helpers/unique.ts.
 */
export { AUTH_STATE_PATH, TEST_EMAIL, TEST_PASSWORD, login } from "./auth-state";
export { expect, test, unique } from "./fixtures";
