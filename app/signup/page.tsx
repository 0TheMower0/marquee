import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthPageShell, AuthUnavailable } from "@/components/auth/auth-page-shell";
import { AuthDivider, OAuthButtons } from "@/components/auth/oauth-buttons";
import { SignUpForm } from "@/components/auth/sign-up-form";
import { getAccount } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/public-env";

export const metadata: Metadata = { title: "Create an account" };

export default async function SignUpPage() {
  if (!isSupabaseConfigured()) return <AuthUnavailable title="Create an account" />;
  if (await getAccount()) redirect("/account");

  return (
    <AuthPageShell
      title="Create an account"
      intro="Optional, and free. Marquee works fully without one — an account only adds syncing between devices."
    >
      <div className="space-y-6">
        <OAuthButtons />
        <AuthDivider />
        <SignUpForm />
      </div>
    </AuthPageShell>
  );
}
