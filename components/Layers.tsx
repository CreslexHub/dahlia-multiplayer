"use client";

import { ui, app } from "@dahlia/plugin-api";
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { PlayTogetherModal } from "./PlayTogetherModal";
import { useRoomStore } from "../client/roomStore";
import { ROOM_ENDED_COPY } from "../client/endings";
import { isGuestChatId } from "../client/guest-session";
import type { Chat } from "@dahlia/plugin-api";

/**
 * **What the Multiplayer plugin draws over a screen** — the lobby its doors open, and the table
 * going away. Registered into the app's slots on load (`plugins/multiplayer/client/plugin.ts`); with the plugin
 * off none of this is on any screen.
 */

/** Whether the lobby is open — one bit, pressed by the plugin's doors and read by its layers. */
export const useLobbyDoor = create<{ open: boolean }>(() => ({ open: false }));

export function openLobby(): void {
  useLobbyDoor.setState({ open: true });
}

const closeLobby = () => useLobbyDoor.setState({ open: false });

/** Over a chat screen: the lobby for this story, and the table's ending wherever the reader is. */
export function ChatLayer({ chat }: { chat: Chat | null }) {
  const open = useLobbyDoor((s) => s.open);
  const router = app.nav.useNavigate();

  /**
   * **The table going away finds you wherever you are.**
   *
   * A kick, a host closing their tab, an expiry: none of them announce themselves, and all
   * of them arrive while the reader is most likely mid-scene with the lobby dialog shut. The
   * ending was only ever rendered *inside* that dialog, so a removed guest went on reading a
   * story that had quietly stopped being fed, with nothing on screen to say so — and could
   * go on typing into it.
   *
   * The two endings that can only happen at the door are left to the dialog, because the
   * reader is already looking at it: `atTheDoor` in `ROOM_ENDED_COPY` is that difference, so
   * it is one table rather than a list of reason names written out here.
   *
   * A guest is also *moved*, because their chat was a view of somebody else's story and the
   * room was the only thing feeding it. The host's chat is their own and they stay in it.
   */
  const endedReason = useRoomStore((s) => (s.phase === "ended" ? s.endedReason : null));
  const toldOf = useRef<string | null>(null);
  const chatId = chat?.id ?? null;
  useEffect(() => {
    if (!endedReason) {
      toldOf.current = null;
      return;
    }
    const ending = ROOM_ENDED_COPY[endedReason];
    if (ending.atTheDoor || toldOf.current === endedReason) return;
    toldOf.current = endedReason;
    ui.showNotice(ending.copy);
    // Out of the view, which is what makes `story-sync`'s watcher safe to drop it.
    if (isGuestChatId(chatId)) router.replace("/");
  }, [endedReason, chatId, router]);

  return <PlayTogetherModal open={open} onClose={closeLobby} chat={chat} />;
}

/** Over the home screen: the lobby, with no story chosen yet. */
export function HomeLayer() {
  const open = useLobbyDoor((s) => s.open);
  return <PlayTogetherModal open={open} onClose={closeLobby} />;
}
