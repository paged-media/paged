// Wave 6 query lane, pure parts: the builders' SQL, the guard's lexer,
// Store errors → diagnostics, file naming and quoting. The same SQL is
// run against the real store in test/sources-real.spec.ts.

import { describe, expect, it } from "bun:test";

import { buildSql, valueLiteral } from "../query/builder";
import {
  decodeDelimitedText,
  formatOfFile,
  quoteIdent,
  quoteLiteral,
  sourceNameOf,
} from "../query/import";
import {
  checkQuery,
  diagnoseStoreError,
  positionOf,
  tablesRead,
  trimSql,
} from "../query/sql";
import { ALLOWED, REFUSED } from "../../test/guard-matrix";

describe("file names and quoting [data.source.adapters]", () => {
  it("maps extensions to formats, case-insensitively", () => {
    expect(formatOfFile("A.CSV")).toBe("csv");
    expect(formatOfFile("x.tsv")).toBe("tsv");
    expect(formatOfFile("feed.jsonl")).toBe("json");
    expect(formatOfFile("feed.ndjson")).toBe("json");
    expect(formatOfFile("p.parquet")).toBe("parquet");
    expect(formatOfFile("Budget 2026.xlsx")).toBe("xlsx");
    expect(formatOfFile("old.xls")).toBeNull();
    expect(formatOfFile("noext")).toBeNull();
  });

  it("names a source after the file stem, as an identifier", () => {
    expect(sourceNameOf("Budget 2026.xlsx")).toBe("Budget_2026");
    expect(sourceNameOf("/tmp/dir/2026-sales.csv")).toBe("_2026_sales");
    expect(sourceNameOf(".parquet")).toBe("data");
  });

  it("quotes identifiers and literals so a name can never become SQL", () => {
    expect(quoteIdent('a"b')).toBe('"a""b"');
    expect(quoteLiteral("it's")).toBe("'it''s'");
  });
});

describe("a delimited file's encoding [data.source.adapters]", () => {
  const utf16 = (text: string, little: boolean) => {
    const out = new Uint8Array(2 + text.length * 2);
    const view = new DataView(out.buffer);
    view.setUint16(0, 0xfeff, little);
    for (let i = 0; i < text.length; i++)
      view.setUint16(2 + i * 2, text.charCodeAt(i), little);
    return out;
  };

  it("reads UTF-8 with and without a byte-order mark, exactly", () => {
    const plain = new TextEncoder().encode("name\nMüller €\n");
    expect(decodeDelimitedText(plain)).toEqual({
      text: "name\nMüller €\n",
      encoding: "utf-8",
    });
    const marked = new Uint8Array([0xef, 0xbb, 0xbf, ...plain]);
    expect(decodeDelimitedText(marked)).toEqual({
      text: "name\nMüller €\n",
      encoding: "utf-8",
    });
    expect(decodeDelimitedText(new Uint8Array())).toEqual({
      text: "",
      encoding: "utf-8",
    });
  });

  it("reads UTF-16 by its byte-order mark, either byte order", () => {
    expect(decodeDelimitedText(utf16("a\tb\nMüller\t€\n", true))).toEqual({
      text: "a\tb\nMüller\t€\n",
      encoding: "utf-16le",
    });
    expect(decodeDelimitedText(utf16("a,b\nMüller,€\n", false))).toEqual({
      text: "a,b\nMüller,€\n",
      encoding: "utf-16be",
    });
  });

  it("reads bytes that are not UTF-8 as Windows-1252 and says so, replacing nothing", () => {
    // "Müller;5 €" as a spreadsheet's CSV export writes it: ü = FC, € = 80.
    const bytes = new Uint8Array([
      0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72, 0x3b, 0x35, 0x20, 0x80, 0x0a,
    ]);
    const d = decodeDelimitedText(bytes);
    expect(d.text).toBe("Müller;5 €\n");
    expect(d.text).not.toContain("\ufffd");
    expect(d.encoding).toBe("windows-1252");
    expect(d.note).toMatch(/not UTF-8.*Windows-1252/);
  });

  it("counts what a broken UTF-16 file could not give", () => {
    // A lone high surrogate, little-endian, then "a".
    const d = decodeDelimitedText(
      new Uint8Array([0xff, 0xfe, 0x00, 0xd8, 0x61, 0x00]),
    );
    expect(d.encoding).toBe("utf-16le");
    expect(d.text).toBe("\ufffda");
    expect(d.note).toMatch(/1 character could not be read/);
  });
});

describe("query builders [data.query.seam]", () => {
  it("builds a filtered, sorted, limited SELECT", () => {
    expect(
      buildSql({
        source: "products",
        columns: ["sku", "price"],
        filters: [
          { column: "price", op: ">", value: "10" },
          { column: "sku", op: "starts with", value: "A'" },
          { column: "note", op: "is empty" },
          { column: "", op: "=", value: "ignored" },
        ],
        sort: [
          { column: "price", dir: "desc" },
          { column: "sku", dir: "asc" },
        ],
        limit: 5,
      }),
    ).toBe(
      [
        'SELECT "sku", "price"',
        'FROM "products"',
        `WHERE "price" > 10 AND substr(CAST("sku" AS TEXT), 1, 2) = 'A''' AND ("note" IS NULL OR CAST("note" AS TEXT) = '')`,
        'ORDER BY "price" DESC, "sku" ASC',
        "LIMIT 5",
      ].join("\n"),
    );
  });

  it("groups with a row count by default, and named aggregates", () => {
    expect(buildSql({ source: "t", groupBy: ["region"] })).toBe(
      'SELECT "region", count(*) AS "count"\nFROM "t"\nGROUP BY "region"',
    );
    expect(
      buildSql({
        source: "t",
        groupBy: ["region", "year"],
        aggregates: [{ fn: "sum", column: "amount" }, { fn: "avg" }],
      }),
    ).toBe(
      'SELECT "region", "year", sum("amount") AS "sum_amount", count(*) AS "count"\nFROM "t"\nGROUP BY "region", "year"',
    );
  });

  it("compares a numeric-looking value as a number and anything else as text", () => {
    expect(valueLiteral("12.5")).toBe("12.5");
    expect(valueLiteral("-3")).toBe("-3");
    expect(valueLiteral("1e3")).toBe("1e3");
    expect(valueLiteral("12 items")).toBe("'12 items'");
    expect(valueLiteral("x'); DROP TABLE t; --")).toBe(
      "'x''); DROP TABLE t; --'",
    );
  });
});

describe("the query guard's lexer and allow-list [data.security.gates]", () => {
  it("refuses every reach in the shared security matrix", () => {
    for (const [sql, why] of REFUSED) {
      const v = checkQuery(sql);
      expect(v?.kind, sql).toBe("Guard");
      expect(v?.message, sql).toMatch(why);
    }
  });

  it("admits every ordinary query in the shared matrix", () => {
    for (const [sql] of ALLOWED) expect(checkQuery(sql), sql).toBeNull();
  });

  it("reads strings, quoted names and comments the way SQLite does", () => {
    // Statement words inside strings, quoted names and comments are data.
    expect(
      checkQuery("SELECT 'DROP TABLE x; read_csv(1)' AS s FROM t"),
    ).toBeNull();
    expect(checkQuery('SELECT "update", "set" FROM t')).toBeNull();
    expect(checkQuery("SELECT 1 /* a ; comment */ FROM t")).toBeNull();
    expect(checkQuery("SELECT 1 -- DROP TABLE x\nFROM t")).toBeNull();
    expect(
      checkQuery("SELECT `update`, `it``s`, `a'b`, `c--d` FROM t"),
    ).toBeNull();
    expect(
      tablesRead("SELECT * FROM `orders` JOIN main.`lines` USING (id)"),
    ).toEqual(["orders", "lines"]);
    // A bare statement word is refused, with a hint and a position.
    expect(checkQuery("SELECT update FROM t")).toMatchObject({
      kind: "Guard",
      message: expect.stringMatching(/UPDATE is not allowed.*"update"/),
      line: 1,
      column: 8,
    });
  });

  it("ends a comment where the store does, at the first */", () => {
    // The store does not nest comments: everything after the first `*/` runs.
    // A nesting lexer read these as one comment and admitted them.
    for (const sql of [
      "SELECT 1 /* /* */ ; PRAGMA query_only = 0 -- */ */",
      "SELECT * FROM /* /* */ read_csv('/etc/passwd') -- */ */",
      "SELECT 1 /* outer /* nested ; */ still comment ; */ FROM t",
    ]) {
      expect(checkQuery(sql), sql).toMatchObject({
        kind: "Guard",
        message: expect.stringMatching(/comment inside a comment/),
      });
    }
    // Code after a closed comment is checked.
    expect(
      checkQuery("SELECT 1 /* x */ FROM read_csv('y') /* z */")?.message,
    ).toMatch(/read_csv\(\)/);
    expect(checkQuery("SELECT 1 /* open")?.message).toMatch(/not terminated/);
  });

  it("reads a backtick name as a name, so a quote inside it opens no string", () => {
    // The store reads `'` as a column name; read as code, the two quotes
    // made one string that hid the table function between them.
    const hidden = "SELECT `'`, x FROM read_csv('a') WHERE `'` = 1";
    expect(checkQuery(hidden)?.message).toMatch(/read_csv\(\)/);
    expect(
      checkQuery('SELECT `"`, x FROM t; DROP TABLE t -- `"`')?.message,
    ).toMatch(/exactly one SELECT/);
    expect(checkQuery("SELECT `--`, x FROM read_csv('a')")?.message).toMatch(
      /read_csv\(\)/,
    );
    // A backtick name in a table position follows the table rules.
    expect(checkQuery("SELECT * FROM `/etc/passwd`")?.message).toMatch(
      /not an imported source table/,
    );
    expect(checkQuery("SELECT * FROM `read_csv`('a')")?.message).toMatch(
      /read_csv/,
    );
    expect(checkQuery("SELECT `a FROM t")?.message).toMatch(/not terminated/);
  });

  it("counts only the store's whitespace as space", () => {
    // U+00A0 is a name character to the store: `FROM\u00a0t` is one word.
    expect(tablesRead("SELECT 1 FROM\u00a0t")).toEqual([]);
    expect(checkQuery("SELECT\t1\r\nFROM\ft")).toBeNull();
  });

  it("knows FROM inside function arguments and IS DISTINCT FROM is not a table", () => {
    expect(
      checkQuery(
        "SELECT extract(year FROM d), substring(s FROM 2 FOR 3), trim(BOTH 'x' FROM s) FROM t",
      ),
    ).toBeNull();
    expect(
      checkQuery("SELECT * FROM t WHERE a IS NOT DISTINCT FROM 'x'"),
    ).toBeNull();
    // …but a subquery inside such a call has a real FROM.
    expect(
      checkQuery(
        "SELECT substring((FROM read_csv('x') SELECT 'a') FROM 1) FROM t",
      )?.message,
    ).toMatch(/read_csv\(\)/);
  });

  it("refuses unbalanced brackets, so the text cannot escape the preview wrapper", () => {
    const escape = "SELECT 1) AS a, read_csv('x') AS b, (SELECT 1";
    expect(checkQuery(escape)?.message).toMatch(/unbalanced brackets/);
    expect(checkQuery("SELECT (1")?.message).toMatch(/unbalanced brackets/);
    expect(checkQuery("SELECT [1, 2)")?.message).toMatch(/unbalanced brackets/);
  });

  it("allows list and struct literals and commas in a join condition", () => {
    expect(checkQuery("SELECT [1, 2], {'a': 1, 'b': 2} FROM t")).toBeNull();
    expect(
      checkQuery("SELECT * FROM a JOIN b ON (a.x, a.y) = (b.x, b.y), c"),
    ).toBeNull();
    expect(
      checkQuery("SELECT * FROM a JOIN b USING (x, y) ORDER BY 1, 2"),
    ).toBeNull();
    expect(
      checkQuery("SELECT * FROM a JOIN b ON a.x = b.x, read_csv('y')")?.message,
    ).toMatch(/read_csv/);
  });
});

describe("store errors → diagnostics [data.query.seam]", () => {
  it("reads the kind and turns the byte offset into a line and column", () => {
    // `é` is two bytes: the offset counts bytes, the column characters.
    const sql = "SELECT 'é',\n  1::INT";
    const err = Object.assign(new Error('Parser: near ":": syntax error'), {
      kind: "Parser",
      offset: new TextEncoder().encode("SELECT 'é',\n  1").length,
    });
    expect(diagnoseStoreError(err, sql)).toEqual({
      kind: "Parser",
      message: 'near ":": syntax error',
      line: 2,
      column: 4,
    });
  });

  it("keeps a message without a position as it is", () => {
    const err = Object.assign(new Error("Catalog: no such table: x"), {
      kind: "Catalog",
    });
    expect(diagnoseStoreError(err, "SELECT * FROM x")).toEqual({
      kind: "Catalog",
      message: "no such table: x",
    });
    expect(diagnoseStoreError(new Error("boom"))).toEqual({
      kind: "Error",
      message: "boom",
    });
  });

  it("trims a query and finds a position", () => {
    expect(trimSql("  SELECT 1 ;;\n")).toBe("SELECT 1");
    expect(positionOf("ab\ncd", 4)).toEqual({ line: 2, column: 2 });
  });
});
