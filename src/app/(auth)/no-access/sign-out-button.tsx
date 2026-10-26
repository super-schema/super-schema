"use client";

import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";

/** Signs out (Auth.js's client call: no server action of this app) and returns to the login page. */
export function SignOutButton() {
  return (
    <Button type="button" variant="outline" onClick={() => signOut({ callbackUrl: "/login" })} data-testid="no-access-sign-out">
      Sign out
    </Button>
  );
}
