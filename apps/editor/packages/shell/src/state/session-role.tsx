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

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import type { Role, SessionPolicy } from "@paged-media/client";

import { useCanvasClient } from "./canvas-client-context";

const SessionRoleContext = createContext<Role>("editor");
const SetRoleContext = createContext<((role: Role) => void) | null>(null);

/** The role this editor runs in. */
export function useSessionRole(): Role {
  return useContext(SessionRoleContext);
}

/** Changes the session's role (an author previewing as a filler, an editor
 *  taking up authoring); null where nothing may change it. */
export function useSetSessionRole(): ((role: Role) => void) | null {
  return useContext(SetRoleContext);
}

/** Publishes the role and hands the policy to the engine whenever it
 *  changes (the worker keeps it across document loads). A role change goes
 *  to the host's `onRoleChange` when it keeps the role (the embedding
 *  instance does), else the provider keeps it. */
export function SessionPolicyProvider({
  policy,
  onRoleChange,
  children,
}: {
  policy: SessionPolicy;
  onRoleChange?: (role: Role) => void;
  children: ReactNode;
}) {
  const client = useCanvasClient();
  const [local, setLocal] = useState<Role | null>(null);
  const role = onRoleChange ? policy.role : (local ?? policy.role);
  const key = JSON.stringify({ ...policy, role });
  useEffect(() => {
    void client.setSessionPolicy(JSON.parse(key) as SessionPolicy);
  }, [client, key]);
  return (
    <SessionRoleContext.Provider value={role}>
      <SetRoleContext.Provider value={onRoleChange ?? setLocal}>
        {children}
      </SetRoleContext.Provider>
    </SessionRoleContext.Provider>
  );
}
