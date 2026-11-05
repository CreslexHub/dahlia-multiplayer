"use client";

import { useRoomStore } from "../client/roomStore";
import { app } from "@dahlia/plugin-api";
import type { Chat } from "@dahlia/plugin-api";

const { chatHasTable } = app.cast;

/**
 * **Whether this chat has a table, whether it is hosting, and whether its rules are yours to set** —
 * read once for the two screens that draw the table's settings: Chat style's table region (the room
 * and the seats) and Autonomy's Guests (what a guest may do).
 */
export function useTableState(chat: Chat | null) {
  const phase = useRoomStore((s) => s.phase);
  const boundChatId = useRoomStore((s) => s.boundChatId);
  const isHost = useRoomStore((s) => s.isHost);
  const rosterSize = useRoomStore((s) => s.roster.length);
  const code = useRoomStore((s) => s.code);

  const live = phase === "lobby" && chat !== null && boundChatId === chat.id;
  return {
    live,
    /**
     * Locked control by control rather than by a `<fieldset>` around the region: a guest may read
     * all of this — host-authoritative is a UI fact too — and the rows already carry the idiom. Both
     * stores refuse besides. With no room live they are locked too: `connectTo` does
     * `set({ ...AT_REST })`, so an edit made before hosting is destroyed by the act of hosting.
     */
    locked: !isHost || !live,
    /**
     * Drawn for a chat that has hosted, and for one hosting right now. `multiplayer` is the one
     * durable multiplayer fact on a `Chat`; a solo chat that has never had a table draws none of it.
     */
    drawn: chatHasTable(chat, live),
    /** The table's state in a line, where a heading has room for one. */
    status: live ? `Code ${code} — ${rosterSize} at the table` : "Not hosting. These rules apply when you host.",
  };
}
