"use client";

import type { ListVisibility } from "@/lib/lists";
import { cn } from "@/lib/utils/cn";

const OPTIONS: { value: ListVisibility; label: string; body: string }[] = [
  {
    value: "private",
    label: "Private",
    body: "Only you and anyone you invite can see it.",
  },
  {
    value: "unlisted",
    label: "Unlisted",
    body: "Anyone signed in with the link can see it. Never shown in Discover.",
  },
  {
    value: "public",
    label: "Public",
    body: "Anyone signed in can find and follow it.",
  },
];

export function VisibilityPicker({
  value,
  onChange,
}: {
  value: ListVisibility;
  onChange: (value: ListVisibility) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-body-sm text-fg mb-1 font-medium">Who can see this</legend>
      {OPTIONS.map((option) => (
        <label
          key={option.value}
          className={cn(
            "flex cursor-pointer items-start gap-3 rounded-md border p-3",
            value === option.value ? "border-accent bg-accent/8" : "border-line-subtle",
          )}
        >
          <input
            type="radio"
            name="visibility"
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            className="accent-accent mt-0.5 size-4"
          />
          <span>
            <span className="text-body-sm text-fg block font-medium">{option.label}</span>
            <span className="text-meta text-fg-subtle">{option.body}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
