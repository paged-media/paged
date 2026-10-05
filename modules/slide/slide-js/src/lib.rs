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

//! The wasm-bindgen surface of paged.slide. One module serves import and
//! export; the TypeScript bundle never interprets PresentationML itself.

use wasm_bindgen::prelude::*;

/// Read a `.pptx` and return the format-level IR as JSON (M0: inspection and
/// the size spike; M1 returns the generated IDML package instead).
#[wasm_bindgen(js_name = readPptx)]
pub fn read_pptx(bytes: &[u8]) -> Result<String, JsError> {
    let deck = pptx_import::import_pptx(bytes).map_err(|e| JsError::new(&e.to_string()))?;
    serde_json::to_string(&deck).map_err(|e| JsError::new(&e.to_string()))
}
