import { redirect } from "next/navigation";

/**
 * Root page — redirects to the main dashboard.
 * Authentication is enforced by middleware:
 * - Unauthenticated → /login
 * - Authenticated → /schemas (via middleware redirect)
 * This page is a fallback in case middleware doesn't catch it.
 */
export default function Home() {
  redirect("/schemas");
}
