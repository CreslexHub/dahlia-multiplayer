import { onTableReading, tableReadingOf } from "./table-reading";
import {
  gateProgressOf,
  nextGateId,
  openNextGate,
  openReadGate,
  readGateId,
  showsStory,
  useRoomStore,
  type GateFacts,
  type RoomStore,
} from "./roomStore";
import { app } from "@dahlia/plugin-api";
import type { RevealState, ContinueGateProgress, TableNextTurn } from "@dahlia/plugin-api";

const { mirror: mirrorReveal, followed: readingFollowed, releaseHeld: releaseHeldReveal, setGatekeeper: setRevealGatekeeper, setPaused: setRevealPaused, setPauseKeeper: setRevealPauseKeeper, stopFollowing: stopFollowingReading, landTableReading } = app.reveal;
const { pipelineFor, readChat } = app.story;
const { nextTurnOffered } = app.turns;

/**
 * The table's gates: at a live table, **a Continue moves every screen or none**.
 *
 * The owner's rule, in their words: *"if someone presses continue, then it will continue for
 * everyone. or if someone presses next turn, then it goes to next turn for everyone. doesn't
 * matter who"* — so that no two screens are ever at different places in one story without
 * knowing it. Under `everyone` the table waits for every reader; under `anyone` the first press
 * is enough. Either way the press goes to the table and the release comes back from it, to every
 * screen at once, the pressing one included.
 *
 * **The reading is the table's and never the host's screen's** (ROUND-2026-11-03 §2). One
 * seat walks it, the `reader` the host names (`tableReaderOf`): the host whenever its screen shows the
 * story, otherwise a seat whose screen does. Every other seat draws what the reader published
 * (`tableReadingOf`), so no two screens are ever at two places in one story, host present or not. A
 * gate is named by where it stands in the story (`readGateId`), and there is only the reader's.
 *
 * Four halves, all wired here and nowhere else:
 *
 *  - **who reads** — every seat says whether its screen shows the story; the host names the reader.
 *  - **the host's view** — a watcher that tells `syncGates` what the table's reading is holding at
 *    and whether a Next turn would stand on it. The store opens, releases and starts.
 *  - **the veto** — installed into `continueReveal`'s one door, and the pause's. At a table a
 *    press is sent to the table and never released here; solo chats pass straight through.
 *  - **the reading** — on the reader, a hold the table went on from is let go of and the table's
 *    pause is held; on every other seat showing the story, the reader's reveal is drawn.
 *
 * The host wandering to another chat reads that one solo, and the table's reading goes on with a
 * guest, or holds at the bubble in hand while nobody's screen shows the story.
 */

/** Whether the table's gates are this tab's business at all — the room's chat, on screen. */
function atTable(): boolean {
  const { boundChatId, phase } = useRoomStore.getState();
  return phase === "lobby" && !!boundChatId && app.story.chats.get().activeChatId === boundChatId;
}

/**
 * The gate this screen's hold stands at, or null. A hold the reader's pause made has none: it is
 * not a place in the story every screen stops at, it is the table's pause, met at whatever line
 * each screen had in hand (`RevealState.gate.byPause`).
 */
function holdGateOf(reveal: RevealState): string | null {
  return reveal.gate && !reveal.gate.byPause ? readGateId(reveal.gate.turnId) : null;
}

/** This screen's hold, as the two facts the table asks of it — selected shallowly. */
function holdFactsOf(reveal: RevealState): { id: string | null; offered: boolean } | null {
  return reveal.gate ? { id: holdGateOf(reveal), offered: reveal.gate.offered } : null;
}

/**
 * **What a Continue from this screen answers**: the gate it is holding at — or, holding nothing,
 * the gate the table is waiting at. A reader who has caught up is still one of the people the
 * story waits on, and a button that only stood where *this* screen was holding left them unable
 * to answer — which is one half of how the table used to deadlock.
 */
function answeringOf(holdId: string | null, s: Pick<RoomStore, "gates">): string | null {
  return holdId ?? openReadGate(s)?.id ?? null;
}

/**
 * The Continue's count, for the surfaces that draw it — null where there is nothing of the
 * table's to draw: no table, or the table is not waiting here. A hold this screen is *offering*
 * counts even before the host has opened it, because this screen got there first and its press
 * is what opens it.
 */
function tableContinueOf(
  s: GateFacts & Pick<RoomStore, "boundChatId">,
  hold: { id: string | null; offered: boolean } | null,
  activeChatId: string | null
): ContinueGateProgress | null {
  if (!s.boundChatId || s.boundChatId !== activeChatId) return null;
  const id = answeringOf(hold?.id ?? null, s);
  if (!id) return null;
  const waiting = s.gates.some((g) => g.id === id) || (hold?.id === id && hold.offered);
  return waiting ? gateProgressOf(s, id) : null;
}

/**
 * **The same answer, as core asks it** (`TablePort.gateProgress`) — given this screen's own hold,
 * which the core hook selects from the reveal shallowly. One answer for the two surfaces that draw
 * the Continue, so the list of fields is this function's own and there is no second copy of it to
 * forget the next field — which is how a guest's press once recorded the vote and changed nothing on
 * screen (`pressing` was missing from a hand-written list).
 */
export function tableGateProgress(activeChatId: string | null, gate: RevealState["gate"]): ContinueGateProgress | null {
  return tableContinueOf(useRoomStore.getState(), holdFactsOf({ gate } as RevealState), activeChatId);
}


function tableNextOf(
  s: GateFacts & Pick<RoomStore, "boundChatId" | "wentOn">,
  activeChatId: string | null,
  lastMessageId: string | null
): TableNextTurn | null {
  if (s.phase !== "lobby" || !s.boundChatId || s.boundChatId !== activeChatId) return null;
  const open = openNextGate(s);
  const progress = open ? gateProgressOf(s, open.id) : null;
  return {
    open: open !== null,
    starting: !!lastMessageId && s.wentOn.includes(nextGateId(lastMessageId)),
    counted: progress?.counted ?? false,
    pressed: progress?.pressed ?? 0,
    total: progress?.total ?? 0,
    mine: progress?.mine ?? false,
  };
}

/** The table's Next turn, as core asks it (`TablePort.nextTurn`, drawn by `useTableNextTurn`). */
export function tableNextTurn(activeChatId: string | null, lastMessageId: string | null): TableNextTurn | null {
  return tableNextOf(useRoomStore.getState(), activeChatId, lastMessageId);
}

/**
 * **Next turn, pressed at a table** — from any seat. It reads on as well, as it does solo
 * (`requestTurn` continues the reveal): the hold this screen is parked at rides the same press.
 */
export function pressTableNextTurn(): void {
  const s = useRoomStore.getState();
  const next = openNextGate(s);
  if (!atTable() || !next) return;
  const hold = holdGateOf(app.story.chats.get().uiState.reveal);
  s.pressGates(hold ? [hold, next.id] : [next.id]);
}

/**
 * The Next turn the table would be offered now — the story stopped between two voices, nothing
 * being written, the table's reading done handing out the reply (`readingDone`) — or null. The AI
 * switch is asked too: with it off nothing starts from any door, and a button that starts nothing is
 * not offered.
 */
function hostNextOf(chatId: string, readingDone: boolean): string | null {
  if (!useRoomStore.getState().enableAI || !readingDone) return null;
  const state = app.story.chats.get();
  if (pipelineFor(state, chatId).isGenerating) return null;
  const chat = readChat(chatId);
  if (!chat) return null;
  // Stopped between two voices, or opened with one owed and nothing run since (`openChat`) —
  // the host's own screen offers both, and the table is what the host's screen would offer.
  if (!nextTurnOffered(chat, pipelineFor(state, chatId))) return null;
  const last = chat.messages[chat.messages.length - 1];
  return last ? nextGateId(last.id) : null;
}

let wired = false;
/**
 * Whether this tab's pause is the table's mirror. One bit, and genuinely local: leaving the table
 * mid-pause must hand the reader their own queue back rather than leave it held by a table they
 * are no longer at.
 */
let mirroringPause = false;
/**
 * What this screen last drew of the reader's reveal, over which copy of the chat, and the reveal it
 * wrote: drawn again only when one of the three moves. Never on its own write, which would loop; and
 * always over somebody else's (a transcript coming on screen shows itself whole), which would leave
 * this screen somewhere the reader is not.
 */
let drawn: { reveal: unknown; chat: unknown; wrote: RevealState } | null = null;
let drawing = false;
/** The table's chat this screen drew a reading of, so the end of the table lets it go. */
let drawnFor: string | null = null;
/** The table's reading and the copy of the chat the host last landed against, with its screen elsewhere. */
let landedAt: { reveal: unknown; chat: unknown } | null = null;

export function initContinueGate(): () => void {
  if (wired) return () => {};
  wired = true;
  const offs: (() => void)[] = [];

  offs.push(() => setRevealGatekeeper(null));
  setRevealGatekeeper(() => {
    if (!atTable()) return true;
    const s = useRoomStore.getState();
    const id = answeringOf(holdGateOf(app.story.chats.get().uiState.reveal), s);
    // Nothing the table is holding at and nothing paused: there is nothing to answer, and the
    // press is this screen's own (a stray hold the watcher has not yet let go of).
    if (!id && !s.paused) return true;
    s.pressGates(id ? [id] : []);
    return false;
  });

  offs.push(() => setRevealPauseKeeper(null));
  setRevealPauseKeeper(() => {
    if (!atTable()) return false;
    useRoomStore.getState().pauseTable();
    return true;
  });

  const check = () => {
    const room = useRoomStore.getState();
    if (room.phase !== "lobby" || !room.boundChatId) {
      // The table is over: a screen that was drawing its reading reads its own again.
      if (drawnFor) stopFollowingReading(drawnFor);
      drawnFor = null;
      drawn = null;
      return;
    }
    const chatId = room.boundChatId;
    const here = atTable();

    // Who reads: the host names the reader from its own screen and every seat's report.
    if (room.isHost) room.syncReader(showsStory());
    else room.reportOnStory(showsStory());

    const table = useRoomStore.getState();
    const reads = here && table.reader !== null && table.reader === table.selfId;
    const published = tableReadingOf(chatId);

    if (table.isHost) {
      const reveal = app.story.chats.get().uiState.reveal;
      const gate = reads ? reveal.gate : published?.gate ?? null;
      const hold = gate && !gate.byPause ? readGateId(gate.turnId) : null;
      // Done handing out the reply: the reader's walk has nothing left, or nobody is reading.
      const readingDone = reads ? !reveal.active : !published || (!published.behind && !published.gate);
      table.syncGates({
        hold,
        offered: !!hold && gate?.offered === true,
        next: hostNextOf(chatId, readingDone),
        generating: pipelineFor(app.story.chats.get(), chatId).isGenerating,
      });
    }

    if (!here) {
      // The host's screen is elsewhere and a guest may be reading: the host lands as the table's
      // reading shows things, since guests never land (`landTableReading`).
      // Asked again only when the reading or the chat moved: the watcher runs on every streamed
      // token, and building the transcript is a walk of all of it.
      const chat = readChat(chatId);
      if (table.isHost && (landedAt?.reveal !== published || landedAt?.chat !== chat)) {
        landedAt = { reveal: published, chat };
        landTableReading(chatId, published);
      }
      drawn = null;
      if (mirroringPause) {
        mirroringPause = false;
        if (app.story.chats.get().uiState.reveal.paused) setRevealPaused(false);
      }
      return;
    }

    /**
     * **Not the reader: draw the reader's reveal** — holds, pause and cards, and walk nothing. Drawn
     * again when the reveal moves, this screen's copy of the chat does (a line that had not reached
     * this copy yet is placed once it has), or something else wrote this screen's reveal (`drawn`).
     */
    if (!reads) {
      const chat = readChat(chatId);
      const liveId = pipelineFor(app.story.chats.get(), chatId).generatingMessageId ?? null;
      const now = app.story.chats.get().uiState.reveal;
      if (drawing || !chat || (drawn && drawn.reveal === published && drawn.chat === chat && drawn.wrote === now && readingFollowed(chatId))) return;
      // The write runs this again, synchronously, before `drawn` can say it was this one.
      drawing = true;
      try {
        mirrorReveal(chat, published, liveId);
      } finally {
        drawing = false;
      }
      drawn = { reveal: published, chat, wrote: app.story.chats.get().uiState.reveal };
      drawnFor = chatId;
      return;
    }

    // The reader: its worker walks from where the table was drawn (`stopFollowingReading` keeps
    // the place), and the table's releases and pause are what move it.
    drawn = null;
    if (readingFollowed(chatId)) stopFollowingReading(chatId);
    const reveal = app.story.chats.get().uiState.reveal;
    mirroringPause = true;
    if (reveal.paused !== table.paused) {
      // Writing it runs this again, which then finds them equal and goes on to the hold.
      setRevealPaused(table.paused);
      return;
    }

    /**
     * **Let go when the table has.** A hold the table's last release went on from is walked
     * through; a pause's hold goes when the table's pause does.
     */
    const gate = reveal.gate;
    if (!gate) return;
    if (gate.byPause ? !table.paused : table.wentOn.includes(readGateId(gate.turnId))) {
      releaseHeldReveal(gate.turnId);
    }
  };
  offs.push(useRoomStore.subscribe(check));
  // The reader's reveal arriving (on the host, from a guest reader; on a guest, relayed).
  offs.push(onTableReading(check));
  // A screen going hidden is a reader nobody is looking at: the reading is handed on.
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", check);
  offs.push(app.story.chats.subscribe((state, prev) => {
    if (
      state.uiState.reveal !== prev.uiState.reveal ||
      state.activeChatId !== prev.activeChatId ||
      // The host's Next turn reads the chat and its run, so either moving can open or close it.
      state.activeChat !== prev.activeChat ||
      state.pipelines !== prev.pipelines
    ) {
      check();
    }
  }));
  return () => {
    wired = false;
    for (const off of offs.splice(0)) off();
  };
}
