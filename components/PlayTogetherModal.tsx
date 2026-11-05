"use client";

import { useEffect, useMemo, useState } from "react";
import { joinPagePath } from "../client/join-link";
import { useTunnel } from "./usePublicUrl";
import { ChatsCircleIcon, CheckIcon, CircleNotchIcon, CopyIcon, GearSixIcon, GlobeIcon, LinkIcon, SignOutIcon } from "@phosphor-icons/react";
import { SeatRow } from "./SeatRow";
import { MAX_ROOM_PLAYERS, ROOM_CODE_LENGTH } from "../shared/protocol";
import { parseRoomJoinInput, useRoomStore } from "../client/roomStore";
import { ROOM_ENDED_COPY } from "../client/endings";
import { useHostingAllowed } from "../client/hosting";
import { wearPlayerCard } from "../client/story-sync";
import { ui, app } from "@dahlia/plugin-api";
import type { Character, Chat, LanStatus } from "@dahlia/plugin-api";

const { isPlayerCharacterId } = app.cast;
const { characterListings, listings: library, cardsAwaySay, withWholeCards } = app.library;
const { apiFetch } = app.net;
const { RoomIcon, useCopyFlash, ConfirmRow, useConfirmLatch, PlayerIdentityRow, Reveal } = app.parts;
const { mutateChat, readChat, createChat } = app.story;
const { Modal, Button, IconButton, Label, Select, TextField } = ui;

/**
 * Hosting and joining a live room, in one dialog.
 *
 * The dialog renders whatever phase `roomStore` is in — it owns no session state of its
 * own, so closing it changes nothing about the room. That is deliberate: the room has to
 * outlive this panel (play happens elsewhere), so "leave" is a button, never a side effect
 * of dismissing a window. Only the text drafts (code, chat choice) live here, because a
 * draft is not state anyone else may read (§11).
 *
 * **It no longer asks your name.** There was a "Your name" field here, seeded from nothing
 * and persisted nowhere, so every session began by re-answering a question the app had
 * already been told — and the answer reached the room once, at seat time, after which it
 * could not be changed at all. The name is the reader's profile now (`PlayerName.tsx`), and
 * what stands here is a row that *shows* it with a pencil beside it.
 *
 * **Hosting hosts the story you are standing in.** A room is a table *around a story*, so
 * making one without a story would be a lobby with nowhere to go — but the story is not a
 * question, because the answer is already on screen behind this dialog. There was a picker
 * here listing every chat in the library, defaulted to the active one, so every host began by
 * confirming the thing they were already looking at. Opened from the home screen there is no
 * chat to host, and that is the one case where a room mints its own.
 *
 * Which chat that is, this dialog is **told** rather than reading `activeChatId`: that field
 * outlives the screen it belongs to, so on the home screen it still names the last chat
 * opened — a picker defaulted to it looked right and was a different answer to "the chat you
 * are in".
 *
 * Joining doesn't ask either: the story arrives with the host's first snapshot, and this
 * dialog walks both chairs into `/chat` the moment the binding is known.
 */

export function PlayTogetherModal({
  open,
  onClose,
  chat = null,
}: {
  open: boolean;
  onClose: () => void;
  /** The story on screen behind this dialog, or `null` on a screen that is not a chat. */
  chat?: Pick<Chat, "id" | "title"> | null;
}) {
  const phase = useRoomStore((s) => s.phase);
  const boundChatId = useRoomStore((s) => s.boundChatId);
  // Whose table this is — said in the header, so a guest never wonders whose story
  // they are writing in and whose rules apply.
  const hostName = useRoomStore((s) => s.roster.find((p) => p.isHost)?.name ?? null);
  const isHost = useRoomStore((s) => s.isHost);
  const router = app.nav.useNavigate();

  // Both chairs walk into the story the moment the room knows which one it plays: the
  // host right after hosting, the guest when the first snapshot names it. Once per
  // binding (`walkedInto`, in the room's store) — neither a re-render nor another screen
  // mounting this dialog may yank someone back who deliberately left for home.
  const walkedInto = useRoomStore((s) => s.walkedInto);
  useEffect(() => {
    if (phase !== "lobby" || !boundChatId || walkedInto === boundChatId) return;
    useRoomStore.setState({ walkedInto: boundChatId });
    router.push(app.nav.chatPath(boundChatId));
  }, [phase, boundChatId, walkedInto, router]);

  /*
   * **Hosting keeps the story it hosts** — the owner's ruling, closing the product half of
   * TURNS.md §21.2. It was a guard here that pushed the host back to the hosted chat the moment
   * they opened another, with no word, which read as being teleported (round 2026-10-06C). Nobody
   * is moved now: `HostingElsewhere`, mounted once for the whole app, covers another chat with a
   * notice that names the hosted story and offers the way back or the end of the session, and
   * stands a "Hosting · <story>" pill on every other screen.
   */

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={phase === "lobby" && hostName ? `${hostName}'s lobby` : "Multiplayer"}
      subtitle={
        phase === "lobby"
          ? isHost
            ? "Share the code — friends sign in and join with it"
            : "The host's tab runs this table, with their settings."
          : undefined
      }
      icon={<RoomIcon className="h-5 w-5" />}
      width="max-w-md"
      stretchMode="none"
    >
      {phase === "idle" && <ChoosePhase chat={chat} />}
      {phase === "connecting" && (
        <p className="py-8 text-center text-xs text-ink-300">Connecting…</p>
      )}
      {phase === "lobby" && <LobbyPhase onClose={onClose} />}
      {phase === "ended" && <EndedPhase onClose={onClose} />}
    </Modal>
  );
}

/**
 * **A box's hint is read as a sentence, in the dialog's own face** — whatever face the box gives what
 * is typed into it. The code is typed in spaced monospace capitals, which read a code aloud, and its
 * hint wore them too: "E.G. ABCDEF OR HTTPS:/", cut off at a phone's width. The address box's hint, in
 * a monospace at a phone's 16px, was cut the same way ("e.g. https://xxx.trycloudflare.co").
 */
const HINT_FACE = "placeholder:font-interface placeholder:normal-case placeholder:tracking-normal";

function ChoosePhase({ chat }: { chat: Pick<Chat, "id" | "title"> | null }) {
  const hostRoom = useRoomStore((s) => s.hostRoom);
  const joinRoom = useRoomStore((s) => s.joinRoom);
  const error = useRoomStore((s) => s.error);
  // Hosting is offered only while this machine's switch is on: a guest's tab, woken by an invite
  // link with no record to read, offers joining alone.
  const mayHost = useHostingAllowed();
  const [code, setCode] = useState("");
  const [hostUrl, setHostUrl] = useState("");
  const [showHostInput, setShowHostInput] = useState(false);

  const parsed = useMemo(() => parseRoomJoinInput(code, hostUrl), [code, hostUrl]);
  const canJoin = parsed.code.length === ROOM_CODE_LENGTH;

  const handleCodeChange = (val: string) => {
    if (/^https?:\/\//i.test(val.trim())) {
      const p = parseRoomJoinInput(val);
      if (p.hostAddress) setHostUrl(p.hostAddress);
      if (p.code) setCode(p.code);
      else setCode(val);
    } else {
      setCode(val.toUpperCase());
    }
  };

  /**
   * Host the story behind this dialog — or, on a screen that is not a chat, a new one.
   *
   * The `multiplayer` marker follows the act rather than being asked for: hosting a chat is
   * what makes it a multiplayer chat, and it is what Chat style's table region reads
   * afterwards to go on offering the table's rules once the room has closed.
   */
  const startHosting = () => {
    let chatId = chat?.id;
    if (!chatId) {
      chatId = createChat().id;
      mutateChat(chatId, (draft) => {
        draft.title = "Multiplayer chat";
        draft.multiplayer = true;
      });
    } else {
      mutateChat(chatId, (draft) => {
        draft.multiplayer = true;
      });
    }
    void hostRoom(chatId);
  };

  const handleJoin = () => {
    if (!canJoin) return;
    void joinRoom(parsed.code, parsed.hostAddress);
  };

  return (
    <div className="space-y-5">
      <PlayerIdentityRow className="rounded-lg border border-line-300 bg-well px-3 py-2.5" />

      {mayHost && (
        <>
          {/* The story, named rather than chosen — it is the one behind this dialog, and saying
              which is the whole of what the picker here used to be for. */}
          <div className="flex items-center gap-2.5 rounded-lg border border-line-300 bg-well px-3 py-2.5">
            <ChatsCircleIcon className="h-4 w-4 shrink-0 text-accent-400" />
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-ink-600" data-host-chat>
                {chat ? chat.title : "A new multiplayer chat"}
              </p>
              <p className="text-3xs text-ink-200">
                {chat
                  ? "Friends who join land in this story."
                  : "To play a story you already have, open it and host from there."}
              </p>
            </div>
          </div>

          <Button variant="primary" className="w-full" onClick={startHosting}>
            {chat ? "Host this chat" : "Host a new chat"}
          </Button>

          <div className="flex items-center gap-3 text-3xs uppercase tracking-wider text-ink-200">
            <span className="h-px flex-1 bg-line-300" />
            or join one
            <span className="h-px flex-1 bg-line-300" />
          </div>
        </>
      )}

      <div className="space-y-3">
        <div>
          <Label htmlFor="room-code" hint="The host's 6-character code, or their invite link.">
            Room code or invite link
          </Label>
          <div className="flex gap-2">
            <TextField
              id="room-code"
              value={code}
              onChange={(e) => handleCodeChange(e.target.value)}
              placeholder="e.g. ABCDEF or https://..."
              className={`${HINT_FACE} ${code.length <= ROOM_CODE_LENGTH ? "font-mono uppercase tracking-widest" : "text-xs"}`}
            />
            <Button disabled={!canJoin} onClick={handleJoin}>
              Join
            </Button>
          </div>
        </div>

        <div className="space-y-1.5">
          <button
            type="button"
            aria-expanded={showHostInput || !!hostUrl}
            onClick={() => setShowHostInput((v) => !v)}
            className="text-3xs text-ink-300 hover:text-ink-600 transition-colors"
          >
            {showHostInput || hostUrl ? "Host tunnel / server URL:" : "+ Specify host tunnel / server URL"}
          </button>
          <Reveal open={showHostInput || !!hostUrl} gap="1.5">
            <TextField
              id="room-host-url"
              value={hostUrl}
              onChange={(e) => setHostUrl(e.target.value)}
              placeholder="A tunnel link, or 192.168.1.50:3000"
              className={`text-xs font-mono ${HINT_FACE}`}
            />
          </Reveal>
        </div>
      </div>

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

/**
 * Whether a friend on this network can reach the table, and at what address — the server's
 * answer (`/api/server/lan`), which any device that can host may read.
 *
 * The lobby said "This code works on your own network" whatever the network setting was. Closed —
 * the default — it worked on this computer alone; and open, a friend was asked for the password
 * that opens the library, until round 2026-10-06B served such a friend the table without one.
 * `null` while unread or unreadable, and then the lobby says nothing about the network rather
 * than guessing.
 */
type NetworkDoor = { open: false } | { open: true; address: string | null };

function useNetworkDoor(active: boolean): NetworkDoor | null {
  const [door, setDoor] = useState<NetworkDoor | null>(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    apiFetch("/api/server/lan")
      .then((res) => (res.ok ? (res.json() as Promise<LanStatus>) : null))
      .then((status) => {
        if (!live || !status) return;
        const address = status.listening && status.port && status.addresses[0] ? `http://${status.addresses[0]}:${status.port}` : null;
        setDoor(status.enabled ? { open: true, address } : { open: false });
      })
      .catch(() => {
        // Unread: the lobby says nothing about the network.
      });
    return () => {
      live = false;
    };
  }, [active]);
  return door;
}

/** The lobby's sentence about this network, true in each state the setting can be in. */
function NetworkLine({ door, code }: { door: NetworkDoor | null; code: string }) {
  if (!door) return null;
  if (!door.open) {
    return (
      <p className="leading-relaxed text-ink-200">
        Friends on your network can join once you switch on Network → Open to your network.
      </p>
    );
  }
  if (!door.address) return null;
  const join = `${door.address}${joinPagePath(code)}`;
  return (
    <p className="leading-relaxed text-ink-200">
      Friends on your network can join at <span className="select-all break-all font-mono text-ink-400">{join}</span> — no
      password needed.
    </p>
  );
}

function LobbyPhase({ onClose }: { onClose: () => void }) {
  const code = useRoomStore((s) => s.code);
  const hostAddress = useRoomStore((s) => s.hostAddress);
  const roster = useRoomStore((s) => s.roster);
  const isHost = useRoomStore((s) => s.isHost);
  const leaveRoom = useRoomStore((s) => s.leaveRoom);
  const wireStatus = useRoomStore((s) => s.wireStatus);
  const boundChatId = useRoomStore((s) => s.boundChatId);
  const router = app.nav.useNavigate();
  const leaveLatch = useConfirmLatch<HTMLDivElement>();
  const exitTable = useTableExit(onClose);
  // One implementation of "copy, then say so" — and it only says so when the write landed.
  const codeCopy = useCopyFlash();
  const linkCopy = useCopyFlash();

  // The story this table plays, read once per render for the faces and the claimable cast.
  // The lobby has always been a view of `roomStore`; the chat is what puts a face on a name.
  const chat = boundChatId ? readChat(boundChatId) ?? null : null;

  /**
   * The address a friend can actually reach, which this screen is **told**.
   *
   * It used to be `window.location.origin` — where the *host's own browser* happens to be
   * pointed. A host working on `localhost:3939` therefore copied a link to their friend's own
   * computer: confidently wrong, with nothing to flag it. That is §13.2, and the producer here
   * is the server, which knows because the tunnel tells it (`plugins/multiplayer/server/public-url.ts`).
   *
   * A guest's tab keeps `hostAddress` — they were given somebody else's address to get here and
   * it is by definition reachable — so that branch stays and is asked first.
   */
  const tunnel = useTunnel(Boolean(code) && isHost);
  const networkDoor = useNetworkDoor(Boolean(code) && isHost);
  const inviteBase = hostAddress || tunnel.url;
  const inviteUrl = useMemo(
    () => (code && inviteBase ? `${inviteBase}${joinPagePath(code)}` : ""),
    [code, inviteBase]
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-center gap-2 rounded-lg border border-line-300 bg-well py-3 px-4">
        <span className="font-mono text-base font-black uppercase tracking-widest text-ink-700">
          {code}
        </span>
        <IconButton
          label={codeCopy.copied ? "Copied code" : "Copy room code"}
          size="sm"
          onClick={() => codeCopy.copy(code ?? "")}
        >
          {codeCopy.copied ? <CheckIcon className="h-4 w-4 text-teal-600 dark:text-teal-400" /> : <CopyIcon className="h-4 w-4" />}
        </IconButton>
        {inviteUrl && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-3xs text-ink-400"
            onClick={() => linkCopy.copy(inviteUrl)}
          >
            {linkCopy.copied ? <CheckIcon className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" /> : <LinkIcon className="h-3.5 w-3.5" />}
            <span>{linkCopy.copied ? "Link copied" : "Copy link"}</span>
          </Button>
        )}
      </div>

      {/*
        Said plainly rather than left as an absent button.

        A host who has not opened the tunnel has a code that works on their own network, once it is
        open, and nowhere else (`NetworkLine` says which), and the version of this screen that simply
        hid the link left them reading the code aloud to somebody who could never reach it. The button is that sentence made
        actionable; the sentence stays, because the button is not self-explanatory either.

        **Stop only where there is something to stop.** `permanent` is a configured
        address (the plugin's setting) — an address this screen did not open and cannot close — and offering
        it a Stop that does nothing is a control whose answer cannot differ. Same for Start when
        the machine has no cloudflared: it says so instead of failing on press.
      */}
      {isHost && (
        <div className="-mt-3 flex flex-col items-center gap-2 text-center text-3xs text-ink-300">
          {/* The address wraps rather than truncating. It is the one thing on this screen a
              host may have to read out or type somewhere else — a tunnel hostname is long and
              random, and half of one is worth nothing. `select-all` so a press takes the whole
              of it even where the clipboard button cannot be used. */}
          {inviteUrl ? (
            <div className="flex w-full items-start justify-between gap-2 rounded-md border border-line-300/60 bg-surface-200/50 px-3 py-1.5 font-mono text-3xs">
              <span className="min-w-0 select-all break-all text-left text-ink-200" title={inviteUrl}>
                {inviteUrl}
              </span>
              {!tunnel.permanent && tunnel.canChange && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 shrink-0 text-3xs text-rose-600 dark:text-rose-400 hover:text-rose-300"
                  onClick={() => void tunnel.stopTunnel()}
                >
                  Stop tunnel
                </Button>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-1.5">
              <NetworkLine door={networkDoor} code={code ?? ""} />
              <p className="leading-relaxed text-ink-200">To play with somebody elsewhere:</p>
              {!tunnel.canChange ? (
                // A phone hosting: the tunnel is the computer's to open, as on the plugin card.
                <p className="leading-relaxed">{app.plugins.computerOnly}</p>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={tunnel.starting}
                  onClick={() => void tunnel.startTunnel()}
                  className="gap-1.5"
                >
                  {tunnel.starting ? (
                    <>
                      <CircleNotchIcon className="h-3.5 w-3.5 animate-spin text-teal-600 dark:text-teal-400" />
                      <span>Opening a Cloudflare tunnel…</span>
                    </>
                  ) : (
                    <>
                      <GlobeIcon className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
                      <span>Open a Cloudflare tunnel</span>
                    </>
                  )}
                </Button>
              )}
              {tunnel.error && <p className="text-rose-600 dark:text-rose-400">{tunnel.error}</p>}
            </div>
          )}
        </div>
      )}

      {wireStatus !== "open" && (
        <p className="text-center text-2xs text-amber-600 dark:text-amber-400">Reconnecting…</p>
      )}

      <div>
        <p className="mb-1.5 text-xs font-medium text-ink-500">
          Players{" "}
          <span className="font-normal text-ink-200">
            {roster.length}/{MAX_ROOM_PLAYERS}
          </span>
        </p>
        {/* The same row the table's Seats list draws, so a face and a claim read one way in
            both places. `assign` is off here: the lobby says who is here, and deciding who
            plays whom is the deep surface's question — the button below is the door to it. */}
        <ul className="space-y-1">
          {roster.map((player) => (
            <SeatRow key={player.id} chat={chat} player={player} assign={false} />
          ))}
        </ul>
      </div>

      {/* Who you are, beside who you are *playing* — the two halves of the same question,
          and the reason a rename is reachable without leaving the table. It changes the
          roster on every screen within a poll; what it cannot reach is written down on
          `announceName`'s trail (roomStore → connection → rooms.ts). */}
      <PlayerIdentityRow />

      <PlayingAsPicker />

      {/*
        AI generation, the reading pace, guest rights and the seating all used to be *here* as
        well as on the Multiplayer tab — the AI toggle a verbatim second copy, the roster and
        the kick a third rendering. One door now, and it is a door rather than a duplicate.
      */}
      {boundChatId && (
        <Button
          variant="ghost"
          className="w-full"
          onClick={() => {
            onClose();
            app.story.chats.get().setUIState({
              settingsModalOpen: true,
              settingsInitialSection: "chatstyle",
            });
          }}
        >
          <GearSixIcon className="h-4 w-4" />
          {isHost ? "Table settings" : "See the table's settings"}
        </Button>
      )}

      {/* The cost of the host-authoritative design, said where it applies (MULTIPLAYER §2.1). */}
      <p className="text-2xs text-ink-200">
        The room lives in the host&apos;s tab. If the host closes it, the session ends for
        everyone.
      </p>

      {boundChatId ? (
        <Button
          variant="primary"
          className="w-full"
          onClick={() => router.push(app.nav.chatPath(boundChatId))}
        >
          <ChatsCircleIcon className="h-4 w-4" />
          Open the story
        </Button>
      ) : (
        // A guest between joining and the host's first snapshot — the story, its cast
        // and every portrait travel inside that one payload, so this wait *is* the
        // "downloading resources" moment and is named as one.
        !isHost && (
          <p className="animate-pulse text-center text-2xs text-ink-200">
            Downloading the story and its resources…
          </p>
        )
      )}

      {/* Asked, not done on the press — and the question says which of the two it is, because
          a host's answer ends the evening for everybody and a guest's ends their own. The
          latch is the app's one "are you sure": it disarms on an outside press, on Escape and
          on a timeout, and Cancel lands where the trigger was (`useConfirmLatch`). */}
      <div ref={leaveLatch.ref} className="w-full">
        {leaveLatch.armed ? (
          <ConfirmRow
            align="start"
            question={
              isHost
                ? "This ends the session for everyone at the table."
                : "You will stop reading this story and go back to your own chats."
            }
            confirmLabel={isHost ? "Close the room" : "Leave session"}
            onConfirm={() => {
              leaveLatch.disarm();
              exitTable();
            }}
            onCancel={leaveLatch.disarm}
          />
        ) : (
          <Button variant="danger" className="w-full" onClick={leaveLatch.arm}>
            <SignOutIcon className="h-4 w-4" />
            {isHost ? "Close the room" : "Leave session"}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * **Leaving lets you go.**
 *
 * The version this replaces called `leaveRoom` and stopped there, which left the dialog
 * standing open on the host-or-join screen — the front door of the thing just left — while
 * the reader went on sitting in a story that no longer had a room behind it. Three things
 * have to happen and they are one act: the wire says goodbye, this panel closes, and a guest
 * standing in the host's story is taken back to their own chats.
 *
 * The guest *view* is not torn down here. `isGuestChatId` is the gate that stops a guest's
 * copy of somebody else's story reaching their library, so clearing it while the reader is
 * still standing in it opens exactly that door; the watcher in `story-sync` drops it once
 * they are out, which is a moment this function cannot observe.
 */
function useTableExit(onClose: () => void): () => void {
  const router = app.nav.useNavigate();
  return () => {
    const { isHost, boundChatId } = useRoomStore.getState();
    const leavingStory =
      !isHost && boundChatId && app.story.chats.get().activeChatId === boundChatId
        ? boundChatId
        : null;
    useRoomStore.getState().leaveRoom();
    onClose();
    if (leavingStory) router.replace("/");
  };
}

/**
 * Who you are at this table: yourself, a player-controlled character from the story's
 * cast (a *claim*, resolved by the host, first-come), or one of your own cards — which
 * travels to the host and becomes your face on everyone's screen.
 *
 * The value the select shows is derived from the *host's* answer (`claims`), not from
 * what was asked for — picking a character someone else holds snaps visibly back, which
 * is the refusal, shown instead of toasted.
 */
function PlayingAsPicker() {
  const selfId = useRoomStore((s) => s.selfId);
  const roster = useRoomStore((s) => s.roster);
  const claims = useRoomStore((s) => s.claims);
  const boundChatId = useRoomStore((s) => s.boundChatId);
  const requestClaim = useRoomStore((s) => s.requestClaim);
  // Own cards are read once per open — the shelf cannot change under this dialog. As their listings
  // name them: the one worn is fetched whole first (`withWholeCards`).
  const myCards = useMemo(() => characterListings(), []);
  const [cardChoice, setCardChoice] = useState<string>("");

  if (!selfId) return null;
  const selfName = roster.find((p) => p.id === selfId)?.name ?? "Yourself";
  const chat = boundChatId ? readChat(boundChatId) : undefined;
  // The claimable cast: player-controlled characters that are the story's own, not the
  // table identities minted for other accounts.
  const cast = (chat?.characters ?? []).filter(
    (c) => c.roleSetting === "user" && !isPlayerCharacterId(c.id)
  );
  const holderName = (charId: string): string | null => {
    const owner = Object.entries(claims).find(([o, held]) => held === charId && o !== selfId)?.[0];
    return owner ? roster.find((p) => p.id === owner)?.name ?? "someone" : null;
  };

  const value = claims[selfId] ?? (cardChoice ? `card:${cardChoice}` : "self");
  const CARD_PREFIX = "card:";
  const onPick = (picked: string) => {
    if (picked === "self") {
      setCardChoice("");
      requestClaim(null);
      return;
    }
    if (picked.startsWith(CARD_PREFIX)) {
      const card = myCards.find((c) => c.id === picked.slice(CARD_PREFIX.length));
      if (!card) return;
      setCardChoice(card.id);
      // A card is worn on your own minted character, so any cast claim is let go first.
      requestClaim(null);
      // Worn whole: a listing worn would put a card with no description and a portrait that is an
      // address on the PC in front of every seat at the table.
      const shelf = library("characters");
      void withWholeCards(shelf, [card], ([whole], away) => {
        if (away) ui.showNotice(cardsAwaySay(shelf, away));
        if (whole) wearPlayerCard(whole as Character);
      });
      return;
    }
    setCardChoice("");
    requestClaim(picked);
  };

  return (
    <div>
      <Label htmlFor="room-playing-as" hint="The character other players see you as.">
        Playing as
      </Label>
      <Select id="room-playing-as" value={value} onChange={(e) => onPick(e.target.value)}>
        <option value="self">Myself — {selfName}</option>
        {cast.length > 0 && (
          <optgroup label="Story characters">
            {cast.map((c) => {
              const held = holderName(c.id);
              return (
                <option key={c.id} value={c.id} disabled={!!held}>
                  {c.name}
                  {held ? ` — taken by ${held}` : ""}
                </option>
              );
            })}
          </optgroup>
        )}
        {myCards.length > 0 && (
          <optgroup label="My cards">
            {myCards.map((c) => (
              <option key={c.id} value={`${CARD_PREFIX}${c.id}`}>
                {c.name}
              </option>
            ))}
          </optgroup>
        )}
      </Select>
    </div>
  );
}

function EndedPhase({ onClose }: { onClose: () => void }) {
  const endedReason = useRoomStore((s) => s.endedReason);
  const exitTable = useTableExit(onClose);

  return (
    <div className="space-y-5 py-4 text-center">
      <p className="text-xs text-ink-500">
        {endedReason ? ROOM_ENDED_COPY[endedReason].copy : "The room ended."}
      </p>
      {/* The same exit the leave button takes, for the same reason: a guest whose table has
          gone is still standing in its story, and "Back" that only reset the dialog to the
          host-or-join screen left them there. */}
      <Button className="w-full" onClick={exitTable}>
        Done
      </Button>
    </div>
  );
}
