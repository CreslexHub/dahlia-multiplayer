import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/**
 * **cloudflared, fetched once and pinned.** A quick tunnel needs Cloudflare's tunnel program on this
 * computer. Nothing of it ships in the plugin (it is 40–55 MB per system, and the reader is told
 * before Install that it is downloaded the first time the tunnel opens); it is fetched from one
 * release of Cloudflare's, kept in the plugin's own `data/` folder, and started by the app only if
 * its SHA-256 is the one `plugin.json` pins for this computer (`programs`) — checked again by the app
 * at every start. A file with any other hash is thrown away here, and would never be started there.
 *
 * The pin replaces the Windows signature check the app made when this was compiled into it: that
 * accepted any build Cloudflare signed, the pin accepts exactly the one measured, on every system.
 */

/** The release every pin below and in `plugin.json` was measured from (2026-11-05). */
export const CLOUDFLARED_VERSION = "2026.10.7";
const RELEASES = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/`;

/**
 * What to fetch for each system the app runs on (`process.platform-process.arch`): the release's
 * file and its SHA-256 as fetched (GitHub's digest, measured again). macOS's is a `.tgz` holding
 * the program; the others are the program. Windows on ARM runs the x64 build, which is all
 * Cloudflare publishes for Windows.
 */
const ASSETS: Record<string, { file: string; sha256: string; archive: boolean }> = {
  "win32-x64": { file: "cloudflared-windows-amd64.exe", sha256: "2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343", archive: false },
  "win32-arm64": { file: "cloudflared-windows-amd64.exe", sha256: "2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343", archive: false },
  "linux-x64": { file: "cloudflared-linux-amd64", sha256: "1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872", archive: false },
  "linux-arm64": { file: "cloudflared-linux-arm64", sha256: "3df43aedc9ff291d1735b5cb576cb97e0b157488796db2e32b28aecabb445775", archive: false },
  "darwin-x64": { file: "cloudflared-darwin-amd64.tgz", sha256: "02f3edfd87684dd5b705607688e4eb4b323f6e777b81e7b3a85af556aa356848", archive: true },
  "darwin-arm64": { file: "cloudflared-darwin-arm64.tgz", sha256: "3586ccf397e98e5f437e60e7c307ca6ac463e110580503af8bb8e6f9ebf831bd", archive: true },
};

/** How long the whole download may take, and the most it may be (cloudflared is ~55 MB on Windows). */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
/** A tar record. */
const TAR_BLOCK = 512;

export function thisPlatform(): string {
  return `${process.platform}-${process.arch}`;
}

/** The program's path inside the plugin's folder, as `plugin.json` pins it. */
export function programFile(): string {
  return `data/${process.platform === "win32" ? "cloudflared.exe" : "cloudflared"}`;
}

const sha256 = (bytes: Uint8Array) => crypto.createHash("sha256").update(bytes).digest("hex");

/** The program's pin for this computer, read from the plugin's own `plugin.json` — the one list of pins. */
function pinnedHash(dir: string): string | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "plugin.json"), "utf8")) as { programs?: { file: string; platform: string; sha256: string }[] };
    return manifest.programs?.find((p) => p.file === programFile() && p.platform === thisPlatform())?.sha256 ?? null;
  } catch {
    return null;
  }
}

/** Whether the program is in place and is the pinned one. */
export function programReady(dir: string): boolean {
  const pin = pinnedHash(dir);
  try {
    return pin !== null && sha256(fs.readFileSync(path.join(dir, programFile()))) === pin;
  } catch {
    return false;
  }
}

/** The one file a `.tgz` holds by `name` (a bare `ustar` archive, as Cloudflare's macOS release is). */
export function fileFromTgz(tgz: Uint8Array, name: string): Uint8Array | null {
  const tar = zlib.gunzipSync(tgz);
  let at = 0;
  while (at + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(at, at + TAR_BLOCK);
    if (header.every((b) => b === 0)) return null;
    const entry = header.subarray(0, 100).toString("utf8").split("\0")[0];
    const size = parseInt(header.subarray(124, 136).toString("utf8").split("\0")[0].trim() || "0", 8);
    const body = at + TAR_BLOCK;
    if (entry.replace(/^\.\//, "") === name) return tar.subarray(body, body + size);
    at = body + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
  return null;
}

/** The answer's body, refused once it passes `MAX_DOWNLOAD_BYTES` — never held whole before it is measured. */
async function readCapped(res: Response): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) throw new TooLarge();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_DOWNLOAD_BYTES) {
      await reader.cancel();
      throw new TooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

class TooLarge extends Error {}

/**
 * **Fetch cloudflared into `data/`, or say in a sentence why not.** Kept only when it is the pinned
 * program; written through a `.part` file, so a cut-off download is never mistaken for the program.
 */
export async function fetchCloudflared(dir: string, log: (line: string) => void): Promise<void> {
  const asset = ASSETS[thisPlatform()];
  if (!asset) throw new Error(`Cloudflare publishes no cloudflared for this system (${thisPlatform()}).`);
  const pin = pinnedHash(dir);
  if (!pin) throw new Error(`This version of Multiplayer pins no cloudflared for this system (${thisPlatform()}).`);
  log(`downloading ${asset.file} (cloudflared ${CLOUDFLARED_VERSION})`);
  let res: Response;
  try {
    res = await fetch(RELEASES + asset.file, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch {
    throw new Error("Couldn't reach GitHub to download cloudflared. Check this computer's internet connection and try again.");
  }
  if (!res.ok || !res.body) throw new Error(`GitHub answered ${res.status} for cloudflared's download. Try again later.`);
  let fetched: Uint8Array;
  try {
    fetched = await readCapped(res);
  } catch (err) {
    if (err instanceof TooLarge) {
      throw new Error(`The cloudflared download was larger than ${MAX_DOWNLOAD_BYTES / (1024 * 1024)} MB, which it never is, so it was thrown away.`);
    }
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new Error(
      timedOut
        ? `The cloudflared download did not finish within ${DOWNLOAD_TIMEOUT_MS / 60_000} minutes. Try again.`
        : `The cloudflared download failed (${(err as Error).message}). Try again.`
    );
  }
  if (sha256(fetched) !== asset.sha256) throw new Error("The cloudflared download is not the file Multiplayer pins (its SHA-256 differs), so it was thrown away.");
  const program = asset.archive ? fileFromTgz(fetched, "cloudflared") : fetched;
  if (!program) throw new Error("The cloudflared download could not be unpacked.");
  if (sha256(program) !== pin) throw new Error("The cloudflared program is not the one Multiplayer pins (its SHA-256 differs), so it was thrown away.");
  const target = path.join(dir, programFile());
  const part = `${target}.part`;
  fs.writeFileSync(part, program, { mode: 0o755 });
  fs.renameSync(part, target);
  log(`cloudflared saved (${Math.round(program.byteLength / (1024 * 1024))} MB)`);
}
