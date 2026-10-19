# @paged-media/react-live

Internal, never published: a mutable source as a React render value
(apps/editor ADR 229).

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

## `useNearViewport`

Which items of a long list have come near the viewport, for lists whose
items cost something to show (a thumbnail to decode, a page to render):
one IntersectionObserver on a React 19.3 Fragment ref
(`FragmentInstance.observeUsing`), so no item needs a ref of its own
(apps/editor ADR 240).

```tsx
import { useNearViewport } from "@paged-media/react-live";

function Thumbnails({ pages }: { pages: Page[] }) {
  // Destructured: the React Compiler takes an object whose member is handed
  // to a `ref` prop for a ref, and a ref is not read during render.
  const { observe, has } = useNearViewport({ eager: 12 });
  return (
    <Fragment ref={observe}>
      {pages.map((p, i) => (
        <figure key={p.id} data-near={p.id}>
          {has(p.id, i) ? <img src={p.url} alt="" /> : <Placeholder />}
        </figure>
      ))}
    </Fragment>
  );
}
```

An item counts as near once it intersected the viewport (with a look-ahead
margin) and stays near. The first `eager` items are near from the start, so
the first paint never waits for the observer and a DOM without one (a test
DOM) shows the head of the list.
