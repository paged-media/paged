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

// `@paged-media/test-kit/headless`: the headless editor's engine half
// (apps/editor/apps/canvas/tests/headless builds the editor on it): the
// canvas-wasm booted once per process, an in-process render worker the real
// CanvasClient drives, and the canonical model dump the headless and parity
// suites compare.
//
// Its own entry point because it loads the plugin SDK's main entry (the
// Node engine loader), and the root entry must not: Playwright specs import
// the root entry under Node ESM, which refuses the SDK's JSON import.
export {
  headlessEngineModule,
  type EngineCanvasWorker,
  type HeadlessEngineModule,
} from "./engine.ts";
export {
  createEngineWorker,
  type EngineWorker,
  type EngineWorkerOptions,
  type GestureRecord,
  type PostedMessage,
} from "./engine-worker.ts";
export {
  canonicalJson,
  dumpDiff,
  elementKey,
  modelDump,
  MODEL_DUMP_COLLECTIONS,
  type ModelDump,
  type ModelDumpOptions,
} from "./model-dump.ts";
