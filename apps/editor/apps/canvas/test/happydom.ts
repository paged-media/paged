/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// The panel DOM lane's preload (`bun run test:dom`): happy-dom's
// window, document and friends on globalThis before any
// `*.dom.test.tsx` loads. Only that task preloads it; a global DOM in
// another run would make code that asks `typeof window` believe it is in
// a browser.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

// Bun's own confirm(), prompt() and alert() read the terminal, so a test
// that reached one would wait for a keypress forever. Here they answer
// "no" at once; a test that means to answer them stubs them itself.
globalThis.confirm = () => false;
globalThis.prompt = () => null;
globalThis.alert = () => {};
