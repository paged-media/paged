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

// @paged-media/ai — Claude for paged. The proxy's server half is a separate
// entry (`@paged-media/ai/proxy`) so the browser bundle never carries it.

export { DEFAULT_MODEL, MODE_SPECS, AI_MODES, isAiMode, type AiMode, type Effort, type ModeSpec } from "./model";
export { renderCatalog, lookupApi, type ApiCatalog } from "./catalog";
export { AUTHORING_GUIDE } from "./guide";
export { readStoryHealth, type ScriptEngine, type ScriptRun, type StoryHealth } from "./engine";
export { SCRIPT_TOOLS, RUN_SCRIPT, LOOKUP_API, RENDER_PAGE, parseToolInput, type ToolInput } from "./tools";
export { buildRequest, systemPrompt, type BuildRequestOptions } from "./request";
export {
  createDirectTransport,
  createProxyTransport,
  MODE_HEADER,
  type AiTransport,
  type TurnRequest,
  type TurnHooks,
  type DirectTransportOptions,
  type ProxyTransportOptions,
} from "./transport";
export { runAgent, complete, type AgentEvent, type AgentOptions, type AgentResult, type AgentRefusal } from "./agent";
export { aiObjectModel, AI_COMPLETE_COMMAND, AI_COMPLETE_MAX_PROMPT, AI_COMPLETE_PER_MINUTE, type AiCompleteBackend } from "./object-model";
