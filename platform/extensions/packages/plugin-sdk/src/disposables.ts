/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

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
