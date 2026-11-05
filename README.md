# Dahlia Multiplayer

The Multiplayer plugin for Dahlia: play one story together. A host opens a table, friends join by link, and everyone at the table writes the story with the host's models.

It's a plugin like any other. Install it from Profile → Plugins, and switch it off to remove every trace of it from the app.

## Status

This repository is being set up. Multiplayer is moving out of the app onto Dahlia's public plugin API. Its source will be published here once it builds from this repository alone, against `@dahlia/plugin-api` and nothing else.

## What it will be able to do on your computer

Multiplayer is a **full-access** plugin. Dahlia shows these points before you install it:

- it can read and change your chats and cards
- it serves a page your guests open, on your network or through a tunnel
- it can download and run Cloudflare's `cloudflared` to make a public address, but only the exact program its manifest pins

It can never read your API keys. Plugin server code runs in a separate process that can reach only its own folder, and no part of Dahlia ever hands a key to a page.
