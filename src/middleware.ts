import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { hasValidSession } from "@/lib/session-cookie";

/**
 * The door of the app: runs before every page and every `/api/` endpoint (the matcher below leaves out only Next's own static assets,
 * and a GET or HEAD of an image is let through at once).
 *
 * - A visitor needs a VALID session (the cookie is decrypted and verified, `hasValidSession`; a cookie that merely has a session's
 *   name is no session). Without one a page redirects to `/login?callbackUrl=<the page asked for>` (the login page returns there
 *   when it is a safe path of this site, `safeCallbackUrl`), and the app's own JSON endpoints answer 401.
 * - Public: the login and register pages (a visitor with a bad cookie must be able to open them: no redirect loop), Auth.js's own
 *   `/api/auth/*`, the REST API under `/api/v1/*` (each handler checks an API key or the session itself, and the health probe is
 *   unauthenticated on purpose), and the preview iframe's static assets (a sandboxed iframe sends no cookie).
 * - A signed-in user on `/`, `/login` or `/register` goes to the dashboard.
 * - A server action (a request with a `Next-Action` header) from a page whose session has gone gets a 401 JSON, not a redirect: the
 *   browser would POST the redirect's target again.
 */

/** `/api/` URLs that answer without a session (see above). Every other `/api/` URL needs one. */
const PUBLIC_API_PREFIXES = ["/api/auth", "/api/v1", "/api/asyncapi-preview"];

/** A path is `prefix` itself or under it (`prefix/...`): `/login` and `/login/help`, not `/loginfoo` or `/login%2F..%2Fapi`. */
const isUnder = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

const isPublicApi = (pathname: string) => PUBLIC_API_PREFIXES.some((prefix) => isUnder(pathname, prefix));

export async function middleware(req: NextRequest) {
  if (isStaticFileRequest(req)) return NextResponse.next();
  const { pathname } = req.nextUrl;

  const isAuthPage = isUnder(pathname, "/login") || isUnder(pathname, "/register");
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
 * Only a GET or HEAD of a static file is let through unchecked: `/favicon.ico` and a path ending in an image extension. The address
 * alone never decides for another method: a server action is POSTed to a PAGE address (a dynamic segment can end in `.png`:
 * `/schemas/foo.png` is `[domainSlug]`), either with a `Next-Action` header or, as a progressive-enhancement form, as a multipart
 * body that names the action and carries no such header.
 */
const STATIC_FILE = /\.(?:svg|png|jpg|jpeg|gif|webp)$/;
const isStaticFileRequest = (req: NextRequest) =>
  (req.method === "GET" || req.method === "HEAD") && (req.nextUrl.pathname === "/favicon.ico" || STATIC_FILE.test(req.nextUrl.pathname));

export const config = {
  // Everything but `_next/static` and `_next/image`: they are served by Next itself and are never an action.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
