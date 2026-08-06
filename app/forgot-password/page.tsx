import type { Metadata } from "next";

import { AuthPageShell, AuthUnavailable } from "@/components/auth/auth-page-shell";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { isSupabaseConfigured } from "@/lib/supabase/public-env";

export const metadata: Metadata = { title: "Reset your password" };

/**
 * Deliberately does NOT redirect a signed-in visitor away, unlike /signin and
 * /signup. Someone who is signed in on one device and has forgotten the
 * password they need on another has a real reason to be here.
 */
export default function ForgotPasswordPage() {
  if (!isSupabaseConfigured()) return <AuthUnavailable title="Reset your password" />;

  return (
    <AuthPageShell
      title="Reset your password"
      intro="We'll email you a link. It signs you in once so you can set a new password."
    >
      <ForgotPasswordForm />
    </AuthPageShell>
  );
}
