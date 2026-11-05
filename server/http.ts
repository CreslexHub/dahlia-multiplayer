import type { PluginCaller, PluginServerContext } from "@dahlia/plugin-api/server";
import { createRoom, intentCeiling, joinRoom, kickPlayer, leaveRoom, MAX_CONN_ID_LENGTH, pollEvents, relayIntent, seatFor } from "./rooms";
import { getTunnelStatus } from "./tunnel";
import { publicBaseUrl, publicUrlIsPermanent } from "./public-url";
import { LEAVE_REASON_PARAM } from "../shared/protocol";
import { ROOM_MOUNT, TUNNEL_MOUNT, PUBLIC_URL_MOUNT } from "../mount";

/**
 * **Multiplayer's addresses**, answered in its own process (`.agents/PLUGIN-PLATFORM.md` §9):
 *
 * - `room` (public): `POST room` mints a room — hosting, so the reader's own devices only;
 *   `room/<code>/{join,poll,send,leave,kick}` is the relay, reached by guests at the public address.
 * - `tunnel`, `public-url`: what the lobby reads, the reader's own devices only.
 *
 * Who is asking is the app's to say (`caller`): its door, the seat token it sent, its address. The
 * app has already held the body to the seat's allowance and spent the public door's rate limit.
 */

/**
 * Wrong codes one address may try a quarter hour, and new seats it may be handed. Twenty wrong codes:
 * a code is read off a screen or over a call, and three fumbles are not an attack. Thirty new seats:
 * a reload rejoins on the token it holds and spends nothing; thirty is a guest clearing their browser
 * every half-minute.
 */
export const JOIN_BUDGET = 20;
export const SEAT_BUDGET = 30;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const notFound = () => json({ error: "Not found" }, 404);
const noSeat = () => json({ error: "Not at this table" }, 401);

/** The body, read as JSON within the seat's own ceiling (the app held it to the seat's allowance already). */
async function readJson(req: Request, ceiling: number): Promise<{ value: unknown; bytes: number } | "too_large" | "malformed"> {
  // Refused on what it declares before a byte is read: a guest's oversized intent costs nothing.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > ceiling) return "too_large";
  const buffer = new Uint8Array(await req.arrayBuffer());
  if (buffer.byteLength > ceiling) return "too_large";
  try {
    return { value: JSON.parse(new TextDecoder().decode(buffer) || "null"), bytes: buffer.byteLength };
  } catch {
    return "malformed";
  }
}

async function join(caller: PluginCaller, ctx: PluginServerContext, code: string): Promise<Response> {
  // Budgeted unless it is this computer itself: a guest at the tunnel or on the WiFi guesses codes.
  const budgeted = caller.door === "public" || !caller.thisComputer;
  const address = caller.address ?? "";
  const joinKey = `join:${caller.address ?? "unknown"}`;
  const seatKey = `seat:${caller.address ?? "unknown"}`;
  const tries = await ctx.attempts(joinKey, JOIN_BUDGET);
  const seats = await ctx.attempts(seatKey, SEAT_BUDGET);
  if (budgeted && !tries.allowed) {
    return json({ error: "Too many tries. Wait a moment and check the code with the host.", retryAfterSecs: tries.retryAfterSecs }, 429);
  }
  const result = joinRoom(code.toUpperCase(), address, caller.credential, { mayMint: !budgeted || seats.allowed });
  if (!result.ok) {
    if (budgeted && result.reason === "not_found") await ctx.noteAttempt(joinKey);
    if (result.reason === "busy") {
      return json({ error: "Too many new seats from here. Wait a moment and try again.", retryAfterSecs: seats.retryAfterSecs }, 429);
    }
    return json({ error: result.reason }, result.reason === "not_found" ? 404 : 403);
  }
  if (budgeted && result.minted) await ctx.noteAttempt(seatKey);
  return json({ id: result.id, token: result.token, isHost: result.isHost });
}

async function poll(ctx: PluginServerContext, url: URL, code: string, id: string): Promise<Response> {
  const name = await ctx.playerName(url.searchParams.get("name"));
  const connId = url.searchParams.get("connId") ?? "";
  const after = Number(url.searchParams.get("after") ?? -1);
  if (!connId || connId.length > MAX_CONN_ID_LENGTH || !Number.isInteger(after)) return json({ error: "Malformed poll" }, 400);
  const result = await pollEvents(code, id, name, connId, after);
  if (!result.ok) return json({ error: result.reason }, result.reason === "not_found" ? 404 : result.reason === "busy" ? 429 : 409);
  return json(result, 200, { "Cache-Control": "no-store, no-transform" });
}

async function send(req: Request, code: string, id: string): Promise<Response> {
  const body = await readJson(req, intentCeiling(code, id));
  if (body === "too_large") return json({ error: "Too large to send" }, 413);
  if (body === "malformed") return json({ error: "Malformed body" }, 400);
  const { intent, to } = (body.value ?? {}) as { intent?: unknown; to?: unknown };
  if (!intent || typeof intent !== "object" || typeof (intent as { kind?: unknown }).kind !== "string" || (to !== undefined && typeof to !== "string")) {
    return json({ error: "Malformed intent" }, 400);
  }
  const result = relayIntent(code, id, intent as { kind: string; data?: unknown }, to, body.bytes);
  if (result === "too_large") return json({ error: "Too large to send" }, 413);
  if (result === "backlogged") return json({ error: "Too much unread" }, 429);
  if (result === "not_found") return json({ error: "No such room" }, 404);
  if (result === "not_member") return json({ error: "Not in this room" }, 403);
  if (result === "absent") return json({ error: "Nobody is in that seat" }, 410);
  return json({ success: true });
}

async function kick(req: Request, code: string, id: string): Promise<Response> {
  const body = await readJson(req, intentCeiling(code, id));
  const target = typeof body === "object" ? (body.value as { target?: unknown } | null)?.target : undefined;
  if (typeof body !== "object") return json({ error: "Malformed body" }, 400);
  if (typeof target !== "string" || !target) return json({ error: "No target" }, 400);
  const result = kickPlayer(code, id, target);
  if (result === "not_found") return json({ error: "No such room" }, 404);
  if (result === "not_host") return json({ error: "Only the host kicks" }, 403);
  if (result === "not_member") return json({ error: "Not at this table" }, 404);
  return json({ success: true });
}

/** `POST <verb>` / `GET poll` → its handler: the relay's routes, read by the tests off this list. */
export const RELAY_ROUTES: readonly string[] = ["POST join", "GET poll", "POST send", "POST leave", "POST kick"];

/** One request to one of Multiplayer's mounts. */
export async function answer(req: Request, caller: PluginCaller, ctx: PluginServerContext): Promise<Response> {
  const url = new URL(req.url);
  const [mount, ...rest] = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const ownDevice = caller.door === "private" && caller.owner !== null;
  if (mount === TUNNEL_MOUNT || mount === PUBLIC_URL_MOUNT) {
    if (!ownDevice || req.method !== "GET" || rest.length > 0) return notFound();
    return mount === TUNNEL_MOUNT
      ? json({ ...getTunnelStatus(), canChange: caller.thisComputer })
      : json({ url: publicBaseUrl(), permanent: publicUrlIsPermanent() });
  }
  if (mount !== ROOM_MOUNT) return notFound();
  // Minting a room is hosting, running a story out of the reader's own library: never a guest's.
  if (rest.length === 0) return req.method === "POST" && ownDevice ? json(createRoom()) : notFound();
  if (rest.length !== 2) return notFound();
  const [code, verb] = rest;
  const route = `${req.method} ${verb}`;
  if (!RELAY_ROUTES.includes(route)) return notFound();
  if (route === "POST join") return join(caller, ctx, code);
  const id = seatFor(code, caller.credential);
  if (!id) return noSeat();
  if (route === "GET poll") return poll(ctx, url, code, id);
  if (route === "POST send") return send(req, code, id);
  if (route === "POST kick") return kick(req, code, id);
  leaveRoom(code, id, url.searchParams.get(LEAVE_REASON_PARAM) === "unload" ? "unload" : "leave");
  return json({ success: true });
}
