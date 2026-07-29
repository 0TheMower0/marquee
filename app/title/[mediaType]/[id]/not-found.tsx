import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FilmIcon } from "@/components/ui/icons";

/**
 * Segment-scoped 404. Rendered when the detail page calls `notFound()` —
 * either because the media type in the URL isn't movie/tv, or because the
 * provider reported `not_found`. Scoped to this segment rather than global so
 * the copy can be about titles specifically.
 */
export default function TitleNotFound() {
  return (
    <EmptyState
      icon={<FilmIcon />}
      title="No such title"
      body="We couldn't find that film or series. The link may be wrong, or the title may no longer exist in the content source."
      className="min-h-[70vh]"
      action={
        <Button href="/" variant="outline">
          Browse trending
        </Button>
      }
    />
  );
}
