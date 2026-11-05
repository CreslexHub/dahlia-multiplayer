import { app } from "@dahlia/plugin-api";
import { useRoomStore } from "./roomStore";

/**
 * Fingers-on-keys in the **story** composer, announced to the table.
 *
 * Watches the composer's draft off the store rather than hooking the input component:
 * the draft has one home (`uiState.input`), so one subscription covers every way it
 * changes — typing, an option filling it, **and the clear on send**, which is what turns
 * a send into a stop. The throttle and the "is a session even up" check live in
 * `roomStore.reportTyping`; this module only notices the keystroke happened in the chat
 * the room is playing.
 *
 * It said "one subscription covers every way it changes" while `ChatInputArea`'s
 * `onChange` called `reportTyping` too, and only the throttle hid the second call. With
 * the stop unthrottled, two callers is two stops — so the component's copy is gone and
 * this is the one caller it always claimed to be.
 */

let wired = false;

export function initTypingRelay(): () => void {
  if (wired) return () => {};
  wired = true;
  const offs: (() => void)[] = [];
  offs.push(app.story.chats.subscribe((state, prev) => {
    if (state.uiState.input === prev.uiState.input) return;
    const room = useRoomStore.getState();
    if (room.phase !== "lobby" || !room.boundChatId) return;
    if (state.activeChatId !== room.boundChatId) return;
    room.reportTyping(state.uiState.input, "story");
  }));
  return () => {
    wired = false;
    for (const off of offs.splice(0)) off();
  };
}


