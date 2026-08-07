import type { Metadata } from "next";
import { Suspense } from "react";

import { ListDetail, ListDetailSkeleton } from "@/components/lists/list-detail";
import { getListDetail } from "@/lib/lists/queries";

/**
 * A second `getListDetail` call, same "looks wasteful but isn't" reasoning
 * `generateMetadata` on the title page documents — this one just isn't
 * cached by Next's data cache the way a TMDB fetch is, so it's a genuine
 * second round trip. Accepted: a list's name is worth having in the tab
 * title and any share preview, and failures here are swallowed so a
 * metadata hiccup never affects the actual page render below.
 */
export async function generateMetadata({
  params,
}: PageProps<"/lists/[id]">): Promise<Metadata> {
  const { id } = await params;
  try {
    const list = await getListDetail(id);
    return { title: list ? list.name : "List" };
  } catch {
    return { title: "List" };
  }
}

export default async function ListDetailPage({ params }: PageProps<"/lists/[id]">) {
  const { id } = await params;

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      {/* See the header comment in components/lists/list-detail.tsx — this
          boundary plus that component's try/catch is what keeps a list
          failure from ever taking the rest of the app down with it. */}
      <Suspense fallback={<ListDetailSkeleton />}>
        <ListDetail listId={id} />
      </Suspense>
    </div>
  );
}
