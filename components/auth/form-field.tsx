import type { InputHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils/cn";

interface FormFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  name: string;
  /** Inline validation message. Its presence is what wires up `aria-invalid`
   *  and `aria-describedby`, so a field can never be visually marked wrong
   *  without also being announced as wrong. */
  error?: string;
  /** Non-error helper text — a format hint, an availability result. */
  hint?: ReactNode;
}

/**
 * One text input, its label, and its message slot.
 *
 * Exists so the accessibility wiring is written once. Doing it per-form is how
 * the third form ends up with a `<label>` that isn't associated with anything
 * and an error that only sighted users receive.
 *
 * Labels are `font-sans`, not `font-display`. Bebas has no lowercase, and
 * "Email address" as a field label is body copy — CLAUDE.md scopes the display
 * face to titles, nav, and section headers, and Phase 4 Step 5 already found a
 * real bug from using it outside that scope.
 */
export function FormField({
  label,
  name,
  error,
  hint,
  className,
  ...rest
}: FormFieldProps) {
  const errorId = `${name}-error`;
  const hintId = `${name}-hint`;
  const describedBy =
    [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;

  return (
    <div className="space-y-1.5">
      <label htmlFor={name} className="text-body-sm text-fg block font-medium">
        {label}
      </label>

      <input
        id={name}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(
          "bg-surface border-line text-fg placeholder:text-fg-subtle text-body h-11 w-full rounded-md border px-3",
          error && "border-danger",
          className,
        )}
        {...rest}
      />

      {hint && (
        <p id={hintId} className="text-meta text-fg-subtle">
          {hint}
        </p>
      )}

      {/* role="alert" so a message appearing after submit is announced rather
          than silently rendered below a field the user has already left. */}
      {error && (
        <p id={errorId} role="alert" className="text-meta text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** Form-level message, above the fields. Separate from FormField because it
 *  belongs to the submission, not to any one input. */
export function FormMessage({
  status,
  children,
}: {
  status: "error" | "success";
  children: ReactNode;
}) {
  return (
    <p
      role={status === "error" ? "alert" : "status"}
      className={cn(
        "text-body-sm rounded-md border px-3 py-2",
        status === "error"
          ? "border-danger/40 bg-danger/10 text-danger"
          : "border-success/40 bg-success/10 text-success",
      )}
    >
      {children}
    </p>
  );
}
