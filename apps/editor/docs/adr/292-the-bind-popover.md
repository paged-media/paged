# ADR 292 — The bind popover: field, rules, map or expression on any property field

- **Status:** Accepted 2026-10-24.
- **Scope:** `packages/shell/src/catalog/bind-popover.tsx`, `bind-expr.ts`, `object-field.tsx`
  (`useBindToData`); `DataService.evaluate` and `DataSurface.evaluate` (plugin-api, plugin-sdk
  0.74.3-canary.20); `ResolutionEngine::evaluate_at`, `DataSession::evaluate_at`, the wasm
  `evaluate_at` and paged.data's door. Decided by
  [PM-0015](../../../../docs/adr/PM-0015-data-and-actions-are-platform-layers.md) (record
  "editor 292"). It changes the shell's "Bind to data…" (plan task E10), which handed paged.data
  a `(selector, path, schema)` request through its `bindProperty` command.

## Context

Every property field offers "Bind to data…" (paged.data ADR 558). It resolved a durable
target and handed paged.data's command a request, and the module's own dialog took it from
there. Parameterising a property ("this text's size is 14 pt when the product is on sale, 10
otherwise") meant writing the binding language by hand, with no way to see what it gives before
it applies.

## Decision

**With a data service, the popover binds.** When a bundle serves `data@1`, "Bind to data…"
resolves the durable target as before and opens the popover. Without one, the request goes to a
`bindProperty` command, or the notice says nothing can bind yet, as before. It offers four ways
to bind, and each compiles to one expression (`bind-expr.ts`):

- **Field.** A searchable list of the query's fields with their types. A field whose name is not
  a bare identifier is shown and disabled, with the reason: the language has no quoted field
  syntax, so it needs an alias in its query.
- **Rules.** `when <field> <op> <value> then <result>` rows and an otherwise; the first match
  wins. They compile to nested `IF`s. *contains* is `IFERROR(FIND(…), 0) > 0`, because `FIND` is
  `#VALUE` when the text is absent; *is empty* is `ISBLANK`.
- **Map.** A field's values looked up, with a default: `SWITCH(field, key, value, …, default)`.
- **Expression.** Anything the language reads.

A value is read as the author typed it: a number stays a number, `=…` is an expression, anything
else a string (doubled quotes inside). The engine evaluates and coerces the result to the
property's schema row when the binding applies (ADR 558).

**A live preview.** The record stepper asks the service what the expression gives at each record
(`data.evaluate(query, expr, record)`, new in the door). paged.data answers from the engine
(`evaluate_at`: the record in the query's delivered order, nothing defined or recorded), with the
parse or evaluation error when there is one. The popover shows the compiled expression, the
value, or why it is not one. An answer is shown only for the query, expression and record it was
asked for.

**Bind** hands the service the target, the path, the query and the expression (`data.bind`); a
refusal is shown in the popover.

## Consequences

- An extension's object properties get the same popover: they are property fields too.
- The compiled shapes are held twice: the shell's unit test pins the text, and the data door's
  real-stack spec has the engine evaluate the same shapes on records.
- Units, colours and enums are typed values here (`=MM(4)`, `=SWATCH("Red")`); a picker per
  schema type is a later refinement.
