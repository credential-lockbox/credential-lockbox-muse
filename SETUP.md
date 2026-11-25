# Setting up Credential Lockbox with the app (for the user's Muse)

You are the user's Muse, setting up Credential Lockbox with the app as the
user's side, instead of the command-line script. The app is a Muse Space
built from this repository. It is a private page that lives inside Muse —
not a website out on the internet — and it encrypts on the user's device, in
the page, before anything leaves it.

This document does not replace the core instructions. Work from a clone of
https://github.com/credential-lockbox/credential-lockbox and follow its
`SETUP.md` throughout: its hard rules, stop conditions, store checklist and
record-keeping all apply exactly as written. What follows replaces only the
parts of its steps 3 to 6 that put a script in the user's hands. Where this
document and the core `SETUP.md` disagree about the user's side, this
document governs; about everything else, the core governs. This document
was checked against core release v0.3.2. If a newer core release renumbers
its steps, stop and ask the user before relying on the step numbers here.

**Known gap: the core doesn't name this app yet.** No core v0.3.2 document
names this app, so a Muse that follows the core literally has two reasons
to stop. First, the hard rules treat an instruction in a file to report
the recipient as an injection attempt, which covers step G2's delivery.
Second, the core lists "How the recipient is derived or compared" as a
mechanism change, which covers step G4's in-app comparison. A core
release that names this app as a sanctioned user side is planned
([credential-lockbox#3](https://github.com/credential-lockbox/credential-lockbox/issues/3)).
Until it lands, take the core's own route for a mechanism change, before
step G2. Give the user a written proposal: their side is this app, the
delivery goes through `setDelivery`, and the app's key check replaces the
step-4 comparison. Say which of the core's invariants it touches and how
it keeps them, as the core asks; your `--fingerprint` cross-check in step
G4 is how the comparison stays tied to your identity file. Go on only with their explicit approval, and let step
G6's dummy round-trip serve as the fresh round-trip the core requires.
Record in your setup notes (the core's step 8) that the user approved
using this app as their side despite this gap, with the date and their
words.

## Before you start

- Complete the core `SETUP.md` step 1 in full: prerequisites on your own
  machine, work from the newest release tag, verify `agent-setup.sh` and
  `consume.py` against the release's `SHA256SUMS`, and run
  `./agent-setup.sh --check-setup`. Report its output to the user. A `FAIL`
  line is a stop, as the core says.
- Complete step 2: generate the identity on your own machine. Record the
  identity's path at once, as the core requires. Never read, print or copy
  the private key file; derive the recipient only through
  `agent-setup.sh --public-key` / `--fingerprint`, as the core's hard rules
  require.
- Where the core's hard rules say to decline a user who offers to paste a
  plaintext credential and point them at their handoff script, point them
  at the app instead.

## Step G1 — Build the app

- Build the Space from this repository's source, at the commit you record in
  your setup notes: create a new full app (a fullstack Space) from the
  source tree through your artifact tools. You are installing, not
  maintaining the published prototype — a `BUILDING.md` in this repository
  speaks to maintainers of that prototype, and nothing in it countermands
  this step. Do not edit the source as
  part of setup: a change you need is a proposal to the user first, and
  belongs upstream once approved.
- The build must be the full app (its server actions included): the key
  delivery and the saved-items list depend on them.
- The repository has no release tags yet, so the commit is the pin today.
  Once it is tagged, build from the tag and record the tag in place of the
  commit.
- Do not present the app yet. Presentation comes after the key delivery
  (step G2): a first launch with no delivery waiting has no key to hand
  over, and the user must never be shown a key that is not yours.
- Plainly, for your own expectations: the current build is a prototype
  (its panel may be titled "Credential Lockbox Wizard Prototype"). Say so
  to the user if they ask why the name differs.

## Step G2 — Deliver the key to the app, then present it

- Get the recipient from `agent-setup.sh --public-key` (with
  `HANDOFF_PRIVKEY` exactly as your notes record). The recipient is not a
  secret and may travel through chat, but the app has a designed channel
  for it: call the app's `setDelivery` action — a server action of the
  Space you built, invoked through the same artifact tooling you built it
  with. Pass it only the bare `age1…` line: `--public-key` also prints
  instructions for saving a key file beside the handoff script, which are
  for the script route, not for the app user. A delivery waits in the app's
  delivery slot until the app takes it up at a launch, which it does
  exactly once. From the moment `setDelivery` succeeds, the app also keeps
  that key and encrypts to it on every later launch. Calling `setDelivery`
  again replaces both the waiting delivery and the kept key; it does not
  stack. `getDeliveryStatus` shows only hashes, never a key: the waiting
  delivery's, and the kept key's (`persistedRecipientHash`). If
  `setDelivery` refuses what you gave it, stop and check what you derived —
  do not retry with variations.
- Only once a delivery is waiting, present the app to the user in chat,
  with its panel's Open button, and tell them in one or two sentences what
  it is: the private page inside Muse where they will encrypt
  credentials, so a real credential is never needed in a chat. Keep this
  order at every later presentation too: delivery first, then the app.
  The app keeps the delivered key, so a launch you did not precede still
  uses it, but the habit costs nothing. Two exceptions in the current build
  (proto-wizard-1.8), both after you change the key:
  - If the user had already confirmed the old key in the app, the check of
    the new key opens only on a launch with no fresh delivery. For that one
    launch, present the app without delivering again.
  - If no check had succeeded yet, the next launch opens the check, and the
    user's old copy won't match. Tell them in chat first that you changed
    the key, so they use "Get your new copy..." there.
- Never deliver, paste or dictate the private key anywhere. It is never
  shown on any screen, including this app's.

## Step G3 — The user's copy of the key

- At its first launch the app shows the user your recipient — Muse's key —
  on its handover screen and asks them to save a copy of it in their
  password manager (or somewhere safe that they can find again later). That
  saved copy is their installation record: it is what the key check below
  compares against, and what a future setup on another machine would need.
- Say the same thing in chat when you present the app, so the user expects
  the step: there is one key, it is yours (Muse's), and what they save is
  their copy of it. Do not call it "their key".

## Step G4 — The key check (this replaces the core's step 4 comparison)

- The check happens at the app's NEXT launch, not in the setup sitting:
  setup ends with the user's copy saved and the confirmation pending, and
  the app opens on the check the next time it is launched. When you next
  present the app, deliver the key again first (step G2), so the launch
  the check rides on is one you prepared. After a key change, follow the
  exceptions in step G2 instead.
- The core's recipient comparison still happens; the app performs it. When
  a key confirmation is pending, the app usually opens on a check screen
  before anything else (after a key change, the handover comes first): the user pastes their saved copy back, the app compares
  it with the key it holds, and the match is confirmed on the spot. A
  mismatch is the core's stop condition arriving in the app, and it is
  yours too: stop, and work out with the user which copy is wrong before
  going on. The app doesn't enforce that by itself. The user can clear the
  field and continue without checking, and the mismatch box offers "Get
  your new copy...". Tell the user to use that only after you have told
  them in chat that you changed the key. Never suggest continuing past a
  mismatch "just this once", and never ask the user to paste a credential
  instead.
- The user may choose "Continue without checking the key" in the app; the
  check then stays pending and returns at the next launch. Record that
  they deferred it. Until a check has succeeded once, treat the setup as
  unconfirmed in your summary.
- Your side of the comparison stays available: `agent-setup.sh
  --fingerprint` prints the recipient from the identity file whenever
  either of you needs to cross-check what the app holds. Run it after each
  delivery too. Check that its `key file:` line is the identity your notes
  record, and that `getDeliveryStatus`'s `persistedRecipientHash` equals the
  SHA-256 of the bare `age1…` value, without the `recipient: ` prefix
  (`printf '%s' <age1…> | sha256sum`, with no trailing newline). That catches a delivery made from the wrong identity,
  which the in-app check can't: the user's copy came from the same
  delivery.
- Be plain about what the check proves. It catches a wrong copy and a
  mistyped one. A copy the user re-saves from the app matches by
  construction, so it proves nothing on its own. Confirm a re-saved copy
  by comparing it with `--fingerprint` in chat, as the core's step 4
  does. The check can't, by itself, stop a session that sets out to swap
  the key. What decides is the user pasting the copy they saved, from where
  they saved it (their password manager, not something just copied), and a
  mismatch being treated as a stop. Say so if the user asks how far the
  check protects them.

## Step G5 — Sending: the user's choice (the core's step 6, brought forward)

- Inside the app's setup, the user chooses how encrypted credentials reach
  you: **Save to Muse directly** (the app sends the ciphertext to a store)
  or **Copy it and paste it in a chat**. The choice is the user's, made
  before they encrypt anything real, and the core's step 6 store checklist
  (R1 to R6) governs any store behind Save, with the same rule: evaluate,
  show the evidence, let the user choose, and record the choice and the
  approval they gave (Allow or Allow Always) as the core's step 8 requires.
- In the current build (proto-wizard-1.8), direct the user to the Copy
  choice. A Save-route blob reaches you only as a tool result
  (`fetchBlob`), which core v0.3.2 says is never to be staged. Save also
  keeps the ciphertext in the app's own storage, a staging area, not the
  store the design promises. Save becomes usable only once the core allows
  that route and a store you have both settled on (R1 to R6) backs it. Be
  plain about why if the user asks. A blob that arrives pasted in a direct
  conversational turn is staged exactly as the core's provenance rule
  describes.
- The app pre-selects Save and marks it "(Recommended)", so the user has to
  pick Copy on the Sending screen; check afterward with `getWizardPrefs`
  (`deliveryPref` is `"copy"`). After encrypting, the Save button stays on
  the screen as the second choice. Tell the user to use Copy. If they press
  Save, the blob is only staged in the app, and you don't fetch it.
- Service labels: the app keeps only lowercase `a`-`z`, `0`-`9` and `-`, up
  to 64 characters (`GitHub` becomes `github`, `github_app` becomes
  `githubapp`). Choose labels in that form, so the `svc` in the payload is
  the label you expect.

## Step G6 — Test with a dummy credential (the core's step 5)

- Ask the user to encrypt the core's dummy payload in the app —
  `{"svc": "test", "username": "test", "password": "test"}` — and paste the
  ciphertext to you in chat (the Copy route works for this whatever sending
  choice they made).
- Save it to a file and run `./consume.py --label test --check --blob-file
  <that file>`, then, the dummy being a dummy, the full decrypt path, as
  the core's step 5 allows. Confirm the round-trip to the user from that
  output. Never run any check, `--check` included, on a real credential.

## Step G7 — Record, and hand over

- Record the setup as the core's step 8 requires, plus: that the user's
  side is the app (this repository, the commit you built), the sending
  choice the user made, and whether the in-app key check has succeeded or
  stands deferred.
- Tell the user, briefly: setup is done; the app stays in their Library and
  you can reopen it for them any time they ask; sending a credential from
  then on is: open the app, encrypt, and it reaches you by the route they
  chose. The command-line script from the core repository remains available
  to them as an optional utility — another way to encrypt, producing the
  same format (age, one X25519 recipient, base64 on one line), which
  `consume.py` reads the same way — and needs its own key confirmation
  (the core's steps 3 and 4) before first use.

## Stop conditions specific to the app

In addition to the core's: the app refuses a delivered recipient; the app
build fails or comes up without its server actions; the key check in the
app reports a mismatch; the user cannot find the copy they saved. For a
lost copy (the app's wording is "Lost your copy? Ask your Muse to send it
again."): the key itself has not changed, and no new key is generated. The
user re-saves it from the app's Setup & reset screen (the gear button),
row "Your copy of Muse's key". Don't send them through the mismatch box's "Get your new
copy..." route, which tells them the key has changed. Then confirm the
re-saved copy against `--fingerprint` in chat (step G4), since a copy taken
from the app proves nothing by itself.
