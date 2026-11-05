"use client";

import { useCallback, useEffect, useState } from "react";
import { MULTIPLAYER_PLUGIN_ID } from "../mount";
import type { TunnelStatus } from "../server/tunnel";
import { app } from "@dahlia/plugin-api";
import { publicUrlPath, tunnelPath } from "../client/join-link";

const { apiFetch } = app.net;

/**
 * The public address, and — where the server can offer one — the switch that opens it.
 *
 * Every field is the server's answer rather than one worked out here: `permanent` in particular,
 * because the lobby draws a "Stop Tunnel" button from it and `publicUrlIsPermanent` on the
 * server is the one thing that knows whether the address is a configured domain. Read from
 * `window.location`, this was §13.2 three times over — see `plugins/multiplayer/server/public-url.ts`.
 */
export interface TunnelState {
  url: string;
  /** The address is a configured domain, so there is no tunnel to stop. */
  permanent: boolean;
  starting: boolean;
  error: string | null;
  /**
   * Whether *this device* may open or close it — only the computer may: it is the plugin's action,
   * through `/api/plugins`. Where it may not, the lobby says that door's sentence
   * (`MACHINE_ONLY.plugins.refusal`) instead of offering a button that would be refused.
   */
  canChange: boolean;
  startTunnel: () => Promise<void>;
  stopTunnel: () => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * The address guests can reach this machine at, asked of the server that knows.
 *
 * Not worked out from `window.location` — see `server/public-url.ts` for what that cost.
 * The server half is told by the tunnel while it is open, or by the "Permanent public address" setting once there is
 * a domain, and this hook is how the lobby reads it back.
 */
/** What the route answers: the status, and whether this device may open or close the tunnel. */
type TunnelAnswer = Partial<TunnelStatus> & { canChange?: boolean };

export function usePublicUrl(active: boolean): string {
  const tunnel = useTunnel(active);
  return tunnel.url;
}

export function useTunnel(active: boolean): TunnelState {
  const [url, setUrl] = useState("");
  const [permanent, setPermanent] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Offered until the server says otherwise, as it was: a refused press says the same sentence.
  const [canChange, setCanChange] = useState(true);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await apiFetch(tunnelPath());
      if (!res.ok) {
        const pubRes = await apiFetch(publicUrlPath());
        if (pubRes.ok) {
          const pubData = (await pubRes.json()) as { url?: string; permanent?: boolean };
          setUrl(typeof pubData.url === "string" ? pubData.url : "");
          setPermanent(Boolean(pubData.permanent));
        }
        return;
      }
      const data = (await res.json()) as TunnelAnswer;
      setUrl(typeof data.url === "string" ? data.url : "");
      setPermanent(Boolean(data.permanent));
      setStarting(Boolean(data.starting));
      setError(data.error ?? null);
      setCanChange(data.canChange === true);
    } catch {
      /* offline */
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void fetchStatus();
  }, [active, fetchStatus]);

  /**
   * **Open and Close are the plugin's own actions** (`/api/plugins`, computer-only like every plugin
   * command) — the one door. `POST /api/tunnel` was a second way to open the same tunnel, which the
   * card's Open and the lobby's took by turns. The status is read back from the tunnel afterwards.
   */
  const act = useCallback(
    async (action: "open" | "close") => {
      const answer = await app.plugins.act(MULTIPLAYER_PLUGIN_ID, action);
      setError(answer.ok ? null : answer.error ?? `Failed to ${action} the tunnel`);
      await fetchStatus();
    },
    [fetchStatus]
  );

  const startTunnel = useCallback(async () => {
    setStarting(true);
    setError(null);
    await act("open");
    setStarting(false);
  }, [act]);

  const stopTunnel = useCallback(async () => {
    setStarting(false);
    await act("close");
  }, [act]);

  return {
    url,
    permanent,
    starting,
    error,
    canChange,
    startTunnel,
    stopTunnel,
    refresh: fetchStatus,
  };
}
