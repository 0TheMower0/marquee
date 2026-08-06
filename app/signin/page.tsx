import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthPageShell, AuthUnavailable } from "@/components/auth/auth-page-shell";
import { AuthDivider, OAuthButtons } from "@/components/auth/oauth-buttons";
import { ResendVerificationForm } from "@/components/auth/resend-verification-form";
import { SignInForm } from "@/components/auth/sign-in-form";
import { FormMessage } from "@/components/auth/form-field";
import { getAccount } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/public-env";

export const metadata: Metadata = { title: "Sign in" };

/**
 * Failure codes the auth flow can bounce back here with. Fixed strings mapped
 * from a fixed set — the query parameter is attacker-controllable, so nothing
 * from it is ever rendered directly. An unrecognized value shows nothing at
 * all rather than a default "something went wrong", because the most likely
 * source of an unrecognized value is someone probing for reflected output.
 */
const ERROR_COPY: Record<string, string> = {
  oauth: "That sign-in didn't complete. Try again.",
  link: "That link has expired or was already used. Request a new one.",
  unavailable: "Accounts aren't available on this deployment.",
  rate_limited: "Too many attempts. Wait a minute and try again.",
  unsupported: "That sign-in method isn't supported.",
};

export default async function SignInPage({
  searchParams,
}: PageProps<"/signin">) {
  if (!isSupabaseConfigured()) return <AuthUnavailable title="Sign in" />;

  // Already signed in — a sign-in form would be confusing rather than useful.
  if (await getAccount()) redirect("/account");

  const params = await searchParams;
  const next = typeof params.next === "string" ? params.next : undefined;
  const errorKey = typeof params.error === "string" ? params.error : undefined;
  const errorMessage = errorKey ? ERROR_COPY[errorKey] : undefined;

  return (
    <AuthPageShell
      title="Sign in"
      intro="Signing in adds sync. Everything already on this device stays exactly where it is."
      footer={<ResendVerificationForm />}
    >
      <div className="space-y-6">
        {errorMessage && <FormMessage status="error">{errorMessage}</FormMessage>}
        <OAuthButtons next={next} />
        <AuthDivider />
        <SignInForm next={next} />
      </div>
    </AuthPageShell>
  );
}
