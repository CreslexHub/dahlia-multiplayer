import {
  micGateFor,
  sessionBlocksAI,
  tableFloorFor,
  useRoomStore,
  type RoomStore,
} from "./roomStore";
import { guestChatFor, isGuestChatId, keepGuestCopy } from "./guest-session";
import { onTableReading, readsAtTable, tableReadingOf } from "./table-reading";
import { guestMayActOnMessage, type GuestPermissionId } from "./permissions";
import { pressTableNextTurn, tableGateProgress, tableNextTurn } from "./continue-gate";
import {
  forwardLibraryEdit,
  sendAnswerEdit,
  sendDirectorNote,
  sendMessageAction,
  sendPlayerStoryMessage,
  sendProposalAction,
  sendStopGeneration,
} from "./story-sync";
import { app } from "@dahlia/plugin-api";
import type { Chat, TablePort, TableRight, TableView } from "@dahlia/plugin-api";

const { readChat } = app.story;

/**
 * **The table, as core asks it** — this plugin's half of `lib/table/port.ts`.
 *
 * Every answer reads the room store, the guest view or the table's reading at the moment of
 * asking, so the port holds no copy of its own. Handed to core on load and taken back on unload
 * (`./client.ts`); with it taken back, core answers solo.
 */

// Every right core asks by name is one of the host's permission rows: a name added to core's list
// and missing here is a type error, not a control that is always granted.
const _rightsAreRows: TableRight extends GuestPermissionId ? true : never = true;
void _rightsAreRows;

/**
 * The view as core reads it — the same object while the store has not moved, so a component
 * selecting it does not re-render on every read.
 */
let seated: { state: RoomStore; table: TableView | null } | null = null;
function seatedTable(): TableView | null {
  const s = useRoomStore.getState();
  if (seated?.state !== s) {
    seated = {
      state: s,
      table:
        s.phase === "lobby" && s.boundChatId
          ? {
              chatId: s.boundChatId,
              players: s.roster,
              claims: s.claims,
              selfId: s.selfId,
              isHost: s.isHost,
              window: s.window,
              clock: s.clock,
              typing: s.typing,
            }
          : null,
    };
  }
  return seated!.table;
}

/** A guest's seat at the table playing `chatId`: a press there goes to the host. */
function seatedAsGuest(chatId: string | null | undefined): boolean {
  return !!chatId && isGuestChatId(chatId);
}

export const roomTablePort: TablePort = {
  subscribe: (listener) => useRoomStore.subscribe(listener),

  view: (chatId) => {
    const table = seatedTable();
    return table && table.chatId === chatId ? table : null;
  },
  boundChatId: () => useRoomStore.getState().boundChatId,

  foreign: isGuestChatId,
  foreignChat: guestChatFor,
  keep: (chat: Chat) => keepGuestCopy(chat),

  may: (chatId, right) => !seatedAsGuest(chatId) || useRoomStore.getState().permissions[right],
  mayActOnMessage: (chatId, action, message) => {
    if (!seatedAsGuest(chatId)) return true;
    const { selfId, claims, permissions } = useRoomStore.getState();
    const chat = readChat(chatId);
    if (!chat || !selfId) return false;
    return guestMayActOnMessage(action, { chat, ownerId: selfId, claims, permissions, message });
  },

  blocksAI: sessionBlocksAI,

  forward: (chatId) =>
    seatedAsGuest(chatId)
      ? {
          line: sendPlayerStoryMessage,
          stop: sendStopGeneration,
          note: sendDirectorNote,
          messageAction: sendMessageAction,
          answerEdit: sendAnswerEdit,
          proposal: sendProposalAction,
          libraryEdit: (edit, base) => forwardLibraryEdit(chatId!, edit, base),
        }
      : null,

  floor: tableFloorFor,
  micGate: micGateFor,
  pressReady: (calling) => useRoomStore.getState().pressReady(calling),
  windowLine: (calling) => {
    const room = useRoomStore.getState();
    if (room.selfId) room.windowLine(room.selfId, calling);
  },
  closeWindow: () => useRoomStore.getState().closeWindow(),
  moveTurnTo: (seat) => useRoomStore.getState().moveTurnTo(seat),

  gateProgress: tableGateProgress,
  nextTurn: tableNextTurn,
  pressNextTurn: pressTableNextTurn,

  reading: tableReadingOf,
  readsAt: readsAtTable,
  onReading: onTableReading,

  announceName: () => useRoomStore.getState().announceName(),
};
