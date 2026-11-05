import { defineServerPlugin, type PluginServerContext } from "@dahlia/plugin-api/server";
import { closeEveryRoom, kickFromThisComputer, roomsOpen, seatGrants } from "../server/rooms";
import { answer } from "../server/http";
import { getTunnelStatus, startTunnel, stopTunnel } from "../server/tunnel";
import { setConfiguredAddress } from "../server/public-url";
import { fetchCloudflared, programFile, programReady } from "../server/cloudflared";

/**
 * **Multiplayer's server half** — the rooms, the relay, the tunnel — in the walled process the app
 * starts for it. It talks to the app only through `ctx`: it never starts cloudflared (the app does,
 * the pinned file only), and it tells the app its seats rather than being asked them.
 */

/** What the card asks before switching off or removing the plugin under a live table (D4). */
export const ENDS_THE_SESSION =
  "Switching Multiplayer off ends every table this computer hosts: everyone at them is told it is over, and the stories stay in your library.";

/** How often the seat table is compared with the last one sent: a seat that expired on its own goes too. */
const SEATS_EVERY_MS = 2_000;

let lastSeats = "";
let seatTimer: ReturnType<typeof setInterval> | null = null;

/** The whole seat table, sent when it differs from the last one sent (the app keeps only the last). */
function tellSeats(ctx: PluginServerContext): void {
  const grants = seatGrants();
  const shape = JSON.stringify(grants);
  if (shape === lastSeats) return;
  lastSeats = shape;
  void ctx.setSeats(grants).catch((err: Error) => ctx.log(`could not tell the app its seats: ${err.message}`));
}

/** Open the tunnel, fetching cloudflared the first time — one door for the download as for the tunnel. */
async function openTunnel(ctx: PluginServerContext): Promise<void> {
  if (!programReady(ctx.dir)) await fetchCloudflared(ctx.dir, ctx.log);
  const status = await startTunnel(ctx, programFile());
  if (status.error) throw new Error(status.error);
}

export default defineServerPlugin({
  // Installing downloads nothing: rooms on your own network need no program.
  async start(ctx) {
    setConfiguredAddress(ctx.settings.publicAddress);
    seatTimer ??= setInterval(() => tellSeats(ctx), SEATS_EVERY_MS);
    // Not awaited: opening waits up to 25s for an address (and, the first time, the download).
    if (ctx.settings.openOnStart === true) void openTunnel(ctx).catch((err: Error) => ctx.log(`could not open the tunnel: ${err.message}`));
  },
  async stop(ctx) {
    // Off ends every table here (D4), before the app stops answering its addresses.
    closeEveryRoom();
    stopTunnel();
    if (seatTimer) clearInterval(seatTimer);
    seatTimer = null;
    tellSeats(ctx);
  },
  uninstall() {
    stopTunnel();
  },
  configure(ctx) {
    setConfiguredAddress(ctx.settings.publicAddress);
  },
  async action(ctx, action) {
    if (action === "open") await openTunnel(ctx);
    else if (action === "close") stopTunnel();
  },
  status(ctx) {
    const tunnel = getTunnelStatus();
    // What switching off (or removing) would end, said by the one holder of the tables.
    const offEnds = roomsOpen() > 0 ? ENDS_THE_SESSION : null;
    if (!programReady(ctx.dir) && !tunnel.starting) {
      return { line: "On — friends on your network can join. The tunnel downloads cloudflared the first time you open it.", tone: "ok", running: false, offEnds };
    }
    if (tunnel.starting) return { line: "Opening…", tone: "busy", running: false, offEnds };
    if (tunnel.active) return { line: `Open at ${tunnel.url}`, tone: "ok", running: true, offEnds };
    if (tunnel.error) return { line: tunnel.error, tone: "warn", running: false, offEnds };
    return { line: "Ready — open it here or from Multiplayer when you host.", tone: "idle", running: false, offEnds };
  },
  async fetch(request, caller, ctx) {
    try {
      return await answer(request, caller, ctx);
    } finally {
      tellSeats(ctx);
    }
  },
  kickSeat({ scope, seat }) {
    const code = scope.split("/")[1] ?? "";
    return kickFromThisComputer(code, seat) === "ok";
  },
});
