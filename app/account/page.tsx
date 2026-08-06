import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { PasswordForm, SignOutButton, UsernameForm } from "@/components/auth/account-forms";
import { AuthUnavailable } from "@/components/auth/auth-page-shell";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { getAuthProvider } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/public-env";

export const metadata: Metadata = { title: "Account" };

export default async function AccountPage({ searchParams }: PageProps<"/account">) {
  if (!isSupabaseConfigured()) return <AuthUnavailable title="Account" />;

  const provider = getAuthProvider();
  const account = await provider.getAccount();

  // Signed out. `next` brings them straight back here afterwards rather than
  // dumping them on a generic landing page.
  if (!account) redirect("/signin?next=%2Faccount");

  // Idempotent, and the reason `AuthAccount.profile` is nullable: an OAuth
  // user has no profile row until something creates one, and this is the first
  // authenticated page they land on. Cheap after the first call — a single
  // indexed select that finds a row and returns.
  const withProfile = account.profile ? account : await provider.ensureProfile();

  const params = await searchParams;
  const recovery = params.recovery === "1";

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 p-6 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-display-lg text-fg uppercase">Account</h1>
          <p className="text-body-sm text-fg-subtle mt-1">
            Signed in as{" "}
            <span className="text-fg">{withProfile.user.email ?? "an OAuth account"}</span>
          </p>
        </div>
        <SignOutButton variant="secondary" />
      </div>

      {withProfile.profile && <UsernameForm current={withProfile.profile.username} />}

      {/* Rendered for OAuth accounts too, on purpose: setting a password adds
          email/password as a second way in, it does not replace GitHub. An
          account with exactly one sign-in method is one deleted OAuth
          authorization away from being unreachable. */}
      <PasswordForm recovery={recovery} />

      <Card as="section">
        <CardHeader>
          <CardTitle>Your data</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          <p>
            Everything you track still lives in this browser. Signing in does not
            move it anywhere yet — cross-device sync is the next step of this
            phase, and until then an account is just an identity waiting for one.
          </p>
          <p>
            Nothing you have tracked was uploaded, merged, or changed by signing
            in.
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button href="/profile" variant="outline" size="sm">
              Back to profile
            </Button>
            <Button href="/library" variant="ghost" size="sm">
              My library
            </Button>
          </div>
        </CardBody>
      </Card>

      <p className="text-meta text-fg-subtle">
        Signed out, Marquee works exactly the same.{" "}
        <Link href="/" className="hover:text-fg underline">
          Go to Home
        </Link>
        .
      </p>
    </div>
  );
}
