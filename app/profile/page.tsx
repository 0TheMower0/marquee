import type { Metadata } from "next";

import { EmptyState } from "@/components/ui/empty-state";
import { UserIcon } from "@/components/ui/icons";

export const metadata: Metadata = { title: "Profile" };

export default function ProfilePage() {
  return (
    <EmptyState
      icon={<UserIcon />}
      title="No profile yet"
      body="Accounts, XP, streaks, and badges arrive in later phases. For now Marquee runs entirely on this device — nothing is synced anywhere."
      className="min-h-[70vh]"
    />
  );
}
