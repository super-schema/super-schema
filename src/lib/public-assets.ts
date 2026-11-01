/**
 * The files the app serves WITHOUT a session: a GET or HEAD of exactly one of these paths skips the middleware (src/middleware.ts). It is
 * a list, never a pattern: a dynamic page address can end like any file (`/schemas/foo.png` is `/schemas/[domainSlug]`), and what skips
 * the door by the look of its address skips it for a page or an action too.
 *
 * `/icon.svg` is `src/app/icon.svg`, shared by the browser icon and the sign-in page's logo. Add other public assets here explicitly
 * with their tests (tests/unit/middleware.test.ts), never by accepting every address with an image extension.
 */
export const PUBLIC_ASSET_PATHS: readonly string[] = ["/icon.svg"];
