import {
  holdHostedChat,
  keepSitting,
  resumeSitting,
  useRoomStore,
  watchExpiryOnReturn,
} from "./roomStore";
import { initStorySync } from "./story-sync";
import { initTypingRelay } from "./typing";
import { roomTablePort } from "./table-port";
import { clearGuestChat, isGuestChatId } from "./guest-session";
import { app } from "@dahlia/plugin-api";

const { provide: provideTablePort } = app.table;

/**
 * **Everything multiplayer does to a tab, in one call, and its undo.**
 *
 * This used to happen at import: the story sync wired itself, the room store handed the walk its
 * table, held the hosted chat open and sat a reloaded guest back down — in every tab, because the
 * pipeline's own-device relay imported the story sync. So the plugin's switch hid a door and the
 * engine ran anyway. No module of the plugin has an import-time effect now: the plugin's `onload`
 * calls this and its `onunload` calls what it returns (`.agents/MULTIPLAYER-PLUGIN.md` §3, hook 4).
 *
 * Unwiring while a session is live ends it first (D4: the switch ends the session), so no guest is
 * left at a table whose host stopped listening. A guest's view of somebody else's story is put
 * away before the port goes: with the port gone nothing would say it is foreign, and the next write
 * would file the host's story in this library (MULTIPLAYER.md §3).
 */
export function wireMultiplayer(): () => void {
  const offs: (() => void)[] = [
    provideTablePort(roomTablePort),
    initStorySync(),
    initTypingRelay(),
    watchExpiryOnReturn(),
    keepSitting(),
    holdHostedChat(),
  ];
  void resumeSitting();
  return () => {
    const room = useRoomStore.getState();
    if (room.phase !== "idle") room.leaveRoom();
    const chats = app.story.chats.get();
    if (chats.activeChatId && isGuestChatId(chats.activeChatId)) chats.setActiveChatId(null);
    clearGuestChat();
    for (const off of offs.reverse()) off();
  };
}
