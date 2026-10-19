# @paged-media/react-live

Internal, never published: a mutable source as a React render value
(apps/editor ADR 228).

The editor's registries, a bundle's published bindings, a module's panel
store and the BundleHost surfaces keep their identity while their contents
change. The React Compiler memoizes what a component computes from them on
that identity, so a read like `store.list()` during render would be computed
once and kept. A counter bumped from an `onChange` effect does not help: the
compiler depends on what a computation reads, and nothing reads the counter.

```tsx
import { useLive, subscribeOf } from "@paged-media/react-live";

function SlidesPanel() {
  const slides = useLive(store, subscribeOf); // a new view after every change
  return slides.list().map((s) => <Slide key={s.pageId} slide={s} />);
}
```

`useLive(source, listen)` returns a view of `source` that reads through to it
and is replaced after every change `listen` reports. Read during render
through the view; hand the source itself to effects and event handlers.
`listen` adapters: `onChangeOf` (`onChange(handler): Disposable`, the
editor's registries), `onDidChangeOf` (`onDidChange(listener): Disposable`,
the contract's surfaces), `subscribeOf` (`subscribe(listener): () => void`).
