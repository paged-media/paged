# @paged-media/panel-kit

Internal, never published: the small controls every panel of the editor and
the built-in modules shares, one implementation each (docs/adr/PM-0002).

| Export                                       | What it is                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `color`, `status`, `font`                    | The panel tokens, each with one fallback: the light theme's value in the shell's `theme.css`.   |
| `ConfirmButton`, `useConfirm`                | The second click that runs an action which cannot be undone; the arm lapses after `CONFIRM_MS`. |
| `Disclosure`, `About`                        | A native `<details>` section, and the collapsed "About" note.                                   |
| `useDisclosure`                              | `aria-expanded` / `aria-controls` for a header a panel draws itself.                            |
| `createDebouncer`, `useDebouncedValue`       | Trailing-edge debouncing, with injectable timers.                                               |
| `StatusLine`, `Refusal`, `useActionFeedback` | The outcome of an action, shown in the panel.                                                   |
| `refusalText`, `humanize`                    | A refusal (log line, Error, engine error, its JSON) as one sentence; a token as words.          |
| `IconButton`, `Segment`                      | A glyph button named in words; a toggle segment with `aria-pressed`.                            |

```tsx
import { ConfirmButton, Refusal, useActionFeedback } from "@paged-media/panel-kit";

const { refusal, run } = useActionFeedback(host, reload, "draw panel");
<Refusal text={refusal} />
<ConfirmButton label="Delete" onConfirm={() => void run(() => remove(id))} />
```

A row names its controls:

```tsx
const id = useId();
<span id={id}>Size</span>
<LabelledBy id={id}>
  <NumberInput … /> {/* aria-labelledby={id}, through useFieldName */}
</LabelledBy>
```

The decision record is apps/editor ADR 233; the inventory and the numbers are in
docs/migration/shared-foundations.md (C10).
