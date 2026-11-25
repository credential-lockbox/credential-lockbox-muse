# Building and maintaining this Space

This document is for maintainers of the published prototype Space. It isn't install instructions.

**Installing Credential Lockbox on your Muse?** Follow the install guide (`SETUP.md`, coming to this repository) instead. It has your Muse build this source as a new Space of its own, through its own artifact tools. Nothing below applies to an install.

## What's here

This source is a web artifact: a TypeScript Space.

- `client/`: the React client.
- `server/src/actions.ts`: the server actions.
- `server/src/schema.ts`: the schema.
- `drizzle/`: the Drizzle SQL migrations.
- `space.json`: the runtime and the slug.

## How the published Space is built and shipped

- **Only through the platform's web-artifact tools.** The Space is built, audited and shipped by its builder through the platform's web-artifact tools. Running `bun run build` doesn't publish it.
- **Never hand-edit the built bundle** (`~/workspace/ts-spaces/<slug>/.space-build/` in the Space's workspace). Hand edits don't publish either.
- **To change the live Space,** describe the edit to its owner's Muse. That starts a builder to make the change. Change this repository's source in a pull request, so it stays the record of what the Space is built from.

## The Space's data

The Space's data lives in `~/workspace/ts-spaces/<slug>/app.db` in the Space's workspace, and the app manages it. Read or change records through the platform's artifact tools, never with `sqlite` or scripts run against `app.db`.

## Where this came from

This file was the Space's `AGENTS.md`, the platform's instructions to the builder in the live Space's own tree, where it stays. In this repository it's renamed and rewritten for maintainers: a root `AGENTS.md` is read by visiting agents as standing orders, and its "don't build from this directory" contradicted the install path.
