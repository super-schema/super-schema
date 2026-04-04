import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const isAuthPage =
    pathname.startsWith("/login") || pathname.startsWith("/register");
  const isApiAuth = pathname.startsWith("/api/auth");
  const isDevPage =
    process.env.NODE_ENV === "development" && pathname.startsWith("/dev");
  const isApiRoute = pathname.startsWith("/api/");
  const isPublic = isAuthPage || isApiAuth || isDevPage || isApiRoute || pathname === "/";

  // Auth check via session cookie (supports both secure and non-secure cookie names)
  const sessionToken =
    req.cookies.get("authjs.session-token")?.value ||
    req.cookies.get("__Secure-authjs.session-token")?.value ||
    req.cookies.get("next-auth.session-token")?.value ||
    req.cookies.get("__Secure-next-auth.session-token")?.value;

  if (!sessionToken && !isPublic) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  if (sessionToken && isAuthPage) {
    return NextResponse.redirect(new URL("/schemas", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
