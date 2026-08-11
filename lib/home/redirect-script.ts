import { FIRST_PAGE_PATH, HOME_CONFIG_KEY, HOME_CONFIG_NAMESPACE } from "./types";

/** Mirrors `lib/storage/store.ts`'s own key format (`marquee:<namespace>:<key>`)
 *  exactly, built from the same exported constants `lib/home/store.ts` uses —
 *  never a third hardcoded copy of either half. */
const STORAGE_KEY = `marquee:${HOME_CONFIG_NAMESPACE}:${HOME_CONFIG_KEY}`;

/**
 * Source for the `beforeInteractive` inline script in app/layout.tsx that
 * sends a COLD load of "/" straight to the user's configured first page.
 *
 * A plain string, not a React component or a module import, because
 * `beforeInteractive` runs before hydration — there is no React tree yet for
 * a component to join, and no event loop tick to `await` a Promise on. It
 * therefore reads `localStorage` directly and synchronously, bypassing
 * `lib/storage`'s async driver entirely: blocking parse/paint on a Promise
 * here would defeat the entire point of running this before hydration.
 *
 * Scoped to `location.pathname === "/"` on purpose. App Router client-side
 * `<Link>` navigation never reloads the document, so this script can only
 * ever run again on a genuine cold load — but a cold load of `/library`
 * directly must not itself bounce anywhere, only a cold load of `/` is a
 * "which page did the user actually mean to open" question.
 *
 * Wrapped in one try/catch with no rethrow: blocked or corrupted storage
 * must degrade to "stay on Home" (the zero-config default), never to a
 * thrown error interrupting page load.
 *
 * `FIRST_PAGE_PATH` is interpolated as JSON from the same export every other
 * reader in this app uses — never a second hardcoded route map that could
 * silently drift from a rename.
 */
export function buildFirstPageRedirectScript(): string {
  const paths = JSON.stringify(FIRST_PAGE_PATH);
  const key = JSON.stringify(STORAGE_KEY);
  return (
    "(function(){" +
    'try{' +
    'if(location.pathname!=="/")return;' +
    `var raw=localStorage.getItem(${key});` +
    "if(!raw)return;" +
    "var envelope=JSON.parse(raw);" +
    "var page=envelope&&envelope.d&&envelope.d.firstPage;" +
    `var target=(${paths})[page];` +
    'if(target&&target!=="/"){location.replace(target);}' +
    "}catch(e){}" +
    "})();"
  );
}
