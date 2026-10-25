// The query lane's SQL hygiene (wave 6; the store since ADR 561): the guard
// every user or document query passes before the store runs it, and the
// store's error turned into a diagnostic with a position.
//
// The guard is a lexer and an allow-list in TypeScript; it asks the engine
// nothing. (The first guard parsed with DuckDB's `json_serialize_sql`, which
// lived in an extension DuckDB fetched from the network: under the editor's
// CSP that trapped the worker. A guard that runs no engine cannot.)
//
// The lexer follows SQLite's rules for what is code and what is not, where
// they agree with PostgreSQL's: '…' strings with '' escapes, "…" identifiers
// with "" escapes, -- line comments and /* */ comments. Anything whose lexing
// differs between dialects is refused outright: E'…' escape strings, U&'…'
// strings, $-quoting and $ parameters. (SQLite's `[…]` and `\`…\`` names lex
// here as punctuation and words, so nothing inside them escapes the checks.)
// Then:
//   · exactly one statement (no `;`), with balanced brackets;
//   · it starts with SELECT, WITH, FROM, VALUES or `(`;
//   · no statement keyword anywhere (DELETE, ATTACH, PRAGMA, VACUUM, …);
//   · every table position — after FROM, JOIN, a comma in a FROM list, a `(`
//     that opens a FROM item — holds a plain table name (or `main.` name), a
//     subquery, or an allowed table function. A string there (SQLite reads a
//     string in a table position as a name) or any other table function is
//     refused.
// The store adds its own refusal: user queries run on a connection in
// `query_only` mode, so a write that got past the guard would still fail.
// That mode is not enough alone — Turso lets a reader lift it with
// `PRAGMA query_only = 0` (pinned in data-store's spike) — which is one more
// reason PRAGMA is a statement word here.

/** A query problem the panel can point at. `line`/`column` are 1-based,
 *  in the query text as the user wrote it. */
export interface SqlDiagnostic {
  /** The store's error class (`Parser`, `Catalog`, `ReadOnly`, `Read`, …)
   *  or `Guard`. */
  kind: string;
  message: string;
  line?: number;
  column?: number;
}

/** Table functions that read no file and no URL (SQLite's, in Turso). */
const PURE_TABLE_FUNCTIONS = new Set([
  "generate_series",
  "json_each",
  "json_tree",
]);
const PLAIN_TABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Words that start or belong to a statement other than a SELECT. Refused
 *  anywhere as bare words (a column with such a name is written quoted). */
const STATEMENT_WORDS = new Set([
  "ABORT",
  "ALTER",
  "ANALYZE",
  "ATTACH",
  "BEGIN",
  "CALL",
  "CHECKPOINT",
  "COMMIT",
  "COPY",
  "CREATE",
  "DEALLOCATE",
  "DELETE",
  "DESCRIBE",
  "DETACH",
  "DROP",
  "EXECUTE",
  "EXPLAIN",
  "EXPORT",
  "FORCE",
  "IMPORT",
  "INSERT",
  "INSTALL",
  "LOAD",
  "MERGE",
  "PRAGMA",
  "PREPARE",
  "RESET",
  "ROLLBACK",
  "SET",
  "SHOW",
  "SUMMARIZE",
  "TRUNCATE",
  "UPDATE",
  "UPSERT",
  "USE",
  "VACUUM",
]);
/** Words that may open a query. FROM stays: a FROM-first query is not
 *  SQLite's, but the guard checks its tables rather than relying on that. */
const QUERY_STARTS = new Set(["SELECT", "WITH", "FROM", "VALUES"]);
/** Words that end a FROM list at their nesting level. */
const FROM_LIST_ENDS = new Set([
  "WHERE",
  "GROUP",
  "HAVING",
  "QUALIFY",
  "WINDOW",
  "ORDER",
  "LIMIT",
  "OFFSET",
  "UNION",
  "EXCEPT",
  "INTERSECT",
  "SELECT",
  "FETCH",
  "USING",
  "RETURNING",
]);
/** Functions whose argument syntax uses FROM without naming a table
 *  (`EXTRACT(year FROM d)`, `SUBSTRING(s FROM 2)`, `TRIM(BOTH FROM s)`). */
const FROM_IN_ARGUMENTS = new Set([
  "extract",
  "substring",
  "trim",
  "overlay",
  "position",
]);

type TokenKind = "word" | "qident" | "string" | "number" | "punct";
interface Token {
  kind: TokenKind;
  /** The word as written, the identifier or string unquoted, the punctuation. */
  value: string;
  /** 0-based offset in the text. */
  at: number;
  /** Text ends right before this token (no space between). */
  adjacent: boolean;
}

class GuardError extends Error {
  constructor(
    message: string,
    readonly at?: number,
  ) {
    super(message);
  }
}

/** Strip trailing semicolons and whitespace. */
export function trimSql(sql: string): string {
  return sql.replace(/[\s;]+$/, "").trim();
}

/** 1-based line/column of a 0-based character offset. */
export function positionOf(
  text: string,
  offset: number,
): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const lines = before.split("\n");
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

/** Split SQL into tokens the way SQLite's lexer does, refusing every form
 *  whose lexing is not plain (see the header). */
function lex(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let lastEnd = -1;
  const push = (kind: TokenKind, value: string, at: number, end: number) => {
    out.push({ kind, value, at, adjacent: at === lastEnd });
    lastEnd = end;
  };
  const quoted = (q: string, kind: TokenKind, what: string) => {
    const at = i;
    let v = "";
    i++;
    for (;;) {
      if (i >= text.length)
        throw new GuardError(`${what} is not terminated`, at);
      if (text[i] === q) {
        if (text[i + 1] === q) {
          v += q;
          i += 2;
          continue;
        }
        i++;
        break;
      }
      v += text[i++];
    }
    push(kind, v, at, i);
  };
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "-" && text[i + 1] === "-") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const at = i;
      let depth = 0;
      do {
        if (i >= text.length)
          throw new GuardError("a comment is not terminated", at);
        if (text[i] === "/" && text[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (text[i] === "*" && text[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      } while (depth > 0);
    } else if (c === "'") {
      const prev = out[out.length - 1];
      if (
        prev &&
        lastEnd === i &&
        prev.kind === "word" &&
        /^[eE]$/.test(prev.value)
      ) {
        throw new GuardError(
          "an escape string (E'…') cannot be used in a data query",
          prev.at,
        );
      }
      if (
        prev &&
        lastEnd === i &&
        prev.kind === "punct" &&
        prev.value === "&"
      ) {
        throw new GuardError(
          "a Unicode escape string (U&'…') cannot be used in a data query",
          prev.at,
        );
      }
      quoted("'", "string", "a string");
    } else if (c === '"') {
      quoted('"', "qident", "a quoted name");
    } else if (c === "$") {
      throw new GuardError(
        "dollar-quoted strings and $ parameters cannot be used in a data query",
        i,
      );
    } else if (
      /[0-9]/.test(c) ||
      (c === "." && /[0-9]/.test(text[i + 1] ?? ""))
    ) {
      const m =
        /^(?:[0-9][0-9_]*(?:\.[0-9_]*)?|\.[0-9][0-9_]*)(?:[eE][+-]?[0-9]+)?/.exec(
          text.slice(i),
        )!;
      push("number", m[0], i, i + m[0].length);
      i += m[0].length;
    } else if (/[A-Za-z_\u0080-\uffff]/.test(c)) {
      const m = /^[A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*/.exec(
        text.slice(i),
      )!;
      push("word", m[0], i, i + m[0].length);
      i += m[0].length;
    } else {
      push("punct", c, i, i + 1);
      i++;
    }
  }
  return out;
}

const isWord = (t: Token | undefined, w: string) =>
  t?.kind === "word" && t.value.toUpperCase() === w;
const isPunct = (t: Token | undefined, p: string) =>
  t?.kind === "punct" && t.value === p;
const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const CLOSE = new Set([")", "]", "}"]);

const fileReach = (name: string) =>
  `the table function ${name}() reads files or URLs — import the data as a source and query its table`;
const notATable = (name: string) =>
  `"${name}" is not an imported source table — a query reads source tables only`;

/** The allow-list walk over the tokens. Throws a GuardError at the first
 *  thing a data query may not do. Each table a FROM or JOIN names goes into
 *  `tables` (a CTE's name among them). */
function walk(tokens: Token[], tables?: string[]): void {
  if (tokens.length === 0) throw new GuardError("the query is empty");
  const semi = tokens.find((t) => isPunct(t, ";"));
  if (semi)
    throw new GuardError(
      "a data query is exactly one SELECT statement",
      semi.at,
    );
  const first = tokens[0];
  if (!(
    isPunct(first, "(") ||
    (first.kind === "word" && QUERY_STARTS.has(first.value.toUpperCase()))
  )) {
    throw new GuardError("only a SELECT query can be a data query", first.at);
  }
  for (const t of tokens) {
    if (t.kind === "word" && STATEMENT_WORDS.has(t.value.toUpperCase())) {
      const w = t.value.toUpperCase();
      throw new GuardError(
        `${w} is not allowed in a data query (a column named ${t.value} is written quoted: "${t.value}")`,
        t.at,
      );
    }
  }

  // One frame per open bracket: the closing bracket it expects, whether a
  // FROM list is open at this level, and the function the bracket calls.
  interface Frame {
    close: string;
    fromList: boolean;
    callee: string;
  }
  const stack: Frame[] = [{ close: "", fromList: false, callee: "" }];
  const top = () => stack[stack.length - 1];
  let expectTable = false;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if (expectTable) {
      if (isWord(t, "LATERAL")) continue;
      expectTable = false;
      if (isPunct(t, "(")) {
        // A subquery, or a parenthesised join whose first item is a table.
        const sub =
          next?.kind === "word" && QUERY_STARTS.has(next.value.toUpperCase());
        stack.push({ close: ")", fromList: !sub, callee: "" });
        expectTable = !sub;
        continue;
      }
      if (t.kind === "string") throw new GuardError(notATable(t.value), t.at);
      if (t.kind !== "word" && t.kind !== "qident")
        throw new GuardError("a FROM item must be a source table", t.at);
      // A (possibly qualified) name: word or "quoted", joined by dots.
      const parts = [t];
      let j = i;
      while (
        isPunct(tokens[j + 1], ".") &&
        (tokens[j + 2]?.kind === "word" || tokens[j + 2]?.kind === "qident")
      ) {
        parts.push(tokens[j + 2]);
        j += 2;
      }
      const name = parts.map((p) => p.value).join(".");
      if (isPunct(tokens[j + 1], "(")) {
        if (
          parts.length === 1 &&
          t.kind === "word" &&
          PURE_TABLE_FUNCTIONS.has(t.value.toLowerCase())
        ) {
          i = j;
          continue; // its arguments are expressions: the `(` opens a frame below
        }
        throw new GuardError(fileReach(name), t.at);
      }
      const table = parts[parts.length - 1].value;
      const schema = parts.length === 2 ? parts[0].value.toLowerCase() : "";
      if (
        !PLAIN_TABLE.test(table) ||
        parts.length > 2 ||
        (parts.length === 2 && schema !== "main")
      ) {
        throw new GuardError(notATable(name), t.at);
      }
      tables?.push(table);
      i = j;
      continue;
    }
    if (t.kind === "punct" && OPEN[t.value]) {
      const prev = tokens[i - 1];
      stack.push({
        close: OPEN[t.value],
        fromList: false,
        callee: prev?.kind === "word" ? prev.value.toLowerCase() : "",
      });
      continue;
    }
    if (t.kind === "punct" && CLOSE.has(t.value)) {
      if (stack.length === 1 || top().close !== t.value) {
        throw new GuardError(
          `unbalanced brackets: "${t.value}" closes nothing`,
          t.at,
        );
      }
      stack.pop();
      continue;
    }
    if (isPunct(t, ",") && top().fromList) {
      expectTable = true;
      continue;
    }
    if (t.kind !== "word") continue;
    const w = t.value.toUpperCase();
    if (w === "FROM") {
      const p1 = tokens[i - 1];
      const p2 = tokens[i - 2];
      const distinctFrom =
        isWord(p1, "DISTINCT") && (isWord(p2, "IS") || isWord(p2, "NOT"));
      if (distinctFrom || FROM_IN_ARGUMENTS.has(top().callee)) continue;
      top().fromList = true;
      expectTable = true;
    } else if (w === "JOIN") {
      expectTable = true;
    } else if (FROM_LIST_ENDS.has(w)) {
      top().fromList = false;
    }
  }
  if (stack.length !== 1)
    throw new GuardError(`unbalanced brackets: a "${top().close}" is missing`);
}

/** The tables a query's FROM and JOIN items name, each once, in the order
 *  they are written (the Data panel's pipeline: what a query reads). A
 *  query the guard refuses names none. A CTE's own name is among them: the
 *  caller keeps the names of tables it knows. */
export function tablesRead(sql: string): string[] {
  const found: string[] = [];
  try {
    walk(lex(trimSql(sql)), found);
  } catch (err) {
    if (!(err instanceof GuardError)) throw err;
    return [];
  }
  return [...new Set(found)];
}

/** Check one query. Returns null when it may run. Pure: asks the engine
 *  nothing, so it is the same in Node, in the browser and offline. */
export function checkQuery(sql: string): SqlDiagnostic | null {
  const text = trimSql(sql);
  try {
    walk(lex(text));
    return null;
  } catch (err) {
    if (!(err instanceof GuardError)) throw err;
    return {
      kind: "Guard",
      message: err.message,
      ...(err.at !== undefined ? positionOf(text, err.at) : {}),
    };
  }
}

/** Check one query (the session's entry point; see [`checkQuery`]). */
export async function guardQuery(sql: string): Promise<SqlDiagnostic | null> {
  return checkQuery(sql);
}

/** A store failure → a diagnostic. The engine's `Error` carries `kind`
 *  (`Parser`, `Catalog`, `ReadOnly`, `Read`, …) and, when it knows,
 *  `offset`: a byte offset into `sql`, the text that ran. */
export function diagnoseStoreError(err: unknown, sql = ""): SqlDiagnostic {
  const message = err instanceof Error ? err.message : String(err);
  const fields = (typeof err === "object" && err !== null ? err : {}) as {
    kind?: unknown;
    offset?: unknown;
  };
  const kind = typeof fields.kind === "string" ? fields.kind : "Error";
  // The message starts with the kind (`Parser: near ":": syntax error`).
  const text = message.startsWith(`${kind}: `)
    ? message.slice(kind.length + 2)
    : message;
  if (typeof fields.offset !== "number" || sql === "")
    return { kind, message: text };
  const bytes = new TextEncoder().encode(sql);
  const chars = new TextDecoder().decode(bytes.slice(0, fields.offset)).length;
  return { kind, message: text, ...positionOf(sql, chars) };
}
