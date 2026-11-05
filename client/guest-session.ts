import type { Chat } from "@dahlia/plugin-api";

/**
 * The shared chat, as this tab sees it while it is a *guest* in someone else's room.
 *
 * MULTIPLAYER.md §3 is the reason this module exists: a `Chat` syncs as one record with
 * one `updatedAt`, and the merge keeps whichever copy is newer — so a guest's browser
 * holding the shared chat as a real record would silently eat the host's turns on its
 * next boot. A guest therefore holds a **view**: this module is where it lives, and the
 * storage funnels (`chatStore`'s debounced upsert, `chatMutator`'s direct write) ask it
 * before persisting. A chat parked here never reaches `localStorage`, so the sync engine
 * never learns it exists — there is nothing to gate downstream because nothing gets that
 * far.
 *
 * Plain module state, not a store: exactly one guest session can exist per tab (you are
 * in one room or none), nothing renders from this directly, and the react tree already
 * re-renders off `chatStore`, which holds the same object while the chat is open.
 */

let guestChat: Chat | null = null;

/** Is this chat id the one this tab is a guest in? The persistence funnels ask this. */
export function isGuestChatId(chatId: string | null | undefined): boolean {
  return !!chatId && guestChat?.id === chatId;
}

/** The guest view of a chat, if this id names one — `setActiveChatId`'s first look. */
export function guestChatFor(chatId: string): Chat | undefined {
  return guestChat?.id === chatId ? guestChat : undefined;
}

/** Adopt (or wholly replace, on re-snapshot) the shared chat this tab is a guest in. */
export function setGuestChat(chat: Chat): void {
  guestChat = chat;
}

/**
 * Keep the latest in-memory copy after a mutation the storage funnel refused to
 * persist — so a remount (leaving to the library and back) reopens what was on screen,
 * not the snapshot from join time.
 */
export function keepGuestCopy(chat: Chat): void {
  if (guestChat?.id === chat.id) guestChat = chat;
}

/** The session is over — the view has no meaning without the room feeding it. */
export function clearGuestChat(): void {
  guestChat = null;
}
