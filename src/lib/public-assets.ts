/**
 * The files the app serves WITHOUT a session: a GET or HEAD of exactly one of these paths skips the middleware (src/middleware.ts). It is
 * a list, never a pattern: a dynamic page address can end like any file (`/schemas/foo.png` is `/schemas/[domainSlug]`), and what skips
 * the door by the look of its address skips it for a page or an action too.
 *
 * `/favicon.ico` is `src/app/favicon.ico`. `public/` holds five create-next-app SVGs (`file`, `globe`, `next`, `vercel`, `window`) that
 * nothing in the app or the tests references, so none is listed: a visitor without a session who asks for one is sent to the login
 * page like for any other address. A file that is added to `public/` and is meant for such visitors (the login page's logo, say) is
 * added here with it, and the test of the list (tests/unit/middleware.test.ts) is where that is decided.
 */
export const PUBLIC_ASSET_PATHS: readonly string[] = ["/favicon.ico"];
