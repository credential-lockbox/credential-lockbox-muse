# Building and maintaining this Space

This document is for maintainers of the published prototype Space. It isn't install instructions.

**Installing Credential Lockbox on your Muse?** The install guide, [`SETUP.md`](SETUP.md), is the path: it has your Muse build this source as a new Space of its own, through its own artifact tools. The maintenance steps below are about the published prototype. The facts about how a Space is built and how its data is handled apply to any Space built from this source, an installed one included.

## What's here

This source is a web artifact: a TypeScript Space.

- `client/`: the React client.
- `server/src/actions.ts`: the server actions.
- `server/src/schema.ts`: the schema.
- `drizzle/`: the Drizzle SQL migrations.
- `space.json`: the runtime and the slug.

## How a Space is built and shipped

- **The builder's web-artifact tools are the only way a Space is built, audited and shipped.** `bun run build` isn't run in a Space's workspace: it publishes nothing, and only the builder's tools do.
- **The built bundle isn't edited by hand** (`~/workspace/ts-spaces/<slug>/.space-build/` in the Space's workspace). Hand edits publish nothing either.
- **A change to the live prototype goes through its owner's Muse.** The Muse finds the Space among its existing artifacts (the slug is in `space.json`; an owner may have more than one Credential Lockbox Space) and requests the change by describing the edit. That starts a builder to make it.
- **This repository's source changes in a pull request** (new with this document), so it stays the record of what the Space is built from.
- **The maintainer's sign-off.** main's ruleset requires one approving review from an account with write access that didn't make the last push, and dismisses it when new commits are pushed. The maintainer also applies `QA Approved`, and the `QA Gate` status (`.github/workflows/qa-gate.yml`) turns green only when the maintainer's account applied it last, after the PR's last force-push or reopen. A push, open or reopen removes `QA Approved`, since that commit hasn't been approved. `QA Gate` holds back a merge only once it's a required check in main's ruleset; until then it's a signal. While the QA sessions act under the maintainer's account, neither check can tell their approval from the maintainer's.
- **A source export that reaches GitHub under the maintainer's account is pushed by the Dev bot instead,** cherry-picked onto a branch of its own. That way the maintainer isn't the last pusher, and can approve it.

## A Space's data

A Space's data lives in `~/workspace/ts-spaces/<slug>/app.db` in its workspace, and the app manages it. Records are read and changed through the artifact tools, as the Muse's own Artifacts instructions describe. `sqlite` and scripts are never run against `app.db`.

## Where this came from

This file was the Space's `AGENTS.md`, the platform's instructions to the builder in the live Space's tree. In this repository it's renamed and rewritten for maintainers: agents read a root `AGENTS.md` as standing orders, and its "don't build from this directory" contradicted the install path. Source imported from the live Space's tree leaves its `AGENTS.md` out.
