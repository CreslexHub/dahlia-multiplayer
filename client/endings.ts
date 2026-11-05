import type { RoomEndedReason } from "./roomStore";

/**
 * **Why a room ended, in words — and whether the reader has to be found to be told.**
 *
 * Keyed by the store's reason type, so a new way for a room to end is a compile error here
 * rather than a blank line on somebody's screen.
 *
 * `atTheDoor` is the second half and it is what makes this a table rather than a list of
 * strings. Two of these can only happen while somebody is standing in the lobby *trying to
 * get in*, and the dialog they are looking at says so; the rest arrive with no warning, at
 * any moment, most likely while the dialog is shut and the reader is in the middle of a
 * scene. Those have to be carried to wherever they are — which is what `ChatLayout` does
 * with it, and why the difference is stated once here instead of as a list of reasons
 * written out in the component.
 */
export type RoomEnding = { copy: string; atTheDoor: boolean };

/**
 * One sentence, two ways to meet it: thrown out mid-scene, and turned away at the door when
 * you come back. Written once, because two rows saying the same thing in two spellings is how
 * one of them ends up saying something else.
 */
const REMOVED = "The host removed you from the room.";

export const ROOM_ENDED_COPY: Record<RoomEndedReason, RoomEnding> = {
  not_found: {
    copy: "That code doesn't name a room. Check it with the host — codes expire when a room sits empty.",
    atTheDoor: true,
  },
  full: { copy: "That room is full.", atTheDoor: true },
  busy: { copy: "Too many tries from this network. Wait a few minutes, then try again.", atTheDoor: true },
  banned: { copy: REMOVED, atTheDoor: true },
  host_left: { copy: "The host left, so the room closed.", atTheDoor: false },
  expired: { copy: "The room expired.", atTheDoor: false },
  replaced: {
    copy: "This account joined the room from somewhere else, so this tab was disconnected.",
    atTheDoor: false,
  },
  kicked: { copy: REMOVED, atTheDoor: false },
};
