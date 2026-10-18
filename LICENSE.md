# License

**Paged** (<https://paged.media>) is **dual-licensed**. You may use, modify, and
distribute it under the terms of **either**:

- the **GNU Affero General Public License, version 3** (AGPL-3.0) — the
  open-source option; the full text is in [`LICENSE`](./LICENSE); or
- the **Paged Media Enterprise License** (PMEL) — a commercial option
  available from **And The Next GmbH**.

`SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL`

Source files carry the license notice in their header; new files must include
it (copy it from any existing source file).

## Transition note

This repository was assembled from several repositories (see
[`tooling/import/`](./tooling/import/)). Three of them were published under
`MPL-2.0 OR LicenseRef-PMEL`: `engine/core`, `modules/publish` and
`platform/extensions`, and some files elsewhere carried the MPL notice. The
relicense recorded in ADR PM-0001
([`docs/adr/PM-0001-scope-home-and-licence.md`](./docs/adr/PM-0001-scope-home-and-licence.md))
has landed: every first-party file in this repository is now under
`AGPL-3.0-only OR LicenseRef-PMEL`. Versions published before the relicense
(npm packages and tagged releases) remain available under
`MPL-2.0 OR LicenseRef-PMEL`.

## GNU Affero General Public License v3 (open source)

The standard, **unmodified** AGPL-3.0 governs — see [`LICENSE`](./LICENSE), or
obtain a copy at <https://www.gnu.org/licenses/agpl-3.0.html>. The AGPL's
copyleft is strong and whole-work: a work that combines or links these files is
itself subject to the AGPL, and §13 extends that to use over a network.

## Paged Media Enterprise License (commercial)

A commercial license is available from **And The Next GmbH** for users who need
terms AGPL-3.0 does not provide — for example the right to build closed-source or
hosted derivatives **without** the AGPL's reciprocity and network-source
obligations, plus warranty, indemnification, liability cover, support SLAs, and
patent assurances. Contact And The Next GmbH for terms.

## Bundled third-party material

Some directories redistribute third-party material under its own license — for
example fonts under the SIL Open Font License, spreadsheet fixtures derived from
Apache POI (Apache-2.0), and vendored data or binaries with their own notices.
Those terms govern those files; see the `LICENSE*`, `OFL-*` and `NOTICE` files
next to them.

## Contributions

Contributions are accepted under the project's Contributor License Agreement,
which lets And The Next GmbH distribute them under **both** the AGPL-3.0 and the
Paged Media Enterprise License.

## Trademarks

`paged`, `paged.media`, and the paged logo are trademarks of And The Next GmbH.
The open-source license grants copyright permissions, not trademark permissions.

© And The Next GmbH. All rights reserved except as expressly granted above.
