import { describe, expect, it } from "vitest";

import { hasColumns, parseCsvRows, parseCsvTable } from "./csv";

/**
 * The parser is hand-rolled (see the header comment in csv.ts), so these tests
 * ARE the justification for that choice. They lean deliberately on the cases
 * real exports actually contain — commas inside titles, embedded newlines in
 * IMDb descriptions, BOMs — rather than on tidy synthetic input.
 */

describe("parseCsvRows", () => {
  it("parses a plain grid", () => {
    expect(parseCsvRows("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("keeps commas inside quoted fields", () => {
    // The single most common real case: Letterboxd film titles.
    expect(parseCsvRows('Name,Year\n"Dinner, Then Bed",2019')).toEqual([
      ["Name", "Year"],
      ["Dinner, Then Bed", "2019"],
    ]);
  });

  it("keeps newlines inside quoted fields", () => {
    // IMDb watchlist `Description` columns contain these.
    expect(parseCsvRows('a,b\n"line one\nline two",x')).toEqual([
      ["a", "b"],
      ["line one\nline two", "x"],
    ]);
  });

  it("unescapes doubled quotes", () => {
    expect(parseCsvRows('t\n"He said ""hi"""')).toEqual([["t"], ['He said "hi"']]);
  });

  it("handles a quoted field that is only an escaped quote", () => {
    expect(parseCsvRows('a\n""""')).toEqual([["a"], ['"']]);
  });

  it("handles CRLF, LF and lone CR, mixed in one file", () => {
    expect(parseCsvRows("a,b\r\n1,2\n3,4\r5,6")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
      ["5", "6"],
    ]);
  });

  it("does not treat a CRLF inside quotes as a row break", () => {
    expect(parseCsvRows('a\n"x\r\ny"')).toEqual([["a"], ["x\r\ny"]]);
  });

  it("strips a leading BOM without eating the first header", () => {
    expect(parseCsvRows("﻿Const,Title\ntt1,X")).toEqual([
      ["Const", "Title"],
      ["tt1", "X"],
    ]);
  });

  it("does not invent a trailing row for a file ending in a newline", () => {
    expect(parseCsvRows("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps the final row when the file does not end in a newline", () => {
    expect(parseCsvRows("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("preserves empty fields, including trailing ones", () => {
    expect(parseCsvRows("a,b,c\n1,,3\n4,5,")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
      ["4", "5", ""],
    ]);
  });

  it("returns nothing for empty input", () => {
    expect(parseCsvRows("")).toEqual([]);
  });

  it("does not lose data from an unterminated quoted field", () => {
    // Malformed, but truncating the user's row silently would be worse than
    // taking what is there and letting a downstream validity check catch it.
    expect(parseCsvRows('a\n"unterminated')).toEqual([["a"], ["unterminated"]]);
  });
});

describe("parseCsvTable", () => {
  const table = parseCsvTable(
    'Const,Your Rating,Title,Year\ntt0068646,10,"The Godfather",1972\ntt0071562,9,"Godfather, The: Part II",1974',
  );

  it("exposes headers and one record per data row", () => {
    expect(table.headers).toEqual(["Const", "Your Rating", "Title", "Year"]);
    expect(table.rows).toHaveLength(2);
  });

  it("addresses columns by name", () => {
    expect(table.rows[0].get("Const")).toBe("tt0068646");
    expect(table.rows[1].get("Title")).toBe("Godfather, The: Part II");
  });

  it("looks columns up case- and whitespace-insensitively", () => {
    // IMDb has shipped both `Const` and `const` across format revisions.
    expect(table.rows[0].get("const")).toBe("tt0068646");
    expect(table.rows[0].get("  YOUR RATING  ")).toBe("10");
  });

  it("reports line numbers matching a text editor, header included", () => {
    expect(table.rows[0].line).toBe(2);
    expect(table.rows[1].line).toBe(3);
  });

  it("returns null for an absent column rather than throwing", () => {
    expect(table.rows[0].get("Nonexistent")).toBeNull();
    expect(table.rows[0].has("Nonexistent")).toBe(false);
    expect(table.rows[0].has("Title")).toBe(true);
  });

  it("collapses an empty cell to null", () => {
    const t = parseCsvTable("a,b\n1,");
    expect(t.rows[0].get("b")).toBeNull();
  });

  it("reads missing columns of a SHORT row as null instead of rejecting the file", () => {
    // One malformed line must not fail the import for every row that was fine.
    const t = parseCsvTable("a,b,c\n1,2");
    expect(t.rows[0].get("a")).toBe("1");
    expect(t.rows[0].get("c")).toBeNull();
  });

  it("ignores blank lines between records", () => {
    const t = parseCsvTable("a\n1\n\n2\n");
    expect(t.rows.map((r) => r.get("a"))).toEqual(["1", "2"]);
  });

  it("prefers the FIRST of a duplicated column name", () => {
    // Malformed input either way; silently preferring the last one would be a
    // surprising way to lose data.
    const t = parseCsvTable("a,a\nfirst,second");
    expect(t.rows[0].get("a")).toBe("first");
  });

  it("survives a header-only file", () => {
    const t = parseCsvTable("a,b\n");
    expect(t.headers).toEqual(["a", "b"]);
    expect(t.rows).toEqual([]);
  });

  it("survives an entirely empty file", () => {
    expect(parseCsvTable("")).toEqual({ headers: [], rows: [] });
  });
});

describe("hasColumns", () => {
  const table = parseCsvTable("Const,Your Rating,Date Rated,Title\ntt1,8,2020-01-01,X");

  it("identifies an export by its header, not its filename", () => {
    expect(hasColumns(table, ["Const", "Your Rating", "Date Rated"])).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(hasColumns(table, ["const", "your rating"])).toBe(true);
  });

  it("is false when any required column is missing", () => {
    expect(hasColumns(table, ["Const", "Watched Date"])).toBe(false);
  });
});
