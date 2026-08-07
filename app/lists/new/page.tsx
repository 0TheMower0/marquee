import type { Metadata } from "next";

import { CreateListForm } from "@/components/lists/create-list-form";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ListIcon } from "@/components/ui/icons";
import { getAccount } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/public-env";

export const metadata: Metadata = { title: "New list" };

export default async function NewListPage() {
  if (!isSupabaseConfigured() || !(await getAccount())) {
    return (
      <div className="mx-auto w-full max-w-xl px-4 py-8 sm:px-6 lg:px-8">
        <EmptyState
          icon={<ListIcon />}
          title="Sign in to create a list"
          body="Lists are tied to your account so you can share them and collaborate with others."
          action={
            <Button href="/signin?next=/lists/new" size="sm">
              Sign in
            </Button>
          }
          className="py-14"
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="font-display text-display-lg text-fg mb-6 uppercase">New list</h1>
      <CreateListForm />
    </div>
  );
}
