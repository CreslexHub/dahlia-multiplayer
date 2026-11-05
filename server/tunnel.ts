import { publicBaseUrl, publicUrlIsPermanent, setPublicBaseUrl } from "./public-url";

/**
 * **The quick tunnel**: cloudflared, started by the app on this plugin's behalf, giving a table a
 * public `https://…trycloudflare.com` address.
 *
 * The plugin's server half runs walled (no child processes), so it never starts cloudflared itself:
 * it asks the app to (`ctx.run`), and the app starts only the file this plugin's manifest pins for
 * this computer, at its pinned SHA-256, checked at every start (`plugin.json` → `programs`). It reads
 * the tunnel's address off cloudflared's own metrics server, which cloudflared says it opened on its
 * output, and the app holds its port open on the loopback while the tunnel is up (`holdLoopback`),
 * because cloudflared reaches the server at 127.0.0.1.
 */

/** cloudflared names its metrics server in a line of its output. */
const METRICS_AT = /metrics server on (127\.0\.0\.1:\d{1,5})\//i;
/** How often the metrics server is asked for the quick tunnel's address while it has none. */
export const QUICK_TUNNEL_POLL_MS = 500;
/** How long one ask of the metrics server may take. */
const QUICK_TUNNEL_ASK_MS = 2_000;
/** What of cloudflared's output is kept to find the metrics line in. */
const HEARD_KEPT_CHARS = 4096;
/** How long opening waits for an address before saying it timed out. */
const TUNNEL_ADDRESS_WAIT_MS = 25_000;

export function metricsAddress(text: string): string | null {
  return METRICS_AT.exec(text)?.[1] ?? null;
}

/** The quick tunnel's `https://` address from the metrics server's `/quicktunnel` answer, or null. */
export function quickTunnelAddress(answer: unknown): string | null {
  const hostname = (answer as { hostname?: unknown } | null)?.hostname;
  if (typeof hostname !== "string") return null;
  const name = hostname.trim().toLowerCase();
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(name) ? `https://${name}` : null;
}

async function askQuickTunnel(metrics: string): Promise<string | null> {
  try {
    const res = await fetch(`http://${metrics}/quicktunnel`, { signal: AbortSignal.timeout(QUICK_TUNNEL_ASK_MS) });
    return res.ok ? quickTunnelAddress(await res.json()) : null;
  } catch {
    return null;
  }
}

export interface TunnelStatus {
  active: boolean;
  starting: boolean;
  url: string;
  error: string | null;
  permanent: boolean;
}

/** What the tunnel needs of the app: the plugin's context's own services. */
export type TunnelHost = {
  run(file: string, args: string[], onOutput: (stream: "stdout" | "stderr", text: string) => void, onExit: (code: number | null) => void): Promise<{ run: string }>;
  kill(run: string): Promise<void>;
  serverPort(): Promise<number | null>;
  holdLoopback(): Promise<void>;
  releaseLoopback(): Promise<void>;
};

type Holder = {
  /** Which press of Open this is: a Stop, or the next Open, makes every earlier one moot. */
  attempt: number;
  run: string | null;
  pending: Promise<TunnelStatus> | null;
  starting: boolean;
  error: string | null;
  url: string;
  host: TunnelHost | null;
};

const holder: Holder = { attempt: 0, run: null, pending: null, starting: false, error: null, url: "", host: null };

export function getTunnelStatus(): TunnelStatus {
  return {
    active: holder.run !== null && Boolean(publicBaseUrl()),
    starting: holder.starting,
    url: publicBaseUrl(),
    error: holder.error,
    permanent: publicUrlIsPermanent(),
  };
}

/** Close the tunnel: the program stopped, the address withdrawn, the port let go. */
export function stopTunnel(): TunnelStatus {
  const { run, host } = holder;
  holder.attempt++;
  holder.starting = false;
  holder.error = null;
  holder.pending = null;
  holder.run = null;
  if (run && host) void host.kill(run).catch(() => undefined);
  withdraw();
  return getTunnelStatus();
}

function withdraw(): void {
  if (holder.url) setPublicBaseUrl("");
  holder.url = "";
  if (holder.host) void holder.host.releaseLoopback().catch(() => undefined);
}

/**
 * **Open the tunnel** with the program at `file` (a path inside the plugin's folder, pinned in its
 * manifest), answering once it has an address, failed, or timed out.
 */
export async function startTunnel(host: TunnelHost, file: string): Promise<TunnelStatus> {
  if (holder.run && publicBaseUrl()) return getTunnelStatus();
  if (publicUrlIsPermanent()) {
    holder.error = "A permanent public address is set in Multiplayer's settings, so guests use that; no tunnel was opened.";
    return getTunnelStatus();
  }
  if (holder.pending) return holder.pending;
  stopTunnel();
  holder.host = host;
  holder.starting = true;
  holder.error = null;
  const attempt = holder.attempt;
  const started = (async () => {
    try {
      await host.holdLoopback();
      const port = await host.serverPort();
      // Stopped while the port was being held: the press is answered as things stand now.
      if (holder.attempt !== attempt) return getTunnelStatus();
      if (port === null) throw new Error("this computer's server has not answered anything yet");
      return await cloudflaredOnto(host, file, port, attempt);
    } catch (err) {
      holder.starting = false;
      holder.error = `The tunnel could not be opened: ${(err as Error).message}`;
      withdraw();
      return getTunnelStatus();
    }
  })();
  holder.pending = started;
  void started.then(() => {
    if (holder.pending === started) holder.pending = null;
  });
  return started;
}

function cloudflaredOnto(host: TunnelHost, file: string, port: number, attempt: number): Promise<TunnelStatus> {
  return new Promise<TunnelStatus>((resolve) => {
    let resolved = false;
    let mine: string | null = null;
    const current = () => mine !== null && holder.run === mine;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      resolve(getTunnelStatus());
    };
    const timeout = setTimeout(() => {
      if (current()) {
        holder.starting = false;
        if (!publicBaseUrl()) holder.error = "Tunnel timed out while waiting for public URL.";
      }
      finish();
    }, TUNNEL_ADDRESS_WAIT_MS);
    const ask = async (metrics: string) => {
      while (current() && !holder.url) {
        const url = await askQuickTunnel(metrics);
        if (url && current() && !holder.url) {
          holder.url = url;
          setPublicBaseUrl(url);
          holder.starting = false;
          holder.error = null;
          finish();
          return;
        }
        await new Promise((wait) => setTimeout(wait, QUICK_TUNNEL_POLL_MS));
      }
    };
    let heard = "";
    let metrics: string | null = null;
    const onOutput = (_stream: "stdout" | "stderr", text: string) => {
      if (metrics || !current()) return;
      heard = (heard + text).slice(-HEARD_KEPT_CHARS);
      metrics = metricsAddress(heard);
      if (metrics) void ask(metrics);
    };
    const onExit = (code: number | null) => {
      if (current()) {
        holder.run = null;
        holder.starting = false;
        withdraw();
        if (code !== 0 && !holder.error) holder.error = `Tunnel process exited with code ${code}.`;
      }
      finish();
    };
    host.run(file, ["tunnel", "--url", `http://127.0.0.1:${port}`, "--metrics", "127.0.0.1:0"], onOutput, onExit).then(
      ({ run }) => {
        if (holder.attempt !== attempt) {
          // Stopped while it started: it goes, and the press that opened it is answered now.
          void host.kill(run).catch(() => undefined);
          finish();
          return;
        }
        mine = run;
        holder.run = run;
      },
      (err: Error) => {
        holder.starting = false;
        holder.error = err.message;
        withdraw();
        finish();
      }
    );
  });
}
