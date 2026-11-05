# Dahlia Multiplayer

The Multiplayer plugin for Dahlia: play one story together. A host opens a table, friends join by link, and everyone at the table writes the story with the host's models.

It's a plugin like any other. Install it from **Profile → Plugins → Install from GitHub** with `CreslexHub/dahlia-multiplayer`, and switch it off to remove every trace of it from the app.

## What it does

- **Host a table** from any story. Friends on your own network join with a room code while Network → Open to your network is on.
- **Invite from anywhere** through Cloudflare's free quick tunnel, opened from the lobby or the plugin's card. The tunnel's program is downloaded the first time you open it.
- **Join somebody else's table** from their invite link. A guest needs nothing installed: the host's Dahlia serves the join page and this plugin's client half to them.
- Seats, turns, table talk, typing, guest rights, and Kick, from the lobby or from your Network screen.

## What it can do on your computer

Multiplayer is a **full-access** plugin. Dahlia shows these points before you install it:

- it can read and change your chats and cards
- it serves a page your guests open, on your network or through a tunnel
- it can download and run Cloudflare's `cloudflared` to make a public address, but only the exact program its manifest pins

It can never read your API keys. Plugin server code runs in a separate process that can reach only its own folder, and no part of Dahlia ever hands a key to a page.

**cloudflared is pinned.** `plugin.json` lists one file per system (`programs`), each at the SHA-256 of Cloudflare's release `2026.10.7`. The plugin fetches that release into its own `data/` folder and keeps it only if it is exactly that file; Dahlia starts it only if it still is, at every start. Updating cloudflared is a new version of this plugin, with the new hashes measured and written into `plugin.json` and `server/cloudflared.ts`.

## Settings

- **Open the tunnel when Dahlia AI starts.** Off by default: the public address exists only while you're inviting someone.
- **Permanent public address.** Your own domain that reaches your computer, if you have one. Guests are invited there and no tunnel is opened.

## Building

It builds against [`@dahlia/plugin-api`](https://github.com/CreslexHub) and nothing else — no Dahlia source. The SDK is vendored in `vendor/` until it is published.

```sh
npm ci
npm run typecheck
npm run build        # dist/plugin.zip, readable
npm run release      # dist/plugin.zip, minified
```

`dist/plugin.zip` is what Dahlia's **Install from file** takes. Pushing a tag `vX.Y.Z` (the version in `plugin.json`) builds it and attaches it to a GitHub release, which is what **Install from GitHub** fetches.

Inside a checkout of Dahlia, this repository is the submodule `plugins/multiplayer`: the app's tests build it with the SDK and install it through the real loader. `npm run vendor-api` there packs the app's current SDK into `vendor/`.

## Layout

| | |
|---|---|
| `plugin.json` | the manifest: permissions, settings, the tunnel's actions, mounts, the join page, pinned programs |
| `src/client.tsx`, `src/server.ts` | the two halves' entries |
| `client/`, `components/` | the client half: the room store, the wire, the story relay, the lobby, the join page |
| `server/` | the server half: rooms and the relay (`http.ts`), the tunnel, cloudflared |
| `shared/protocol.ts` | the wire's vocabulary, read by both halves |
| `mount.ts` | names and numbers both halves read |

An app or phone app from before Multiplayer moved out cannot join a host from after it, nor the reverse: the relay's address moved to `/api/plugins/multiplayer-tunnel/public/room/…`.
