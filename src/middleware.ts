import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { hasValidSession } from "@/lib/session-cookie";
import { PUBLIC_ASSET_PATHS } from "@/lib/public-assets";

/**
 * The door of the app: runs before every page and every `/api/` endpoint (the matcher below leaves out only Next's own static assets,
 * and a GET or HEAD of a listed public asset, the favicon, is let through at once).
 *
 * - A visitor needs a VALID session (the cookie is decrypted and verified, `hasValidSession`; a cookie that merely has a session's
 *   name is no session). Without one a page redirects to `/login?callbackUrl=<the page asked for>` (the login page returns there
 *   when it is a safe path of this site, `safeCallbackUrl`), and the app's own JSON endpoints answer 401.
 * - Public: the login and register pages and the invitation and password-reset links `/invite/<token>` and `/reset/<token>` (a visitor with a
 *   bad cookie, or none, must be able to open them: no redirect loop, and the link's whole point is that the visitor has no session), Auth.js's own
 *   `/api/auth/*`, the REST API under `/api/v1/*` (each handler checks an API key or the session itself, and the health probe is
 *   unauthenticated on purpose), and the preview iframe's static assets (a sandboxed iframe sends no cookie).
 * - `/no-access` ("no role assigned yet", where the dashboard sends a signed-in user who may access no tenant) needs a session and no role: it is
 *   not public (a visitor without a session goes to `/login`) and not an auth page (a signed-in user is let through, never bounced to the
 *   dashboard, which would send them straight back: no redirect loop).
 * - A signed-in user on `/`, `/login`, `/register`, `/invite/...` or `/reset/...` goes to the dashboard (the links are for a person with no
 *   account or no session; a signed-in person who follows one signs out first).
 * - A server action (a request with a `Next-Action` header) from a page whose session has gone gets a 401 JSON, not a redirect: the
 *   browser would POST the redirect's target again.
 */

/** Pages a visitor with no session may open (see above); a signed-in visitor is sent to the dashboard from them. */
const AUTH_PAGE_PREFIXES = ["/login", "/register", "/invite", "/reset"];

/** `/api/` URLs that answer without a session (see above). Every other `/api/` URL needs one. */
const PUBLIC_API_PREFIXES = ["/api/auth", "/api/v1", "/api/asyncapi-preview"];

/** A path is `prefix` itself or under it (`prefix/...`): `/login` and `/login/help`, not `/loginfoo` or `/login%2F..%2Fapi`. */
const isUnder = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

const isPublicApi = (pathname: string) => PUBLIC_API_PREFIXES.some((prefix) => isUnder(pathname, prefix));

export async function middleware(req: NextRequest) {
  if (isPublicAssetRequest(req)) return NextResponse.next();
  const { pathname } = req.nextUrl;

  // Exact-or-slash, like every path here: `/invite` and `/invite/<token>`, never `/inviteme` or an encoded `/invite%2F..`.
  const isAuthPage = AUTH_PAGE_PREFIXES.some((prefix) => isUnder(pathname, prefix));
  const isDevPage = process.env.NODE_ENV === "development" && isUnder(pathname, "/dev");
  const isApi = pathname.startsWith("/api/");

  const signedIn = await hasValidSession(req.headers.get("cookie"));

  if (!signedIn) {
    if (isApi) {
      if (isPublicApi(pathname)) return NextResponse.next();
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
    if (isAuthPage || isDevPage) return NextResponse.next();
    // A server action POSTed from a page whose session has gone: a redirect would be followed by the browser as another POST, to
    // /login, where the action does not exist ("Server Action not found"). A 401 is an answer the client can show.
    if (req.headers.has("next-action")) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    const login = new URL("/login", req.url);
    if (pathname !== "/") {
      // Where the visitor was going, without Next's own client-navigation marker.
      const asked = new URLSearchParams(req.nextUrl.searchParams);
      asked.delete("_rsc");
      const query = asked.toString();
      login.searchParams.set("callbackUrl", query ? `${pathname}?${query}` : pathname);
    }
    return NextResponse.redirect(login);
  }

  // Authenticated users on root and on the auth pages → dashboard
  if (pathname === "/" || isAuthPage) {
    return NextResponse.redirect(new URL("/schemas", req.url));
  }

  return NextResponse.next();
}

/**
 * Only a GET or HEAD of one of the listed public assets (`/icon.svg`, src/lib/public-assets.ts) is let through unchecked. The address
 * alone never decides for anything else: a page address can end like a file (`/schemas/foo.png` is `[domainSlug]`), a GET of it is a
 * page request, and a server action is POSTed to it, with a `Next-Action` header or, as a progressive-enhancement form, as a multipart
 * body that names the action and carries no such header.
 */
const PUBLIC_ASSETS: ReadonlySet<string> = new Set(PUBLIC_ASSET_PATHS);
const isPublicAssetRequest = (req: NextRequest) => (req.method === "GET" || req.method === "HEAD") && PUBLIC_ASSETS.has(req.nextUrl.pathname);

export const config = {
  // Everything but `_next/static` and `_next/image`: they are served by Next itself and are never an action.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
