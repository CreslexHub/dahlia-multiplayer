import {
  isTerminalEvent,
  LEAVE_REASON_PARAM,
  type JoinRefusedReason,
  type LeaveReason,
  type RoomIntent,
  type RoomServerEvent,
} from "../shared/protocol";
import { app } from "@dahlia/plugin-api";
import type { PostAnswer } from "@dahlia/plugin-api";
import { relayPath } from "./join-link";

const { apiBeacon, joinUrl, roomFetch, roomHeader, answerOf } = app.net;

/**
 * The browser's end of the room transport: a long-poll loop down, `fetch` POSTs up.
 *
 * It was an EventSource. The registry's header (`plugins/multiplayer/server/rooms.ts`) records why it is
 * not any more: the tunnel's QUIC uplink withholds a streaming body until the stream
 * ends, measured — so the "stream" is a poll that the server parks until there is
 * something to say, answers, and closes. Same latency when something happens; delivered
 * everywhere.
 *
 * Each answer is acknowledged by sequence on the next ask, so a response lost on the
 * wire is re-delivered — and `seq` here skips what was already seen, so a duplicate is
 * dropped, never replayed. Terminal events end the loop for good; transient failures
 * back off and ask again.
 *
 * Fetches are relative like every other call in the app; the APK's absolute-origin seam
 * (MULTIPLAYER.md §7) is one mechanical migration for all of them together.
 */

export type WireStatus = "connecting" | "open" | "closed";

export type RoomConnectionHandlers = {
  onEvent: (event: RoomServerEvent) => void;
  onStatus: (status: WireStatus) => void;
  /** The room refused the join outright (poll answered 404/409, or a seat refusal — `refusalOf`). */
  onRefused: (reason: JoinRefusedReason) => void;
};

/**
 * A poll's answer that no amount of asking again will change — or `null` for one that might.
 *
 * **A seat refusal is one of them.** The seated doors answer 401 for a token that holds no seat
 * — the room is gone (the host's server restarted, the host closed it), or it has forgotten this
 * seat — and deliberately *the same* 401 for a code that names no room, so a stranger sweeping
 * codes through the poll learns nothing the rate-limited join door would not tell them
 * (`tests/realtime/routes.test.ts`). The loop read that 401 as a network hiccup and asked again
 * every five seconds for the life of the tab, under a "Reconnecting…" that could never clear.
 *
 * The LAN password's 401 is not one: it carries a `WWW-Authenticate` challenge, and answering
 * it is a thing the reader can still do.
 */
function refusalOf(res: Response): JoinRefusedReason | null {
  if (res.status === 404) return "not_found";
  if (res.status === 409) return "full";
  if (res.status === 401 && !res.headers?.has("WWW-Authenticate")) return "not_found";
  return null;
}

/** Errors back off to this ceiling; a healthy loop re-asks immediately. */
const RETRY_MAX_MS = 5_000;
const RETRY_START_MS = 1_000;

export class RoomConnection {
  private closed = false;
  private started = false;
  /** Which tab this is, so a second tab replaces this seat instead of fighting it. */
  private readonly connId = crypto.randomUUID();
  private seq = -1;
  private abort: AbortController | null = null;
  /** A page going away is not a reader leaving — see `LeaveReason`. */
  private readonly onPageHide = () => this.close("unload");
  private readonly host: string;
  /** What the last poll told the room we are called, so `refreshName` knows when to act. */
  private sentName = "";
  /** Set just before a deliberate abort, so the loop can tell it from a dropped network. */
  private renaming = false;
  /** The up-link's retry queue. See `lib/net/outbox.ts` for what each verb promises. */
  private readonly outbox = app.net.outbox({ post: (intent, to) => this.post(intent, to) });

  constructor(
    private readonly code: string,
    /**
     * Read per poll, not captured once.
     *
     * The name used to be a constructor argument — the string typed into the lobby that
     * session — so a rename could not reach a connection that was already open. It is the
     * reader's profile now, and a profile is a thing that changes while a room is live.
     */
    private readonly name: () => string,
    private readonly handlers: RoomConnectionHandlers,
    /**
     * The seat this connection speaks from.
     *
     * Minted by the room registry when somebody exchanged a code for a place at the table, and
     * carried on every request after that. It is the *whole* credential here — there is no
     * account behind it and no session — which is why it is a constructor argument rather than
     * something read from storage on the way past: a connection to a table it cannot prove it
     * belongs at is not a thing that should be constructible.
     */
    private readonly token: string,
    /**
     * The host's own address, when this guest reached the table through somebody else's
     * tunnel rather than through the page they are already on. Empty means "the server this
     * page came from", which is what every path here meant before rooms could be joined
     * across origins.
     */
    serverUrl?: string | null
  ) {
    this.host = serverUrl ? serverUrl.replace(/\/+$/, "") : "";
  }

  /**
   * A room path against the host's address.
   *
   * Joined by `joinUrl` rather than by a `${base}${path}` of its own: `lib/net/api.ts` is
   * where the app knows how to reach a server, and a second spelling of the join is how the
   * two drift. `apiFetch` leaves an absolute URL alone, so this is the only place the host
   * is applied.
   */
  private url(path: string): string {
    return joinUrl(this.host, path);
  }

  connect(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.handlers.onStatus("connecting");
    // The beacon-backed goodbye: a closed tab should not haunt the roster for a TTL.
    window.addEventListener("pagehide", this.onPageHide);
    void this.loop();
  }

  private async loop(): Promise<void> {
    let retryMs = RETRY_START_MS;
    while (!this.closed) {
      /**
       * The "I cut this myself" flag lives exactly as long as the request it cut.
       *
       * `refreshName` can land in the moment between a poll resolving and the loop coming
       * back round, and aborting a settled request does nothing at all — so without this the
       * flag would still be up when the *next* poll failed for a real reason, and a dropped
       * network would retry with no backoff and no "connecting", forever.
       */
      this.renaming = false;
      this.abort = new AbortController();
      this.sentName = this.name();
      try {
        const res = await roomFetch(
          this.url(
            `${relayPath(this.code, "poll")}?` +
              new URLSearchParams({
                name: this.sentName,
                connId: this.connId,
                after: String(this.seq),
              })
          ),
          this.token,
          { signal: this.abort.signal }
        );
        const refused = refusalOf(res);
        if (refused) {
          this.teardown();
          this.handlers.onRefused(refused);
          return;
        }
        if (!res.ok) throw new Error(`poll ${res.status}`);

        const { seq, events } = (await res.json()) as { seq: number; events: RoomServerEvent[] };
        this.handlers.onStatus("open");
        retryMs = RETRY_START_MS;

        for (let i = 0; i < events.length; i++) {
          const event = events[i];
          /**
           * A terminal event is not mail, so it is not acknowledged and not deduplicated.
           *
           * The room answers a retired or banned seat from a fast path that carries no
           * sequence of its own — `{ seq: after, events: [kicked] }`, the client's own
           * acknowledgement echoed back (`plugins/multiplayer/server/rooms.ts`) — so for a one-event answer
           * `eventSeq` came out exactly equal to the cursor and the filter below threw away
           * the one poll that carried the news. The tab stayed open, kept its status at
           * "open", and re-asked at RTT forever because `res.ok` resets the backoff. It only
           * ever worked when the victim's poll happened to be *parked* at that moment, which
           * is why it passes by hand on an idle table.
           *
           * Handling it twice is not a risk: this ends the loop for good.
           */
          if (isTerminalEvent(event)) {
            this.teardown();
            this.handlers.onEvent(event);
            return;
          }
          // Re-delivered mail from a lost response: sequences at or below the cursor
          // were already seen. `seq` names the last event in the answer.
          const eventSeq = seq - (events.length - 1 - i);
          if (eventSeq <= this.seq) continue;
          /**
           * Acknowledged as it is handed out, and handed out on its own.
           *
           * The cursor moved only after the whole answer, and a handler that threw landed in the
           * catch below as a dropped network — so one event this tab could not handle
           * un-acknowledged its batch, the next poll asked for it again, the events before it were
           * handled twice, and it threw again, every five seconds under "Reconnecting…". An event
           * that cannot be handled is a bug to report, not a reason to stop reading the table.
           */
          this.seq = eventSeq;
          try {
            this.handlers.onEvent(event);
          } catch (err) {
            console.error(`[room] a "${event.type}" event could not be handled`, err);
          }
        }
        this.seq = Math.max(this.seq, seq);
      } catch {
        if (this.closed) return;
        // We cut the poll ourselves. Asking again immediately is the point of it, and
        // painting "Reconnecting…" over a rename would report a fault that never happened.
        if (this.renaming) continue;
        this.handlers.onStatus("connecting");
        await new Promise((r) => setTimeout(r, retryMs));
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      }
    }
  }

  /**
   * The reader renamed themselves: carry it now rather than at the next poll.
   *
   * A poll parks for `POLL_PARK_MS` — twenty-five seconds of the table using the old name
   * while the new one sat on this device with nothing wrong. Cutting the parked request is
   * what makes the rename land in a beat; the server's own re-park logic already expects a
   * second poll from the same tab and answers the stale one first.
   */
  refreshName(): void {
    if (this.closed || !this.started || this.name() === this.sentName) return;
    this.renaming = true;
    this.abort?.abort();
  }

  /**
   * The three ways to say something, and the reason there is no fourth.
   *
   * `post` below is the raw POST and is **private**: it answers with a `PostAnswer` and never
   * throws, and a public method with that contract is a method every caller will forget to
   * check — which is exactly what happened, thirty-two times (`lib/net/outbox.ts`).
   * What is public is the outbox's three verbs, each of which says what kind of thing is
   * being said and therefore what should happen if the wire drops it.
   */

  /** *"This is the value of X now."* Retried, and superseded by a newer value of the same fact. */
  state(intent: RoomIntent, to?: string): void {
    this.outbox.state(intent, to);
  }

  /**
   * *"This happened."* Retried and kept in order; resolves false only if the outbox gives up —
   * the room ending, the backlog bound, or the room refusing this one message for good.
   */
  event(intent: RoomIntent, to?: string): Promise<boolean> {
    return this.outbox.event(intent, to);
  }

  /** *"Here is the picture right now."* One attempt — the next frame covers a lost one. */
  frame(intent: RoomIntent, to?: string): void {
    this.outbox.frame(intent, to);
  }

  /** What is still waiting to reach the room. Read by the resync watchdog and by fixtures. */
  get pending(): number {
    return this.outbox.depth;
  }

  private async post(intent: RoomIntent, to?: string): Promise<PostAnswer> {
    try {
      const res = await roomFetch(this.url(relayPath(this.code, "send")), this.token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(to === undefined ? { intent } : { intent, to }),
      });
      // The status, read — not reduced to `res.ok`, which made a 413 and a dropped network
      // the same answer and retried both for ever.
      return answerOf(res.status);
    } catch {
      return "retry";
    }
  }

  /**
   * Stop asking, and say goodbye so the roster does not wait out a TTL — and say which kind of
   * goodbye it is (`LeaveReason`): the Leave button's, or a page that is merely going away.
   */
  close(reason: LeaveReason = "leave"): void {
    if (this.closed) return;
    // sendBeacon survives page unload, where a fetch would be cancelled mid-flight — but it
    // cannot carry a header, and the seat token is one. `apiBeacon` falls back to a keepalive
    // fetch when there is something to send that a beacon could not.
    const query = new URLSearchParams({ [LEAVE_REASON_PARAM]: reason });
    apiBeacon(this.url(`${relayPath(this.code, "leave")}?${query}`), {
      headers: roomHeader(this.token),
    });
    this.teardown();
  }

  /** Stop the loop without the goodbye — the server already knows (terminal / refused). */
  private teardown(): void {
    if (this.closed) return;
    this.closed = true;
    // Whatever was still waiting is given up on out loud, so a guest's unsent line goes back
    // in their composer rather than disappearing with the room.
    this.outbox.close();
    window.removeEventListener("pagehide", this.onPageHide);
    this.abort?.abort();
    this.handlers.onStatus("closed");
  }
}
