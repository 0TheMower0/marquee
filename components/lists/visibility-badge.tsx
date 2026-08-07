import { Badge, type BadgeSize } from "@/components/ui/badge";
import type { ListVisibility } from "@/lib/lists";

const LABEL: Record<ListVisibility, string> = {
  private: "Private",
  unlisted: "Unlisted",
  public: "Public",
};

/** `outline` (private, the closed/default state), `secondary` (unlisted —
 *  readable via link, not the "loud" gold reserved for public), `accent`
 *  (public — the one state actually worth drawing the eye to). */
const VARIANT: Record<ListVisibility, "outline" | "secondary" | "accent"> = {
  private: "outline",
  unlisted: "secondary",
  public: "accent",
};

export function VisibilityBadge({
  visibility,
  size,
}: {
  visibility: ListVisibility;
  size?: BadgeSize;
}) {
  return (
    <Badge variant={VARIANT[visibility]} size={size}>
      {LABEL[visibility]}
    </Badge>
  );
}
