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

// The session's role (docs/composable-editor.md §7.6; engine ADR 1001): the
// profile or the embedding host says who this editor is for, the shell hands
// it to the engine, which then lets a filler change only what a template
// permits, and the UI reads it to decide what it offers (the form, field
// outlines, the template panel). Without a provider the role is `editor`,
// the engine's default.

import { createContext, useContext, useEffect, type ReactNode } from "react";

import type { Role, SessionPolicy } from "@paged-media/client";

import { useCanvasClient } from "./canvas-client-context";

const SessionRoleContext = createContext<Role>("editor");

/** The role this editor runs in. */
export function useSessionRole(): Role {
  return useContext(SessionRoleContext);
}

/** Publishes the role and hands the policy to the engine whenever it
 *  changes (the worker keeps it across document loads). */
export function SessionPolicyProvider({
  policy,
  children,
}: {
  policy: SessionPolicy;
  children: ReactNode;
}) {
  const client = useCanvasClient();
  const key = JSON.stringify(policy);
  useEffect(() => {
    void client.setSessionPolicy(JSON.parse(key) as SessionPolicy);
  }, [client, key]);
  return (
    <SessionRoleContext.Provider value={policy.role}>
      {children}
    </SessionRoleContext.Provider>
  );
}
