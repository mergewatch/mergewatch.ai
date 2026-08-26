"use client";

import { signOut } from "next-auth/react";
import { clearOrgCookie } from "@/lib/org-selection";
import { useEffect } from "react";

export default function SignOutPage() {
  useEffect(() => {
    clearOrgCookie();
    signOut({ callbackUrl: "/" });
  }, []);

  return null;
}
