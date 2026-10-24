import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { hasValidSession } from "@/lib/session-cookie";

/**
 * The door of the app: runs before every page and every `/api/` endpoint (the matcher below leaves out only static files).
 *
 * - A visitor needs a VALID session (the cookie is decrypted and verified, `hasValidSession`; a cookie that merely has a session's
 *   name is no session). Without one a page redirects to `/login?callbackUrl=<the page asked for>` (the login page returns there
 *   when it is a safe path of this site, `safeCallbackUrl`), and the app's own JSON endpoints answer 401.
 * - Public: the login and register pages (a visitor with a bad cookie must be able to open them: no redirect loop), Auth.js's own
 *   `/api/auth/*`, the REST API under `/api/v1/*` (each handler checks an API key or the session itself, and the health probe is
 *   unauthenticated on purpose), and the preview iframe's static assets (a sandboxed iframe sends no cookie).
 * - A signed-in user on `/`, `/login` or `/register` goes to the dashboard.
 */

/** `/api/` URLs that answer without a session (see above). Every other `/api/` URL needs one. */
const PUBLIC_API_PREFIXES = ["/api/auth", "/api/v1", "/api/asyncapi-preview"];

const isPublicApi = (pathname: string) =>
  PUBLIC_API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const isAuthPage = pathname.startsWith("/login") || pathname.startsWith("/register");
  const isDevPage = process.env.NODE_ENV === "development" && pathname.startsWith("/dev");
  const isApi = pathname.startsWith("/api/");

  const signedIn = await hasValidSession(req.headers.get("cookie"));

  if (!signedIn) {
    if (isApi) {
      if (isPublicApi(pathname)) return NextResponse.next();
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
    if (isAuthPage || isDevPage) return NextResponse.next();

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

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
