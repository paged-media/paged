# ADR 335 — Modules contribute template field kinds

- **Status:** Accepted 2026-10-23.
- **Scope:** `packages/plugin-api/src/object-model.ts` (`TemplateFieldKindContribution`,
  `TemplateFieldControl`, `TemplateFieldRef`, `TemplateFieldWrite`, `TemplateFieldKindInfo`,
  `ObjectsSurface.templateFieldKinds` / `readTemplateField` / `writeTemplateField`),
  `packages/plugin-api/src/manifest.ts` (`contributes.objectModel.templateFields`),
  `packages/plugin-sdk/src/{object-registry,host-impl}.ts`, `bin/paged-plugin.mjs`. The engine
  side is engine ADR 1000's amendment of 2026-10-23.

## Context

A template is a document whose open parts a filler may change; the engine's policy says which
(engine ADRs 1000, 1001). Text frames, pictures, visibility and text variables are the engine's
own, and it reads and writes them. A module's content is not: a sheet's cell lives in the
sheet's parts, a doc's paragraph in the doc's model. A template made of module frames needs
the module to say which of its parts can be fields, what a form shows for each, and how a
value is read and written, on every surface that fills templates: the editor's form, a host
through `createEditor`, and `paged-node template` on a server.

## Decision

A module contributes **template field kinds** with its object model:
`host.contribute.objectModel({ kinds, commands, templateFields })`. A kind is named
`<manifest.id>.<name>`, declared in `contributes.objectModel.templateFields[]` (the capability
gate, as for kinds and commands), and gives:

- `control`: what a form shows, and so the value's shape (text, number, choice, toggle,
  picture, table); `describe` may answer a control per field (a choice whose options the
  content lists);
- `read(ctx, field)` and `write(ctx, field, value)`, where `field` is the template's
  reference: its name, the item it is on, the kind, and the module's definition;
- `grants`: the permissions filling a field takes, which an author's tool writes into the
  field's policy.

`host.objects` lists the kinds (`templateFieldKinds`) and routes a field's read and write to
its module (`readTemplateField`, `writeTemplateField`); an unknown kind rejects with
`unknownFieldKind`. A bundle's own view gates the read on `document.read` and the write on
`document.write`.

The module writes through its usual door, so the engine checks every write against the
session's role: a module field is never a way around the policy.

## Consequences

- The editor's template form shows a module field with the control its module declares, and
  `paged-node template fields | fill | check` route module values to their modules after the
  session takes the filler role; `template kinds` lists what the loaded modules offer.
- A value crosses JSON surfaces as JSON; a picture is `{ name, bytes }` in process and
  `{ "$file": path }` on the command line.
- Each built-in module ships its kinds with tests (editor plan G3).

## Related

- [ADR 329](329-plugins-contribute-a-typed-object-model.md) — the object model these kinds join
