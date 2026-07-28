"use client";

import {
  createContext,
  useContext,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils/cn";

/**
 * Tabs following the WAI-ARIA Tabs pattern.
 *
 * The accessibility details are not decoration — a tab strip built from plain
 * divs and onClick is unusable by keyboard, and this is the one interactive
 * primitive in the Phase 1 set:
 *
 * - Roving tabindex: exactly one tab is in the tab order (tabIndex 0); the
 *   rest are -1. Tab enters and leaves the group; arrows move within it.
 *   Without this, a 6-tab strip costs six Tab presses to step past.
 * - Automatic activation: arrow keys change selection as they move, which is
 *   the correct choice when panels are cheap to render.
 * - Home/End jump to first/last, and arrows wrap.
 * - aria-controls / aria-labelledby wire each tab to its panel in both
 *   directions.
 * - The panel is focusable (tabIndex 0) so keyboard users can reach its
 *   content directly after selecting a tab.
 */

interface TabsContextValue {
  value: string;
  setValue: (value: string) => void;
  baseId: string;
  register: (value: string, el: HTMLButtonElement | null) => void;
  focusRelative: (from: string, direction: 1 | -1 | "first" | "last") => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
  const context = useContext(TabsContext);
  if (!context) {
    throw new Error(`<${component}> must be rendered inside <Tabs>.`);
  }
  return context;
}

interface TabsProps {
  /** Uncontrolled initial selection. */
  defaultValue: string;
  /** Provide together with onValueChange to control selection externally. */
  value?: string;
  onValueChange?: (value: string) => void;
  className?: string;
  children: ReactNode;
}

export function Tabs({
  defaultValue,
  value: controlledValue,
  onValueChange,
  className,
  children,
}: TabsProps) {
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue);
  const isControlled = controlledValue !== undefined;
  const value = isControlled ? controlledValue : uncontrolledValue;

  const baseId = useId();
  // Insertion-ordered map of tab value -> button element, so arrow navigation
  // follows visual order without the caller having to declare an index.
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  const setValue = (next: string) => {
    if (!isControlled) setUncontrolledValue(next);
    onValueChange?.(next);
  };

  const register = (tabValue: string, el: HTMLButtonElement | null) => {
    if (el) tabRefs.current.set(tabValue, el);
    else tabRefs.current.delete(tabValue);
  };

  const focusRelative = (
    from: string,
    direction: 1 | -1 | "first" | "last",
  ) => {
    const entries = [...tabRefs.current.entries()].filter(
      ([, el]) => !el.disabled,
    );
    if (entries.length === 0) return;

    let index: number;
    if (direction === "first") {
      index = 0;
    } else if (direction === "last") {
      index = entries.length - 1;
    } else {
      const current = entries.findIndex(([tabValue]) => tabValue === from);
      if (current === -1) return;
      // Wraps at both ends.
      index = (current + direction + entries.length) % entries.length;
    }

    const [nextValue, nextEl] = entries[index];
    nextEl.focus();
    setValue(nextValue);
  };

  return (
    <TabsContext.Provider value={{ value, setValue, baseId, register, focusRelative }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList({
  label,
  className,
  children,
}: {
  /** Accessible name for the tab group, e.g. "Filter by media type". */
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        "border-line-subtle flex items-center gap-1 border-b",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function TabsTrigger({
  value,
  disabled = false,
  className,
  children,
}: {
  value: string;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const { value: active, setValue, baseId, register, focusRelative } =
    useTabsContext("TabsTrigger");
  const isActive = active === value;

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        focusRelative(value, 1);
        break;
      case "ArrowLeft":
        event.preventDefault();
        focusRelative(value, -1);
        break;
      case "Home":
        event.preventDefault();
        focusRelative(value, "first");
        break;
      case "End":
        event.preventDefault();
        focusRelative(value, "last");
        break;
    }
  };

  return (
    <button
      type="button"
      role="tab"
      id={`${baseId}-tab-${value}`}
      aria-controls={`${baseId}-panel-${value}`}
      aria-selected={isActive}
      disabled={disabled}
      // Roving tabindex — see the note at the top of this file.
      tabIndex={isActive ? 0 : -1}
      ref={(el) => register(value, el)}
      onClick={() => setValue(value)}
      onKeyDown={onKeyDown}
      className={cn(
        "font-display text-display-sm relative -mb-px cursor-pointer border-b-2 px-3 py-2 uppercase",
        "motion-safe:transition-colors motion-safe:duration-[--dur-fast]",
        "disabled:pointer-events-none disabled:opacity-40",
        isActive
          ? // Gold marks the SELECTED tab. The focus ring is cyan (global rule)
            // precisely so the two states never look like each other.
            "border-accent text-accent"
          : "border-transparent text-fg-subtle hover:text-fg",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function TabsPanel({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: ReactNode;
}) {
  const { value: active, baseId } = useTabsContext("TabsPanel");
  if (active !== value) return null;

  return (
    <div
      role="tabpanel"
      id={`${baseId}-panel-${value}`}
      aria-labelledby={`${baseId}-tab-${value}`}
      tabIndex={0}
      className={cn("py-4", className)}
    >
      {children}
    </div>
  );
}
