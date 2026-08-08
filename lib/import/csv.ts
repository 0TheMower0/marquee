/**
 * An RFC 4180 CSV parser.
 *
 * ============================================================================
 * WHY HAND-ROLLED
 * ============================================================================
 * The same argument `components/ui/icons.tsx` makes for icons and
 * `components/stats/` makes for charts: no dependency, no API surface, nothing
 * to keep in sync. But it is worth being honest that CSV is genuinely subtler
 * than an SVG path — quoted fields containing commas and newlines, escaped
 * quotes, BOMs, three line-ending conventions — so the tests are what make
 * this defensible, not the line count.
 *
 * The deciding difference from the one case where this project *did* reject
 * hand-rolling (SHA-1 lives in `lib/sync/uuid.ts` precisely because two
 * implementations would silently diverge and corrupt primary keys): a CSV
 * parsing bug is **visible**. It produces a mangled title the user sees in the
 * review queue, not an invisible id collision discovered months later.
 *
 * Runs inside a Web Worker (`lib/import/worker.ts`), so a 10,000-row file
 * costs the main thread nothing. The character-at-a-time loop is not the
 * fastest possible shape — a scan-and-slice would beat it — but at ~500KB it
 * is single-digit milliseconds off the main thread, and correctness here is
 * worth more than the difference.
 */

/** Byte-order mark. Excel writes one; IMDb exports have been seen with one. */
const BOM = 0xfeff;

/**
 * Splits CSV text into raw rows of raw fields. No header handling, no
 * trimming, no type coercion — those are `parseCsvTable`'s job.
 *
 * Handles, because real exports contain all of them:
 * - `"quoted, field"` — Letterboxd titles contain commas constantly
 * - `"embedded\nnewline"` — descriptions in IMDb watchlist exports
 * - `"escaped "" quote"`
 * - CRLF, LF, and lone-CR line endings, mixed within one file
 * - a leading BOM
 * - a final row with no trailing newline
 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = text.charCodeAt(0) === BOM ? 1 : 0;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      endField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      // CRLF consumes both; a lone CR (classic Mac) is still a row break.
      i += text[i + 1] === "\n" ? 2 : 1;
      endRow();
      continue;
    }
    if (ch === "\n") {
      i += 1;
      endRow();
      continue;
    }

    field += ch;
    i += 1;
  }

  // A file ending WITH a newline leaves nothing pending, and must not produce
  // a phantom trailing row of one empty field. A file ending WITHOUT one has a
  // real final row still in hand.
  if (field.length > 0 || row.length > 0) endRow();

  return rows;
}

/**
 * One data row, addressed by column name.
 *
 * Column lookup is case- and whitespace-insensitive because the exports are
 * not stable on either: IMDb has shipped both `Const` and `const` across
 * format revisions, and hand-edited files pick up stray spaces. Being strict
 * here would reject a file that is otherwise perfectly readable.
 */
export interface CsvRecord {
  /** 1-based line in the original file, counting the header row — so it
   *  matches what a text editor shows the user. */
  line: number;
  /** Trimmed value, or null when the column is absent or empty. Empty-string
   *  and missing collapse deliberately: no consumer distinguishes them, and
   *  every one of them would otherwise need the same `|| null`. */
  get(column: string): string | null;
  has(column: string): boolean;
}

export interface CsvTable {
  headers: string[];
  rows: CsvRecord[];
}

function normalizeHeader(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Parses to a header-addressed table.
 *
 * Rows with a different field count than the header are NOT rejected: a short
 * row reads its missing columns as null, and a long row's extras are
 * unreachable. Real exports contain both (a trailing comma, an unescaped quote
 * upstream), and refusing the whole file over one malformed line would fail
 * the import for the rows that were fine. A row that then yields no usable
 * title is caught downstream and surfaced in the preview's "failed" bucket,
 * where the user can see the line number.
 */
export function parseCsvTable(text: string): CsvTable {
  const raw = parseCsvRows(text);
  if (raw.length === 0) return { headers: [], rows: [] };

  const headers = raw[0].map((h) => h.trim());
  const index = new Map<string, number>();
  headers.forEach((header, position) => {
    const key = normalizeHeader(header);
    // First occurrence wins — a duplicated column name is malformed, and
    // silently preferring the last one would be a surprising way to lose data.
    if (!index.has(key)) index.set(key, position);
  });

  const rows: CsvRecord[] = [];
  for (let r = 1; r < raw.length; r += 1) {
    const fields = raw[r];
    // A blank trailing line parses as one empty field; it is not a record.
    if (fields.length === 1 && fields[0].trim() === "") continue;

    rows.push({
      line: r + 1,
      has(column) {
        return index.has(normalizeHeader(column));
      },
      get(column) {
        const position = index.get(normalizeHeader(column));
        if (position === undefined) return null;
        const value = fields[position];
        if (value === undefined) return null;
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
      },
    });
  }

  return { headers, rows };
}

/** Whether every named column is present. Used to identify WHICH export a
 *  file is (an IMDb ratings export vs. a watchlist export) from its header
 *  alone, rather than trusting the filename — people rename downloads. */
export function hasColumns(table: CsvTable, required: readonly string[]): boolean {
  const present = new Set(table.headers.map(normalizeHeader));
  return required.every((column) => present.has(normalizeHeader(column)));
}
