# credential-lockbox-muse

Credential Lockbox as a GUI — a Muse Space that encrypts a credential in your browser to your Muse's age key, so only ciphertext ever reaches the chat.

This repository holds the app's source: the client (React/Vite), the server actions, and the data migrations.

It is not the whole product, and it does not stand alone. The keypair, the decryption and the protocol live in the core repository, [`credential-lockbox/credential-lockbox`](https://github.com/credential-lockbox/credential-lockbox); a working setup needs both — the core set up on the Muse's machine, and this app built from this source. On its own, the app has no key of its own to encrypt to, and nothing that can open what it produces.

Setting it up: [`SETUP.md`](SETUP.md) in this repository walks the user's Muse through it, on top of the core's own `SETUP.md`. Maintaining the published prototype: [`BUILDING.md`](BUILDING.md).

Status: prototype (proto-wizard-1.8). Credential Lockbox is a project of the credential-lockbox organization: https://github.com/credential-lockbox

License: MIT (see [LICENSE](LICENSE)).
