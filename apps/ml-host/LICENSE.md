# License

**paged-ml-host** (<https://paged.media>), the local generative-image host, is
**dual-licensed**. You may use, modify, and distribute it under the terms of **either**:

- the **GNU Affero General Public License, version 3** (AGPL-3.0) — the open-source
  option; the full text is in [`LICENSE`](./LICENSE); or
- the **Paged Media Enterprise License** (PMEL) — a commercial option available from
  **And The Next GmbH**.

`SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL`

Source files carry the license notice in their header; new files must include it (copy it
from any existing source file).

## Why AGPL

The host serves an HTTP API, so it uses the **AGPL**, the same terms as the rest of paged
(ADR PM-0001), whose §13 network clause requires anyone running a *modified* version as a
service to offer that service's complete source to its users. It is available under the
commercial **PMEL** for users who need terms the open-source license doesn't provide.

The image runtime it starts (stable-diffusion.cpp) and the model weights it is pointed at
are not part of this work and are not distributed with it; see [`NOTICE`](./NOTICE).

## GNU Affero General Public License v3 (open source)

The standard, **unmodified** AGPL-3.0 governs — see [`LICENSE`](./LICENSE), or obtain a
copy at <https://www.gnu.org/licenses/agpl-3.0.html>.

## Paged Media Enterprise License (commercial)

A commercial license is available from **And The Next GmbH** for users who need terms
AGPL-3.0 does not provide — for example the right to build closed-source or hosted
derivatives **without** the AGPL's reciprocity and network-source obligations, plus
warranty, indemnification, liability cover, support SLAs, and patent assurances. Contact
And The Next GmbH for terms.

## Contributions

Contributions are accepted under the project's Contributor License Agreement, which lets
And The Next GmbH distribute them under **both** the AGPL-3.0 and the Paged Media
Enterprise License.

## Trademarks

`paged`, `paged.media`, and the paged logo are trademarks of And The Next GmbH. The
open-source license grants copyright permissions, not trademark permissions.

© And The Next GmbH. All rights reserved except as expressly granted above.
