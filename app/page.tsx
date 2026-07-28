/**
 * TEMPORARY — replaced by the real Home page in Step 6.
 *
 * Exists so Step 1 is actually reviewable in a browser: it renders the type
 * scale and the semantic color tokens so they can be judged before any
 * components are built on top of them.
 */
export default function Home() {
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-16">
      <p className="text-meta text-accent-2 uppercase">Phase 1 · Step 1</p>
      <h1 className="font-display text-display-2xl text-accent mt-3 uppercase">
        Marquee
      </h1>
      <p className="text-fg-muted text-body-lg mt-4 max-w-prose">
        Design tokens and typefaces are wired. Everything below is rendered from
        the semantic token layer — no hardcoded colors.
      </p>

      <section className="mt-14">
        <h2 className="font-display text-display-lg border-line-subtle border-b pb-2 uppercase">
          Display scale · Bebas Neue
        </h2>
        <div className="mt-6 space-y-4">
          {[
            ["text-display-2xl", "The Godfather"],
            ["text-display-xl", "Trending This Week"],
            ["text-display-lg", "Continue Watching"],
            ["text-display-md", "Breaking Bad"],
            ["text-display-sm", "Season 3 · Episode 7"],
          ].map(([cls, sample]) => (
            <div key={cls} className="flex flex-wrap items-baseline gap-x-6">
              <code className="text-fg-subtle text-meta-sm w-40 shrink-0 uppercase">
                {cls.replace("text-", "")}
              </code>
              <span className={`font-display ${cls} uppercase`}>{sample}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-14">
        <h2 className="font-display text-display-lg border-line-subtle border-b pb-2 uppercase">
          Body scale · Inter
        </h2>
        <div className="mt-6 space-y-4">
          {[
            ["text-body-lg", "An aging patriarch transfers control of his empire."],
            ["text-body", "An aging patriarch transfers control of his empire."],
            ["text-body-sm", "An aging patriarch transfers control of his empire."],
          ].map(([cls, sample]) => (
            <div key={cls} className="flex flex-wrap items-baseline gap-x-6">
              <code className="text-fg-subtle text-meta-sm w-40 shrink-0 uppercase">
                {cls.replace("text-", "")}
              </code>
              <span className={cls}>{sample}</span>
            </div>
          ))}
          <div className="flex flex-wrap items-baseline gap-x-6">
            <code className="text-fg-subtle text-meta-sm w-40 shrink-0 uppercase">
              meta
            </code>
            <span className="text-meta text-fg-muted uppercase">
              1972 · Crime, Drama · 175 min
            </span>
          </div>
        </div>
      </section>

      <section className="mt-14">
        <h2 className="font-display text-display-lg border-line-subtle border-b pb-2 uppercase">
          Semantic colors
        </h2>
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["bg-ink", "ink"],
            ["bg-sunken", "sunken"],
            ["bg-surface", "surface"],
            ["bg-overlay", "overlay"],
            ["bg-accent", "accent"],
            ["bg-accent-hover", "accent-hover"],
            ["bg-accent-2", "accent-2"],
            ["bg-accent-2-hover", "accent-2-hover"],
            ["bg-success", "success"],
            ["bg-warning", "warning"],
            ["bg-danger", "danger"],
          ].map(([cls, name]) => (
            <div key={cls}>
              <div
                className={`${cls} border-line-subtle h-16 rounded-md border`}
              />
              <p className="text-meta-sm text-fg-subtle mt-2 uppercase">
                {name}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Proves the Phase 4 re-theming mechanism works today: overriding the
          semantic variables on this wrapper re-tints every `accent` utility
          inside it, with no component aware of the change. */}
      <section className="mt-14">
        <h2 className="font-display text-display-lg border-line-subtle border-b pb-2 uppercase">
          Phase 4 re-theming check
        </h2>
        <div
          className="border-line-subtle mt-6 rounded-lg border p-6"
          style={
            {
              "--accent-primary": "#ff5c8a",
              "--accent-secondary": "#7c5cff",
            } as React.CSSProperties
          }
        >
          <p className="text-meta text-accent-2 uppercase">
            Scoped override active
          </p>
          <h3 className="font-display text-display-xl text-accent mt-2 uppercase">
            Same markup, new palette
          </h3>
          <div className="mt-4 flex gap-3">
            <div className="bg-accent h-12 w-24 rounded-md" />
            <div className="bg-accent-2 h-12 w-24 rounded-md" />
          </div>
        </div>
      </section>
    </main>
  );
}
