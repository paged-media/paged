// The subscriptions idiom: collect every Disposable a bundle's
// activation produces; tear all of them down in reverse order on
// deactivate. Dispose is idempotent; late `add`s after dispose are
// disposed immediately (no leaks across a teardown race).

import type { Disposable } from "@paged-media/plugin-api";

export class DisposableStore implements Disposable {
  private items: Disposable[] = [];
  private disposed = false;

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Track `d`; returns it for chaining. */
  add<T extends Disposable>(d: T): T {
    if (this.disposed) {
      d.dispose();
      return d;
    }
    this.items.push(d);
    return d;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Reverse order — later registrations may depend on earlier ones.
    for (let i = this.items.length - 1; i >= 0; i--) {
      try {
        this.items[i].dispose();
      } catch {
        // One failing teardown must not strand the rest.
      }
    }
    this.items = [];
  }
}

/** Wrap a plain cleanup function as a Disposable. */
export function toDisposable(fn: () => void): Disposable {
  let done = false;
  return {
    dispose() {
      if (done) return;
      done = true;
      fn();
    },
  };
}
