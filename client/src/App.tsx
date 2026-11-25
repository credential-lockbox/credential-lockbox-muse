// Credential Lockbox — Wizard Prototype (proto-wizard-1.7).
//
// Two wizards:
//   SETUP — Introduction → Your copy of the key → Sending to Muse
//     (three steps). Runs on first launch, when the Setup flow itself
//     has changed since the user last completed it (a setupVersion
//     change), or one screen at a time from the Setup & reset hub.
//     The key check is NOT a Setup step: completing a handover sets a
//     confirmation-pending flag, and the NEXT launch opens on the key
//     check as a gate before Encrypt Step 1; a match there clears the
//     flag and pins the key. About the key and Other ways to encrypt
//     are reference screens, not steps: they open as secondary screens
//     (from the key handover and the hub) and close back to the
//     invoking screen.
//   ENCRYPT — Step 1 Service & type → Step 2 Details → Step 3 Review &
//     encrypt → Step 4 Delivery (Save there jumps to the Receipt
//     screen). When setup is complete and current, the app lands here
//     directly.
//
// Muse's key reaches the page through the Delivery Slot: a one-shot
// server-side record Muse writes before presenting the page. At
// launch the app consumes it — a delivered key whose hash differs from
// an existing confirmed pin is a key change (this sitting shows the
// handover and sets confirmation pending); with no pin yet, a delivered
// key is not a change, and a pending confirmation opens the key check
// as a gate instead. A delivered service label pre-fills Encrypt
// Step 1. The delivered recipient is also persisted
// server-side, so on later launches the consume path returns the
// persisted key: the app encrypts to the delivered key every time.
// There is NO built-in fallback recipient — when no key has ever been
// delivered, the app shows a waiting state and cannot encrypt.
//
// Encryption happens entirely in this page with the bundled
// `age-encryption` 0.3.1 (typage) library: one X25519 recipient, binary
// format, base64 on a single line. The only thing any server action ever
// receives is the finished ciphertext blob — plaintext never leaves the
// device.

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim, bytesToBase64 } from "@hatch/space-sdk/client";
import { actionFields } from "@hatch/space-sdk/fields" with { type: "macro" };
import type { Actions } from "../../server/src/actions";
import { Encrypter } from "age-encryption";
import { api } from "./api";
import lockboxIconUrl from "./assets/credential-lockbox-icon.png";

const FIELDS = actionFields<typeof Actions>();

/** This build's fingerprint (the provenance line's version). Bumped
 * whenever the shipped page changes. A fingerprint change by itself no
 * longer re-runs Setup or the key check — that trigger is the Setup
 * flow's own version (setupVersion, held in the release info). */
const BUILD_FINGERPRINT = "proto-wizard-1.7";

/** Short build hash shown on the provenance line's second line: the
 * first 8 hex characters of the SHA-256 of the build fingerprint,
 * computed at build time. */
const BUILD_HASH = "a0a1fc6f";

/** Fallback for the release info's setupVersion before it loads (and
 * for an install whose release info predates the field). */
const FALLBACK_SETUP_VERSION = "2";

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

type CredType = "userpass" | "apikey" | "token" | "pem";

const TYPE_OPTIONS: { value: CredType; label: string; hint: string }[] = [
  { value: "userpass", label: "Username & password", hint: "A login for a website or service" },
  { value: "apikey", label: "API key", hint: "A key ID and secret from a developer console" },
  { value: "token", label: "Token", hint: "A token ID and secret, such as a bot or access token" },
  { value: "pem", label: "Private key (PEM)", hint: "A .pem key file, such as a GitHub App key" },
];

type FieldDef = {
  key: string;
  label: string;
  secret: boolean;
  optional?: boolean;
  /** Included in the payload (and the preview) even when empty — an
   * empty password is a fact about the credential, not an absence. */
  includeEmpty?: boolean;
  multiline?: boolean;
  /** Input cap in characters, enforced as the user types or pastes. */
  cap: number;
  hint?: string;
};

const FIELD_DEFS: Record<CredType, FieldDef[]> = {
  userpass: [
    { key: "username", label: "Username", secret: false, cap: 256 },
    { key: "password", label: "Password", secret: true, optional: true, includeEmpty: true, cap: 1024 },
  ],
  apikey: [
    { key: "api_key_id", label: "API key ID", secret: false, optional: true, cap: 256 },
    {
      key: "api_key_secret",
      label: "API key secret",
      secret: true,
      cap: 2048,
      hint: "If your service gave you a single key, it goes here.",
    },
  ],
  token: [
    { key: "token_id", label: "Token ID", secret: false, optional: true, cap: 256 },
    {
      key: "token_secret",
      label: "Token secret",
      secret: true,
      cap: 2048,
      hint: "If your service gave you a single key, it goes here.",
    },
  ],
  pem: [{ key: "private_key", label: "Private key (PEM)", secret: true, multiline: true, cap: 16384 }],
};

const SERVICE_CAP = 64;

/** The Setup wizard's screens. The linear flow is three steps —
 * Introduction → Your copy of the key → Sending to Muse. The key
 * check is not a step: it appears as the launch gate (in flow mode,
 * outside SETUP_ORDER, so it carries no step eyebrow) and as a hub
 * screen in single mode. "about" and "other" are reference screens,
 * never flow steps: they open in single mode (from the key handover
 * and the hub) and close back to the invoking screen. */
type SetupStepId = "intro" | "key" | "about" | "keycheck" | "sending" | "other";
const SETUP_ORDER: SetupStepId[] = ["intro", "key", "sending"];

/** Every top-level screen state. Setup appears in two modes: "flow"
 * (the linear wizard, Back/Next between its numbered screens) and
 * "single" (one screen opened from the hub, dismissed with Close). */
type ScreenState =
  | { kind: "setup"; mode: "flow" | "single"; step: SetupStepId }
  | { kind: "encrypt"; step: 1 | 2 | 3 | 4 }
  | { kind: "receipt" }
  | { kind: "hub" }
  | { kind: "reset" }
  | { kind: "sentitems" }
  | { kind: "keydetails" }
  | { kind: "aboutbuild" };

function byteLen(value: string): number {
  return new TextEncoder().encode(value).length;
}

function validateRecipient(value: string): { ok: boolean; message: string } {
  if (value.length === 0) return { ok: false, message: "The key is empty." };
  if (!value.startsWith("age1")) {
    return { ok: false, message: "A Muse key starts with “age1”." };
  }
  if (value.length !== 62) {
    return {
      ok: false,
      message: `A Muse key is 62 characters long — this one is ${value.length}. Check for a missing or extra character.`,
    };
  }
  if (!/^age1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/.test(value)) {
    return { ok: false, message: "The key contains a character that doesn't belong in an age key." };
  }
  return { ok: true, message: "" };
}

const AGE_TOKEN_RE = /age1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}/;

/**
 * Clean pasted text for the "Your copy" field: strip all whitespace, then
 * if a complete age1 token (age1 + 58 bech32 characters) appears anywhere
 * in the stripped text, extract only that token — dropping any leading
 * label ("Public key:"), quotes, or trailing commentary around it. If no
 * complete token is found, return the whitespace-stripped value unchanged
 * so the normal validation messages explain what's wrong. `trimmed` is
 * true only when extraction actually removed non-whitespace matter.
 */
function extractAgeKey(rawInput: string): { value: string; trimmed: boolean } {
  const stripped = rawInput.replace(/\s/g, "");
  const match = stripped.match(AGE_TOKEN_RE);
  if (match && match[0]) {
    return { value: match[0], trimmed: match[0] !== stripped };
  }
  return { value: stripped, trimmed: false };
}

/**
 * Clean a service name into the label format: lowercase letters, numbers
 * and hyphens only, starting with a letter or number, at most 64
 * characters. While typing, capitals come in as lowercase and disallowed
 * characters simply don't land; on paste, spaces become hyphens and the
 * rest of the disallowed characters are dropped. The cleaned result is
 * what the field shows, so nothing about the change is hidden.
 */
function sanitizeService(raw: string, fromPaste: boolean): string {
  let s = raw.toLowerCase();
  s = fromPaste ? s.replace(/\s+/g, "-") : s.replace(/\s/g, "");
  s = s.replace(/[^a-z0-9-]/g, "");
  s = s.replace(/^-+/, "");
  return s.slice(0, SERVICE_CAP);
}

/** A purely local password-strength heuristic (length and variety),
 * scored 0 (weakest) to 1 (strongest) for the strength meter under the
 * password field. It only ever informs — it never blocks. Machine-issued
 * secrets (API keys, tokens, PEMs) are never judged: their strength
 * isn't the user's choice. */
function passwordStrength(pw: string): number {
  if (pw === "") return 0;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  const lengthScore = Math.min(pw.length, 20) / 20;
  const varietyScore = classes / 4;
  return Math.min(1, lengthScore * 0.6 + varietyScore * 0.4);
}

/** True when the text's PEM header is a PRIVATE KEY block. Anything else
 * with content — a PUBLIC KEY block, another block type, or no header at
 * all — is not a private key. */
function pemIsPrivateKey(text: string): boolean {
  return /-----BEGIN [^-]*PRIVATE KEY-----/.test(text);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Parse the age header out of decoded ciphertext for the check line. */
function headerCheckLine(bytes: Uint8Array): string {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const end = head.indexOf("\n---");
  const header = end === -1 ? "" : head.slice(0, end);
  const lines = header.split("\n");
  const stanzas = lines.filter((line) => line.startsWith("-> "));
  const types = stanzas.map((line) => line.slice(3).split(" ")[0] ?? "");
  if (lines[0] === "age-encryption.org/v1" && stanzas.length === 1 && types[0] === "X25519") {
    return "age-encryption.org/v1 · 1 X25519 recipient";
  }
  return `Header check: unexpected header (${lines[0] ?? "none"}, ${stanzas.length} stanza(s)) — do not send this`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

const inputClass =
  "w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-4 py-3 text-base text-[var(--text)] outline-none focus:border-[var(--accent)]";
const labelClass = "block text-base font-medium text-[var(--text)] mb-2";

/** The fixed bottom bar's configuration for the current screen, computed
 * once per render and rendered by the app shell — Back/Next live in the
 * shell, not inside each screen, so they never scroll or clip. `single`
 * renders one full-width button (secondary screens); otherwise Back and
 * Next sit side by side and Next stays disabled until the screen's job
 * is done. `hint` is the small line some screens show above the bar. */
type NavButton = { label: string; onClick: () => void; disabled?: boolean };
type NavConfig = {
  back?: NavButton;
  next?: NavButton;
  /** A row of equal-width buttons — the Receipt screen's bar. When
   * present it replaces the back/next pair. */
  triple?: (NavButton & { primary?: boolean })[];
  single?: { label: string; onClick: () => void; primary?: boolean };
  hint?: string;
};

/* Nav-bar sizing is a property of the responsive framework (item G):
 * the provenance label takes its natural width and the buttons flex to
 * divide the remaining width equally — two buttons split it, three
 * buttons take a third each — instead of sizing to their label text.
 * At the tightest density tier the label leaves the bar entirely (see
 * .provenance-inbar / .provenance-fallback in theme.css) and the
 * buttons keep the full bar. */
const navBackClass =
  "min-h-[52px] min-w-0 flex-1 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 text-lg font-medium text-[var(--text)]";
const navNextClass =
  "min-h-[52px] min-w-0 flex-1 rounded-full bg-[var(--accent)] px-3 text-lg font-semibold text-white disabled:opacity-40 dark:text-[#0b1512]";
const navThirdClass =
  "min-h-[52px] min-w-0 flex-1 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 text-lg font-medium text-[var(--text)]";
const navSingleClass =
  "min-h-[52px] w-full rounded-full border border-[var(--border)] bg-[var(--surface)] px-5 text-lg font-medium text-[var(--text)]";
const navSinglePrimaryClass =
  "min-h-[52px] w-full rounded-full bg-[var(--accent)] px-5 text-lg font-semibold text-white dark:text-[#0b1512]";

export function App() {
  const queryClient = useQueryClient();
  // The Delivery Slot, consumed once at launch (see the effect below):
  // the recipient Muse delivered for this launch, if any, and the
  // service label that came with it. Until the consume resolves, the
  // opening screen is not decided.
  const [delivery, setDelivery] = useState<{
    recipient: string;
    serviceLabel: string | null;
  } | null>(null);
  // Muse's key for this launch, as resolved by the consume-at-launch
  // path: a delivery consumed at this launch, else the persisted
  // recipient from an earlier delivery, else null — there is no
  // built-in fallback key. While null, the app shows a waiting state
  // and cannot encrypt or display a key.
  const [launchRecipient, setLaunchRecipient] = useState<string | null>(null);
  const [deliveryChecked, setDeliveryChecked] = useState(false);
  const consumeStartedRef = useRef(false);
  const museRecipient = launchRecipient;
  const hasRecipient = museRecipient != null;

  const [screen, setScreen] = useState<ScreenState>({ kind: "encrypt", step: 1 });
  // Secondary screens (the Setup & reset hub and everything opened from
  // it, plus the key-details screen) have no back-stack: their Close
  // button returns to the screen the user was on when they opened the
  // secondary layer. That origin is remembered here as a full screen
  // snapshot and restored exactly.
  const [origin, setOrigin] = useState<ScreenState | null>(null);
  // Return-to-the-actual-invoker for screens that sit INSIDE the
  // secondary layer (item D): a screen opened from the Setup & reset
  // hub Closes back to the hub; the same screen reached from a flow
  // (the handover from Setup, the key check from the launch gate)
  // returns to that invoker instead. Set when a sub-page is opened;
  // null means "not in a sub-page — Close leaves the whole layer".
  const [subReturn, setSubReturn] = useState<ScreenState | null>(null);
  // How the current Setup flow was entered: "firstrun" (the flow runs
  // to its end — a first run, or a re-run because the Setup flow's own
  // version changed) or "gate" (a confirmation is pending, so the
  // launch opened on the key check before Encrypt Step 1).
  const [, setSetupEntry] = useState<"firstrun" | "gate">("firstrun");
  // True when Setup is re-running on an already-set-up install because
  // the setupVersion changed: the handover asks for its tick again,
  // exactly as on a first run.
  const [setupVersionRerun, setSetupVersionRerun] = useState(false);
  // True when the key handover is on screen because the Delivery Slot
  // brought a changed key with this launch: saving the new copy here
  // proceeds to Encrypt Step 1, and the confirmation happens at the
  // NEXT launch (the pending flag is already set).
  const [deliveryHandover, setDeliveryHandover] = useState(false);
  // True while the key check is shown as the launch gate — drives the
  // gate's explanatory banner.
  const [gateNotice, setGateNotice] = useState(false);
  // Setup local state. `setupReason` is "keyUpdated" when the user
  // arrived at the key handover from the key check's mismatch route
  // (likely a rotation).
  const [setupReason, setSetupReason] = useState<"normal" | "keyUpdated">("normal");
  const [copySaved, setCopySaved] = useState(false);
  // Button-press confirmations live on the buttons themselves (item
  // 34): the handover Copy/Download gain a "✓" once pressed on THIS
  // visit to the screen. Both are cleared every time the key screen
  // is entered (see the effect below).
  const [keyCopied, setKeyCopied] = useState(false);
  const [keyDownloaded, setKeyDownloaded] = useState(false);
  const [resetArmed, setResetArmed] = useState(false);
  // The screen the About this build screen was opened from — its
  // Close returns to exactly it.
  const [aboutBuildReturn, setAboutBuildReturn] = useState<ScreenState | null>(null);

  // Preferences (server-side, so they follow the user across devices).
  // Only the recipient's SHA-256 hash is ever stored — never a key or a
  // credential value.
  const prefsQuery = useQuery({
    queryKey: ["wizard-prefs"],
    queryFn: () => api.getWizardPrefs({}),
  });
  const prefs = prefsQuery.data;
  const completions = prefs?.completions ?? 0;

  const setPrefsMutation = useMutation({
    mutationFn: async (patch: {
      confirmedRecipientHash?: string | null;
      confirmedBuildFingerprint?: string | null;
      lastKeyCheckAt?: string | null;
      setupCompleted?: boolean;
      deliveryPref?: "save" | "copy";
      confirmationPending?: boolean;
      completedSetupVersion?: string | null;
    }) => await api.setWizardPrefs(patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["wizard-prefs"] });
    },
  });

  const recordCompletionMutation = useMutation({
    mutationFn: async () => await api.recordCompletion({}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["wizard-prefs"] });
    },
  });

  const resetMutation = useMutation({
    mutationFn: async () => await api.resetWizardPrefs({}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["wizard-prefs"] });
    },
  });

  // Release info: the agent maintains it server-side. The page reads two
  // things from it — the name of the store behind "Save to Muse
  // directly" (the user's choice, displayed, never picked here), and the
  // expected build fingerprint for the provenance line's self-check.
  // The page no longer announces new versions; that is Muse's job,
  // outside the page.
  const releaseQuery = useQuery({
    queryKey: ["release-info"],
    queryFn: () => api.getReleaseInfo({}),
  });
  const release = releaseQuery.data;
  const storeName = release?.storeName ?? "Muse's store (prototype)";
  // The Setup flow's version in this build, as recorded in the release
  // info the agent maintains. Setup re-runs at launch only when the
  // user's completed setupVersion differs from this.
  const currentSetupVersion = release?.setupVersion ?? FALLBACK_SETUP_VERSION;
  // Provenance self-check: the page compares its own build fingerprint
  // against the expected value recorded in the stored release info. A
  // mismatch means this page differs from the build it was installed
  // from — an honesty label for deliberate customisation, not a
  // security claim.
  const isCustomBuild = release ? release.latestVersion !== BUILD_FINGERPRINT : false;

  // Whether the opening screen has been decided from the loaded prefs yet.
  const startDecidedRef = useRef(false);
  // Guards against recording the same finished encryption twice when the
  // user both copies and saves the same blob.
  const completionRecordedRef = useRef(false);
  // The scrollable content region. Every screen change resets its scroll
  // position to the top, so a new screen never opens scrolled down with
  // its heading lost.
  const mainRef = useRef<HTMLElement | null>(null);

  function recordCompletionOnce() {
    if (completionRecordedRef.current) return;
    completionRecordedRef.current = true;
    recordCompletionMutation.mutate();
  }

  // The key check's two holdings of the same public key. Muse's key is
  // the value delivered with this page. "Your copy" is what the user
  // pastes from their own installation records; it starts EMPTY whenever
  // the key check is shown so the compare is between two independent
  // holdings.
  const [recipient, setRecipient] = useState("");
  const [pasteTrimmed, setPasteTrimmed] = useState(false);
  // The empty-field bypass: ticking it lets the user proceed without the
  // check. It never marks the check as done — no pin, no key-check time —
  // so the check is asked again next time.
  const [bypassKeyCheck, setBypassKeyCheck] = useState(false);
  const recipientRaw = recipient.replace(/\s/g, "");
  const recipientCheck = validateRecipient(recipientRaw);
  const recipientValid = recipientCheck.ok;
  const keysMatch = recipientValid && museRecipient != null && recipientRaw === museRecipient;
  // Any non-empty input that does not match — partial, garbled, or a
  // complete but different key — hard-blocks, with no override.
  const keysMismatch = recipientRaw !== "" && !keysMatch;
  const keyCheckCanProceed =
    hasRecipient && (keysMatch || (recipientRaw === "" && bypassKeyCheck));
  // Whether the delivered key differs from the confirmed pin — the other
  // trigger for the key handover's "key updated" framing.
  const [deliveredHash, setDeliveredHash] = useState<string | null>(null);
  useEffect(() => {
    if (museRecipient == null) {
      setDeliveredHash(null);
      return;
    }
    void sha256Hex(museRecipient).then(setDeliveredHash);
  }, [museRecipient]);
  const keyChangedFromPin =
    prefs?.confirmedRecipientHash != null &&
    deliveredHash != null &&
    prefs.confirmedRecipientHash !== deliveredHash;
  const keyUpdated = setupReason === "keyUpdated" || keyChangedFromPin;
  // The handover gate: the "I've saved my copy" tick is asked only when
  // there is a copy to save — a first run (setup not yet completed) or a
  // changed key. This one predicate drives BOTH the checkbox's render
  // and Next's disabled state. They once disagreed: with setup completed
  // and the key unchanged (e.g. arriving at the handover from the hub)
  // the checkbox was not rendered, yet Next still waited for its tick —
  // a dead end with no visible way forward.
  const handoverGate = !prefs?.setupCompleted || keyUpdated || setupVersionRerun;
  // What encryption actually uses: Muse's key — the delivery consumed
  // at this launch, or the persisted recipient from an earlier
  // delivery. In every reachable flow the key check either matched the
  // user's copy against it or was deliberately bypassed, so this is
  // the key credentials encrypt to. Null when no key has ever been
  // delivered: then nothing encrypts.
  const effectiveRecipient = museRecipient;

  // Consume the Delivery Slot exactly once, at launch: whatever Muse
  // left there is picked up and the slot is empty again. The consume
  // path also returns the persisted recipient when no delivery is
  // waiting, so the launch resolves the delivered key either way. A
  // malformed recipient is ignored — the launch then has no key.
  useEffect(() => {
    if (consumeStartedRef.current) return;
    consumeStartedRef.current = true;
    void (async () => {
      try {
        const result = await api.consumeDelivery({});
        if (result.recipient && validateRecipient(result.recipient).ok) {
          setLaunchRecipient(result.recipient);
          if (result.delivered) {
            setDelivery({ recipient: result.recipient, serviceLabel: result.serviceLabel });
          }
        }
      } catch {
        // No delivery could be read: the launch proceeds without one.
      } finally {
        setDeliveryChecked(true);
      }
    })();
  }, []);

  // Decide the opening screen once the prefs, the release info and the
  // Delivery Slot have all been read. In order:
  //   1. A delivered key whose hash differs from an existing confirmed
  //      pin is a key change: this sitting shows the handover so the
  //      user can save the new copy, and confirmation is set pending
  //      for the next launch. With no pin yet, a delivered key is not
  //      a change — the launch falls through to the confirmation gate
  //      (branch 3) when one is pending.
  //   2. Setup runs when it has never completed, or when the Setup
  //      flow's version has changed since the user completed it. (A
  //      bundle fingerprint change alone no longer re-runs anything.)
  //   3. A pending confirmation opens the key check as a gate before
  //      Encrypt Step 1.
  //   4. Otherwise the app lands on Encrypt Step 1.
  // A delivered service label pre-fills Encrypt Step 1 in every case.
  useEffect(() => {
    if (!prefs || !release || !deliveryChecked || startDecidedRef.current) return;
    startDecidedRef.current = true;
    if (delivery?.serviceLabel) {
      setSvc(sanitizeService(delivery.serviceLabel, true));
    }
    void (async () => {
      const hash = museRecipient ? await sha256Hex(museRecipient.trim()) : null;
      if (
        delivery &&
        hash != null &&
        prefs.setupCompleted &&
        prefs.confirmedRecipientHash != null &&
        prefs.confirmedRecipientHash !== hash
      ) {
        setPrefsMutation.mutate({ confirmationPending: true });
        setSetupReason("keyUpdated");
        setCopySaved(false);
        setDeliveryHandover(true);
        setScreen({ kind: "setup", mode: "flow", step: "key" });
        return;
      }
      if (!prefs.setupCompleted || prefs.completedSetupVersion !== currentSetupVersion) {
        if (prefs.setupCompleted) setSetupVersionRerun(true);
        setSetupEntry("firstrun");
        setScreen({ kind: "setup", mode: "flow", step: "intro" });
        return;
      }
      if (prefs.confirmationPending) {
        setSetupEntry("gate");
        setGateNotice(true);
        setScreen({ kind: "setup", mode: "flow", step: "keycheck" });
        return;
      }
      setScreen({ kind: "encrypt", step: 1 });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs, release, deliveryChecked]);

  // Every screen change starts at the top of the content region — a new
  // screen never inherits the previous screen's scroll position.
  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [screen]);

  // Entering the key handover screen clears the Copy/Download check
  // marks: they are statements about this visit only (item 34).
  useEffect(() => {
    if (screen.kind === "setup" && screen.step === "key") {
      setKeyCopied(false);
      setKeyDownloaded(false);
    }
  }, [screen]);

  /** Pin the key confirmation (hash + fingerprint + time) server-side
   * and clear any pending confirmation. Called only on a genuine
   * match — never on the bypass. */
  function pinKeyConfirmation() {
    if (effectiveRecipient == null) return;
    setGateNotice(false);
    void (async () => {
      const hash = await sha256Hex(effectiveRecipient.trim());
      setPrefsMutation.mutate({
        confirmedRecipientHash: hash,
        confirmedBuildFingerprint: BUILD_FINGERPRINT,
        lastKeyCheckAt: new Date().toISOString(),
        confirmationPending: false,
      });
    })();
  }

  /** Show the key check with a fresh field and no bypass. */
  function showKeyCheck(mode: "flow" | "single") {
    setRecipient("");
    setPasteTrimmed(false);
    setBypassKeyCheck(false);
    setScreen({ kind: "setup", mode, step: "keycheck" });
  }

  /** Open the key-details screen: remembers the current screen as the
   * origin so the screen's Close returns to exactly it. */
  function openKeyDetails() {
    setOrigin(screen);
    setScreen({ kind: "keydetails" });
  }

  /** Open a sub-page from the Setup & reset hub (item D): its Close
   * returns to the hub, not to wherever the user was before the hub. */
  function openFromHub(target: ScreenState) {
    setSubReturn({ kind: "hub" });
    setScreen(target);
  }

  /** Open the Setup & reset hub (the header's gear button). Entering the
   * secondary layer from a wizard screen remembers it as the origin;
   * tapping the gear from inside the layer keeps the original origin. */
  function openHub() {
    if (screen.kind === "setup" || screen.kind === "encrypt") {
      setOrigin(screen);
    }
    setSubReturn(null);
    setResetArmed(false);
    setScreen({ kind: "hub" });
  }

  /** Close on a secondary screen: dismiss the whole secondary layer and
   * return to the screen the user was on when they opened it. Falls back
   * to the applicable start (Encrypt Step 1 when setup is current, the
   * Setup flow otherwise) when no origin was recorded. If the key check
   * was opened on its own and the keys match, closing it pins the
   * confirmation — a match is a completed check. */
  function closeSecondaryLayer() {
    if (screen.kind === "setup" && screen.mode === "single" && screen.step === "keycheck" && keysMatch) {
      pinKeyConfirmation();
    }
    // A sub-page opened from the hub (or from a flow screen) Closes
    // back to that invoker (item D) — the layer itself stays open.
    if (subReturn) {
      const back = subReturn;
      setSubReturn(null);
      setResetArmed(false);
      setScreen(back);
      return;
    }
    const target = origin;
    setOrigin(null);
    setSetupReason("normal");
    setResetArmed(false);
    if (target) {
      setScreen(target);
    } else if (prefs?.setupCompleted) {
      setScreen({ kind: "encrypt", step: 1 });
    } else {
      setSetupEntry("firstrun");
      setScreen({ kind: "setup", mode: "flow", step: "intro" });
    }
  }

  /** Open the key handover in "key updated" mode (from the mismatch
   * route): Continue there lands back on the key check. */
  function openKeyUpdatedSetup() {
    if (screen.kind === "setup" && screen.mode === "single") {
      setSetupReason("keyUpdated");
      setCopySaved(false);
      setScreen({ kind: "setup", mode: "single", step: "key" });
      return;
    }
    setSetupReason("keyUpdated");
    setCopySaved(false);
    setScreen({ kind: "setup", mode: "flow", step: "key" });
  }

  /** Open About the key as a secondary screen: from the Setup flow it
   * remembers the invoking screen as the origin, so its single Close
   * returns to exactly it; from inside the secondary layer (the hub's
   * key screen) the existing origin stands, like every other
   * secondary screen. */
  function openAboutKey() {
    if (screen.kind === "setup" && screen.mode === "flow") {
      setOrigin(screen);
      // Reached from a flow (the Setup handover): Close returns to
      // that invoker, not the hub (item D).
      setSubReturn(screen);
    }
    setScreen({ kind: "setup", mode: "single", step: "about" });
  }

  /** Open the About this build screen (the provenance block in the
   * nav bar): remembers the exact screen it was opened from so its
   * Close returns there. */
  function openAboutBuild() {
    if (screen.kind === "aboutbuild") return;
    setAboutBuildReturn(screen);
    setScreen({ kind: "aboutbuild" });
  }

  /** Close on the About this build screen: back to the screen it was
   * opened from. */
  function closeAboutBuild() {
    const target = aboutBuildReturn;
    setAboutBuildReturn(null);
    if (target) {
      setScreen(target);
    } else {
      closeSecondaryLayer();
    }
  }

  /** Finish the Setup flow (the Sending screen's final button): record the
   * completion against the current setupVersion, set confirmation
   * pending — the handover in this flow delivered a key for saving, so
   * the NEXT launch asks for the confirmation — and land on Encrypt
   * Step 1. This same sitting proceeds without a gate. */
  function finishSetup() {
    setSetupReason("normal");
    setSetupVersionRerun(false);
    setPrefsMutation.mutate({
      setupCompleted: true,
      completedSetupVersion: currentSetupVersion,
      confirmationPending: true,
    });
    setScreen({ kind: "encrypt", step: 1 });
  }

  /** Key check Next in flow mode. The key check reaches flow mode only
   * as the launch gate (or as the in-session re-check after a
   * key-updated handover): a match pins the confirmation and clears
   * the pending flag; the bypass proceeds without pinning anything, so
   * the gate returns next launch. Either way the user lands on Encrypt
   * Step 1. */
  function keyCheckNext() {
    if (keysMatch) pinKeyConfirmation();
    if (screen.kind === "setup" && screen.mode === "flow") {
      setGateNotice(false);
      setSetupReason("normal");
      setScreen({ kind: "encrypt", step: 1 });
    }
  }

  /** Setup screen: copy the delivered key — here copying is the point.
   * The confirmation lives on the button ("✓ Copied"); no text line
   * appears. A failed copy simply leaves the button unchecked. */
  async function handleCopyKey() {
    if (museRecipient == null) return;
    try {
      await navigator.clipboard.writeText(museRecipient);
      setKeyCopied(true);
    } catch {
      // No check mark: the copy did not happen on this visit.
    }
  }

  /** Setup screen: download the user's copy of Muse's key as a .txt file. */
  function handleDownloadKey() {
    if (museRecipient == null) return;
    const text = [
      "Credential Lockbox — your copy of Muse's key",
      "",
      "This is your copy of Muse's public key. It is the key your",
      "credentials are encrypted for, so only your Muse can read them.",
      "",
      museRecipient,
      "",
      "Keep this copy in your password manager — it is your installation",
      "record. When the wizard asks you to check the key, paste this copy",
      "back in so the page can confirm the two agree.",
      "",
    ].join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "credential-lockbox-my-copy-of-muses-key.txt";
    link.click();
    URL.revokeObjectURL(url);
    setKeyDownloaded(true);
  }

  /** Reset (from the hub): back to first-run state, then show setup afresh. */
  function handleReset() {
    resetMutation.mutate(undefined, {
      onSuccess: () => {
        setResetArmed(false);
        setCopySaved(false);
        setGateNotice(false);
        setSetupVersionRerun(false);
        setDeliveryHandover(false);
        setRecipient("");
        setPasteTrimmed(false);
        setBypassKeyCheck(false);
        setOrigin(null);
        setSubReturn(null);
        setSetupEntry("firstrun");
        setSetupReason("normal");
        startDecidedRef.current = true;
        setScreen({ kind: "setup", mode: "flow", step: "intro" });
      },
    });
  }

  // Encrypt Step 1 — service + type. The field starts EMPTY with a
  // placeholder, unless the Delivery Slot carried a service label with
  // this launch — the launch decision then pre-fills it as real,
  // editable text. A previous run's name is never resurrected.
  const [svc, setSvc] = useState<string>("");
  const [credType, setCredType] = useState<CredType>("userpass");

  // Encrypt Step 2 — details (values keyed by field name; only the
  // chosen type's fields are rendered and used)
  const [values, setValues] = useState<Record<string, string>>({});
  const [pemFileName, setPemFileName] = useState("");
  const pemFileRef = useRef<HTMLInputElement>(null);

  // Encrypt Steps 3–4 — encryption result
  const [blob, setBlob] = useState("");
  const [checkLine, setCheckLine] = useState("");
  const [encryptError, setEncryptError] = useState("");
  const [encrypting, setEncrypting] = useState(false);
  // The delivery screen's Copy confirmation, on the button itself
  // (item 34): set by a successful copy on this visit, cleared
  // whenever a new encryption lands on the delivery screen or the
  // run restarts.
  const [blobCopied, setBlobCopied] = useState(false);

  // Encrypt Step 4 — save receipt
  const [receipt, setReceipt] = useState<{
    label: string;
    sha256Short: string;
    createdAt: string;
    status: string;
  } | null>(null);
  const [saveError, setSaveError] = useState("");

  const savedList = useQuery({
    queryKey: ["saved-blobs"],
    queryFn: () => api.listSaved({ limit: 20 }),
    enabled: (screen.kind === "encrypt" && screen.step === 4) || screen.kind === "sentitems",
  });

  const saveMutation = useMutation({
    mutationFn: async () =>
      await api.depositBlob({
        label: svc.trim(),
        blob,
        // Record which key this blob was encrypted to, by hash, so
        // the sent item can later prove its recipient.
        recipientHash: effectiveRecipient
          ? await sha256Hex(effectiveRecipient.trim())
          : null,
      }),
    onSuccess: (result) => {
      if (result.ok && result.receipt) {
        setReceipt({
          label: result.receipt.label,
          sha256Short: result.receipt.sha256Short,
          createdAt: result.receipt.createdAt,
          status: result.receipt.status,
        });
        setSaveError("");
        recordCompletionOnce();
        void queryClient.invalidateQueries({ queryKey: ["saved-blobs"] });
        // Save jumps to the Receipt screen (item F) — its own screen,
        // with its own eyebrow and heading.
        setScreen({ kind: "receipt" });
      } else {
        setSaveError(result.error ?? "Saving did not work. You can still copy it and paste it in a Muse chat instead.");
      }
    },
    onError: (error) => {
      setSaveError(
        error instanceof Error
          ? error.message
          : "Saving did not work. You can still copy it and paste it in a Muse chat instead.",
      );
    },
  });

  const fieldDefs = FIELD_DEFS[credType];
  // Preview/review rows carry the FORM labels ("Service", "Username",
  // "Password", …) — never the payload's internal field names.
  const payloadRows = useMemo(() => {
    const rows: { key: string; label: string; value: string; required: boolean; includeEmpty: boolean }[] = [
      { key: "svc", label: "Service", value: svc.trim(), required: true, includeEmpty: false },
    ];
    for (const def of fieldDefs) {
      rows.push({
        key: def.key,
        label: def.label,
        value: values[def.key] ?? "",
        required: !def.optional,
        includeEmpty: def.includeEmpty ?? false,
      });
    }
    return rows;
  }, [fieldDefs, values, svc]);

  const pemValue = credType === "pem" ? (values.private_key ?? "") : "";
  const pemInvalid = credType === "pem" && pemValue !== "" && !pemIsPrivateKey(pemValue);

  const detailsValid = useMemo(() => {
    const filled = payloadRows.filter((r) => r.key !== "svc" && r.value !== "");
    const missingRequired = payloadRows.some((r) => r.required && r.value === "");
    return filled.length > 0 && !missingRequired && !pemInvalid;
  }, [payloadRows, pemInvalid]);

  function buildPayload(): Record<string, string> {
    const payload: Record<string, string> = { svc: svc.trim() };
    for (const def of fieldDefs) {
      const v = values[def.key] ?? "";
      // Optional-empty fields are left out — except the ones marked
      // includeEmpty (the password), where empty is recorded as empty.
      if (v !== "" || def.includeEmpty) payload[def.key] = v;
    }
    return payload;
  }

  /** Field input with the cap enforced: at the cap the field stops
   * accepting more (the "Maximum length reached" note shows, because
   * the value is at the cap); a long paste inserts only up to the cap
   * and the same note tells the user it happened. */
  function handleFieldChange(def: FieldDef, raw: string) {
    setValues((prev) => ({ ...prev, [def.key]: raw.slice(0, def.cap) }));
  }

  function handleServiceChange(e: ChangeEvent<HTMLInputElement>) {
    const native = e.nativeEvent as InputEvent | undefined;
    const fromPaste = native?.inputType === "insertFromPaste";
    setSvc(sanitizeService(e.target.value, fromPaste));
  }

  async function handleEncrypt() {
    if (effectiveRecipient == null) {
      // No key has been delivered: the app must not encrypt. The
      // Encrypt flow's entry already shows the waiting state, so this
      // is only a backstop.
      setEncryptError("This app is still waiting for your Muse to send it the key.");
      return;
    }
    setEncryptError("");
    setEncrypting(true);
    try {
      const encrypter = new Encrypter();
      encrypter.addRecipient(effectiveRecipient.trim());
      const ciphertext = await encrypter.encrypt(JSON.stringify(buildPayload()));
      const b64 = bytesToBase64(ciphertext);
      setBlob(b64);
      setCheckLine(headerCheckLine(base64ToBytes(b64)));
      setReceipt(null);
      setSaveError("");
      setBlobCopied(false);
      completionRecordedRef.current = false;
      setScreen({ kind: "encrypt", step: 4 });
    } catch (err) {
      setEncryptError(
        err instanceof Error ? `Encryption did not work: ${err.message}` : "Encryption did not work.",
      );
    } finally {
      setEncrypting(false);
    }
  }

  async function handleCopy() {
    if (!blob) return;
    try {
      await navigator.clipboard.writeText(blob);
      setBlobCopied(true);
      recordCompletionOnce();
    } catch {
      // No check mark: the copy did not happen on this visit. The
      // encrypted text stays selectable for a manual copy, which the
      // field's onCopy still counts.
    }
  }

  function handlePemFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    void file.text().then((text) => {
      setValues((prev) => ({ ...prev, private_key: text.slice(0, 16384) }));
      setPemFileName(`${file.name} · ${file.size} bytes — read on this device`);
    });
  }

  /** End an Encrypt run ("Encrypt another" on Step 4 and the Receipt
   * screen): clear the in-progress credential state and return to
   * Encrypt Step 1.
   * Launch gating (setup, the confirmation gate) is a launch decision
   * only — within a sitting the user always returns to Step 1, unless
   * setup has never been completed at all. */
  function restartRun() {
    completionRecordedRef.current = false;
    setSvc("");
    setCredType("userpass");
    setValues({});
    setPemFileName("");
    setBlob("");
    setCheckLine("");
    setEncryptError("");
    setBlobCopied(false);
    setReceipt(null);
    setSaveError("");
    if (prefs?.setupCompleted) {
      setScreen({ kind: "encrypt", step: 1 });
    } else {
      setSetupEntry("firstrun");
      setScreen({ kind: "setup", mode: "flow", step: "intro" });
    }
  }

  // Delivery step: the setup preference decides which action is
  // primary; the other stays available as the secondary.
  const deliveryPref = prefs?.deliveryPref ?? "save";
  const primaryDeliveryClass =
    "min-h-[52px] w-full rounded-full bg-[var(--accent)] px-5 text-lg font-semibold text-white disabled:opacity-40 dark:text-[#0b1512]";
  const secondaryDeliveryClass =
    "min-h-[52px] w-full rounded-full border-2 border-[var(--accent)] bg-[var(--surface)] px-5 text-lg font-semibold text-[var(--accent)]";
  const saveDeliveryButton = (
    <div>
      <button
        type="button"
        onClick={() => {
          // Once this blob is saved, the button is a confirmation,
          // not an action: tapping it again must not deposit a
          // duplicate (item F).
          if (receipt) return;
          saveMutation.mutate();
        }}
        disabled={saveMutation.isPending}
        className={deliveryPref === "save" ? primaryDeliveryClass : secondaryDeliveryClass}
      >
        {receipt ? "✓ Saved" : saveMutation.isPending ? "Saving…" : "Save to Muse directly"}
      </button>
      <p className="density-hide-compact mt-1 text-center text-sm text-[var(--dim)]">
        Goes straight to Muse. Nothing lands in a chat or on your clipboard.
      </p>
      {saveError ? (
        <p className="mt-2 text-center text-base font-medium text-[var(--bad)]" role="alert">
          {saveError}
        </p>
      ) : null}
    </div>
  );
  const copyDeliveryButton = (
    <div>
      <button
        type="button"
        onClick={() => void handleCopy()}
        className={deliveryPref === "copy" ? primaryDeliveryClass : secondaryDeliveryClass}
      >
        {blobCopied ? "✓ Copied" : "Copy"}
      </button>
      <p className="density-hide-compact mt-1 text-center text-sm text-[var(--dim)]">
        Copies the encrypted text — you then paste it into a Muse chat. Clipboard apps can
        see what you copy.
      </p>
    </div>
  );

  if (prefsQuery.isLoading || releaseQuery.isLoading || !deliveryChecked) {
    return (
      <div className="lockbox-shell h-dvh overflow-hidden bg-[var(--bg)] text-[var(--text)]">
        <div className="density-scope flex h-full flex-col">
          <SafeAreaTopScrim backgroundColor="var(--bg)" />
          <header className="mx-auto w-full max-w-xl shrink-0 px-5 pb-1 pt-3">
            <div className="flex items-center gap-3">
              <img
                src={lockboxIconUrl}
                alt=""
                aria-hidden="true"
                className="header-icon shrink-0"
              />
              <span className="flex-1" aria-hidden="true" />
            </div>
          </header>
          <main className="mx-auto flex min-h-0 w-full max-w-xl flex-1 flex-col px-5 py-3">
            <p className="text-lg text-[var(--dim)]">Loading…</p>
          </main>
        </div>
      </div>
    );
  }

  // Header eyebrow and progress for the current screen. One rule
  // everywhere (item 30): the eyebrow shows POSITION ONLY — the
  // screen's name appears exactly once, as its heading. Secondary
  // screens carry no eyebrow; their name is the heading.
  let eyebrow = "";
  let progress: { now: number; max: number; label: string } | null = null;
  if (screen.kind === "setup" && screen.mode === "flow" && SETUP_ORDER.includes(screen.step)) {
    const idx = SETUP_ORDER.indexOf(screen.step);
    eyebrow = `Setup · Step ${idx + 1} of ${SETUP_ORDER.length}`;
    progress = { now: idx + 1, max: SETUP_ORDER.length, label: eyebrow };
  } else if (screen.kind === "encrypt") {
    // No totals in the Encrypt flow (item F): a route can end at
    // Step 4 without ever seeing the Receipt screen, so a promised
    // count could be made a liar of. The progress bar still shows
    // how far along the run is.
    eyebrow = `Encrypt · Step ${screen.step}`;
    progress = { now: screen.step, max: 4, label: eyebrow };
  } else if (screen.kind === "receipt") {
    eyebrow = "Encrypt · Receipt";
    progress = { now: 4, max: 4, label: eyebrow };
  } else if (screen.kind === "keydetails") {
    eyebrow = "Muse's key";
  }

  // The fixed bottom bar for the current screen. Back = the previous
  // numbered screen of the same flow (Setup or Encrypt); the first
  // screen of a flow has no Back. Secondary screens — the hub and
  // everything opened from it, plus the key-details screen — get a
  // single Close instead: it dismisses the whole secondary layer and
  // returns to the screen the user was on when they opened it.
  let nav: NavConfig | null = null;
  if (screen.kind === "aboutbuild") {
    nav = { single: { label: "Close", onClick: closeAboutBuild } };
  } else if (screen.kind === "keydetails" || screen.kind === "sentitems" || screen.kind === "reset" || screen.kind === "hub") {
    nav = { single: { label: "Close", onClick: closeSecondaryLayer } };
  } else if (screen.kind === "setup" && screen.mode === "single") {
    nav = { single: { label: "Close", onClick: closeSecondaryLayer } };
  } else if (screen.kind === "setup") {
    // Linear Setup flow: Introduction → Your copy of the key → Sending
    // to Muse. The key check is not a step: in flow mode it appears
    // only as the launch gate, or as the in-session re-check after a
    // key-updated handover. About the key and Other ways to encrypt
    // are not steps either (items 32 and 36).
    if (screen.step === "intro") {
      nav = { next: { label: "Next", onClick: () => setScreen({ kind: "setup", mode: "flow", step: "key" }) } };
    } else if (screen.step === "key") {
      if (deliveryHandover) {
        // A changed key arrived with this launch: saving the new copy
        // proceeds to Encrypt Step 1. The confirmation is pending for
        // the next launch — it does not happen in this sitting.
        nav = {
          next: {
            label: "Next",
            onClick: () => {
              setDeliveryHandover(false);
              setSetupReason("normal");
              setScreen({ kind: "encrypt", step: 1 });
            },
            disabled: !hasRecipient || (handoverGate && !copySaved),
          },
        };
      } else if (keyUpdated) {
        nav = {
          back: { label: "Back", onClick: () => showKeyCheck("flow") },
          next: {
            label: "Continue to the key check",
            onClick: () => showKeyCheck("flow"),
            disabled: !hasRecipient || (handoverGate && !copySaved),
          },
        };
      } else {
        nav = {
          back: { label: "Back", onClick: () => setScreen({ kind: "setup", mode: "flow", step: "intro" }) },
          next: {
            label: "Next",
            onClick: () => setScreen({ kind: "setup", mode: "flow", step: "sending" }),
            disabled: !hasRecipient || (handoverGate && !copySaved),
          },
        };
      }
    } else if (screen.step === "keycheck") {
      // The gate is the launch's entry screen, so it has no Back —
      // except when it is the re-check after a key-updated handover,
      // where Back returns to that handover.
      nav = {
        ...(setupReason === "keyUpdated"
          ? { back: { label: "Back", onClick: () => setScreen({ kind: "setup", mode: "flow", step: "key" }) } }
          : {}),
        next: { label: "Next", onClick: keyCheckNext, disabled: !keyCheckCanProceed },
        hint: keysMismatch ? "Next stays off while the keys don't match." : undefined,
      };
    } else if (screen.step === "sending") {
      // The final Setup step's button completes setup and lands the
      // user on Encrypt Step 1, so it says exactly that — "Start
      // encrypting". Finish/Done-style labels conventionally mean
      // "close this dialog/window", and the app cannot close its own
      // Space, so no button may borrow that convention.
      nav = {
        back: { label: "Back", onClick: () => setScreen({ kind: "setup", mode: "flow", step: "key" }) },
        next: { label: "Start encrypting", onClick: finishSetup },
      };
    }
  } else if (screen.kind === "receipt") {
    // The Receipt screen's bar: build label plus two buttons
    // dividing the remaining width equally (item G). Back returns to
    // the delivery screen with the encrypted text still present;
    // Encrypt another ends the run (see restartRun). There is no
    // Done button — the app cannot close its own Space.
    nav = {
      triple: [
        { label: "Back", onClick: () => setScreen({ kind: "encrypt", step: 4 }) },
        { label: "Encrypt another", onClick: restartRun },
      ],
    };
  } else if (screen.kind === "encrypt") {
    if (screen.step === 1) {
      // First step of the Encrypt task: no Back.
      nav = {
        next: {
          label: "Next",
          onClick: () => setScreen({ kind: "encrypt", step: 2 }),
          disabled: !hasRecipient || svc.trim() === "",
        },
      };
    } else if (screen.step === 2) {
      nav = {
        back: { label: "Back", onClick: () => setScreen({ kind: "encrypt", step: 1 }) },
        next: {
          label: "Next",
          onClick: () => setScreen({ kind: "encrypt", step: 3 }),
          disabled: !detailsValid,
        },
      };
    } else if (screen.step === 3) {
      nav = {
        back: { label: "Back", onClick: () => setScreen({ kind: "encrypt", step: 2 }) },
        next: {
          label: encrypting ? "Encrypting…" : "Encrypt",
          onClick: () => void handleEncrypt(),
          disabled: encrypting || !hasRecipient,
        },
      };
    } else if (screen.step === 4) {
      // The delivery screen's nav pair: Back on the left, Encrypt
      // another on the right. Back returns to Review (Step 3) with
      // the run intact; Encrypt another ends the run and starts a
      // fresh encryption at Step 1. There is no Done button — there
      // is no host mechanism for an app to close its own Space view,
      // so after copying or saving the flow simply rests here, and
      // leaving the Space is the user's own app chrome.
      nav = {
        back: { label: "Back", onClick: () => setScreen({ kind: "encrypt", step: 3 }) },
        next: { label: "Encrypt another", onClick: restartRun },
      };
    }
  }

  /** The no-recipient state: no key has ever been delivered, so there
   * is nothing to encrypt to and no key to show or compare against.
   * The app waits for the user's Muse to send it the key. */
  function renderWaitingForKey() {
    return (
      <>
        <h1 className="screen-heading text-3xl font-bold leading-tight">Waiting for your Muse</h1>
        <p className="mt-4 text-lg leading-relaxed">
          This app is waiting for your Muse to send it the key. Ask your Muse to open
          Credential Lockbox for you — it will send the key, and then you can carry on here.
        </p>
      </>
    );
  }

  /** The key check screen's content — shared by the Setup flow and the
   * hub's single-screen visit. The intro paragraph and the "delivered
   * with this page" line stay visible in every state: entering text
   * never hides the text above the field. With no recipient at all
   * there is nothing to compare against: the waiting state shows
   * instead. */
  function renderKeyCheck() {
    if (!hasRecipient) {
      return <div className="contents">{renderWaitingForKey()}</div>;
    }
    return (
      <div className={`contents ${keysMatch || keysMismatch ? "keycheck-verdict" : ""}`}>
        <h1 className="screen-heading text-3xl font-bold leading-tight">Check Muse's key</h1>
        {gateNotice ? (
          // The gate banner is standing text: it stays visible in
          // every gate state (arrival, match, mismatch). When a
          // verdict shows, the space the verdict box needs is
          // reclaimed by density, not by hiding text: the wrapper
          // above carries the keycheck-verdict class, whose scoped
          // tokens tighten this screen's spacing and type a step
          // (the density ladder's own mechanism), and the
          // Look-closer row gives way — see theme.css and below.
          <div
            className="mt-5 rounded-[var(--radius)] border border-[var(--warn-border)] bg-[var(--warn-bg)] px-4 py-3"
            role="alert"
          >
            <p className="text-base font-semibold text-[var(--warn-text)]">
              Last time, you saved a copy of Muse's key. Confirm it here before you
              encrypt anything.
            </p>
          </div>
        ) : null}
        <p className="mt-3 text-base leading-relaxed">
          Paste your copy of Muse's key — the one saved when you set up Credential
          Lockbox — and this page will check it against the key delivered with this page.
        </p>
        <p className="mt-3 text-base font-medium text-[var(--text)]" role="status">
          Muse's key: delivered with this page ✓
        </p>
        <div className="mt-4">
          <label htmlFor="recipient-input" className={labelClass}>
            <span className="block text-base font-semibold">
              Your copy of Muse's key{" "}
              <span className="font-normal text-[var(--dim)]">(required)</span>
            </span>
          </label>
          <textarea
            id="recipient-input"
            value={recipientRaw}
            onChange={(e) => {
              const cleaned = extractAgeKey(e.target.value);
              setRecipient(cleaned.value);
              setPasteTrimmed(cleaned.trimmed);
              setBypassKeyCheck(false);
            }}
            rows={2}
            spellCheck={false}
            placeholder="Your copy of Muse's key"
            className={`${inputClass} font-mono text-lg leading-relaxed`}
            aria-describedby="recipient-help"
          />
          <p id="recipient-help" className="density-hide-compact mt-2 text-sm text-[var(--dim)]">
            {recipientRaw.length} / 62 characters
          </p>
          {pasteTrimmed ? (
            <p className="mt-2 text-sm text-[var(--dim)]" role="status">
              Trimmed the text around the key.
            </p>
          ) : null}
          {!recipientValid && recipientRaw.length > 0 ? (
            <p className="mt-2 text-base font-medium text-[var(--bad)]">{recipientCheck.message}</p>
          ) : null}
          {keysMatch ? (
            <div
              className="mt-3 rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--accent-soft)] px-4 py-3"
              role="status"
            >
              <p className="text-base font-semibold text-[var(--accent)]">The keys match</p>
              <p className="density-hide-compact mt-1 text-sm text-[var(--text)]">
                Your copy of Muse's key agrees with the key delivered with this page.
              </p>
            </div>
          ) : null}
          {keysMismatch ? (
            <div
              className="mt-3 rounded-[var(--radius)] border border-[var(--warn-border)] bg-[var(--warn-bg)] px-4 py-3"
              role="alert"
            >
              <p className="text-base font-semibold text-[var(--warn-text)]">
                The keys don't match — stop and check with your Muse.
              </p>
              <button
                type="button"
                onClick={openKeyUpdatedSetup}
                className="mismatch-cta mt-3 min-h-[44px] rounded-full border border-[var(--warn-border)] px-4 text-left text-base font-semibold text-[var(--warn-text)]"
              >
                Has your Muse given you a new key, or rotated its key? Get your new copy...
              </button>
            </div>
          ) : null}
          {/* The bypass is standing furniture (item 33): it stays on
              screen whether or not the field holds text. It only takes
              effect while the field is empty — typing anything clears
              the tick (see the field's onChange). */}
          <div className="mt-3">
            <label className="flex min-h-[48px] cursor-pointer items-start gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
              <input
                type="checkbox"
                checked={bypassKeyCheck}
                onChange={(e) => setBypassKeyCheck(e.target.checked)}
                className="mt-1 h-5 w-5 shrink-0 accent-[var(--accent)]"
              />
              <span className="text-base">Continue without checking the key</span>
            </label>
            <p className="mt-2 text-sm text-[var(--dim)]">
              The check proves your copy of Muse's key matches the key this page encrypts
              to. Without it, a wrong key would mean Muse can't read what you send — and
              you'll be asked to check again next time.
            </p>
          </div>
          <p className="mt-3 text-sm text-[var(--dim)]">
            Lost your copy? Ask your Muse to send it again.
          </p>
        </div>
        {!keysMismatch && !keysMatch ? (
          // In a verdict state the Look-closer gives way (as it did at
          // compact densities before): the verdict box is the focus,
          // the gate banner stays, and the screen must never need
          // inner scroll. The details stay reachable from the Review
          // step's full-key view once past the gate.
          <div className="density-hide-micro mt-4">
            <button
              type="button"
              onClick={openKeyDetails}
              className="min-h-[44px] rounded-full border border-[var(--border)] bg-[var(--surface)] px-5 text-base font-medium"
            >
              Look closer...
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="lockbox-shell h-dvh overflow-hidden bg-[var(--bg)] text-[var(--text)]">
      <div className="density-scope flex h-full flex-col">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      {/* App shell header on every screen: the Credential Lockbox icon at
          the top-left (a plain image, deliberately not a link — no
          mid-task exits), the current screen's eyebrow (the wizard step
          line on Encrypt screens, the screen's own name on Setup
          screens), and, at the right-hand end, the gear button that
          opens Setup & reset. */}
      <header className="mx-auto w-full max-w-xl shrink-0 px-5 pb-1 pt-3">
        <div className="flex items-center gap-3">
          <img
            src={lockboxIconUrl}
            alt=""
            aria-hidden="true"
            className="header-icon shrink-0"
          />
          {eyebrow ? (
            <p className="min-w-0 flex-1 truncate text-sm font-semibold">{eyebrow}</p>
          ) : (
            <span className="flex-1" aria-hidden="true" />
          )}
          <button
            type="button"
            onClick={openHub}
            aria-label="Setup & reset"
            className="flex min-h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--dim)]"
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="3.2" />
              <path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1" />
            </svg>
          </button>
        </div>
        {progress ? (
          <div
            className="step-progress-bar mt-1 h-2 overflow-hidden rounded-full bg-[var(--border)]"
            role="progressbar"
            aria-valuenow={progress.now}
            aria-valuemin={1}
            aria-valuemax={progress.max}
            aria-label={progress.label}
          >
            <div
              className="h-full rounded-full bg-[var(--accent)] transition-all"
              style={{ width: `${(progress.now / progress.max) * 100}%` }}
            />
          </div>
        ) : null}
      </header>
      <main
        ref={mainRef}
        className="mx-auto flex min-h-0 w-full max-w-xl flex-1 flex-col overflow-y-auto px-5 py-3"
      >
        {screen.kind === "setup" ? (
          <section aria-label="Set up Credential Lockbox" className="flex flex-1 flex-col">
            {screen.step === "intro" ? (
              <>
                <h1 className="screen-heading text-3xl font-bold leading-tight">Credential Lockbox</h1>
                <p className="intro-text mt-4 text-lg leading-relaxed">
                  Credential Lockbox is a small app inside Muse — not a website. It encrypts a
                  credential to Muse's key, here on your device, before anything leaves the app.
                  Only that key can decrypt it — and the private key is a protected file on your
                  Muse's machine. It is never shown anywhere.
                </p>
                <p className="intro-text mt-5 text-lg leading-relaxed">Setting up has three parts, in order:</p>
                <ol className="intro-text mt-3 list-decimal space-y-3 pl-5 text-lg leading-relaxed">
                  <li>
                    Save your copy of Muse's key.
                    <span className="block pl-2 text-sm font-normal text-[var(--dim)]">
                      Keep it in your password manager — it's your installation record.
                    </span>
                  </li>
                  <li>
                    Choose where saves go.
                    <span className="block pl-2 text-sm font-normal text-[var(--dim)]">
                      How encrypted credentials get to Muse — saved directly, or copied into a chat.
                    </span>
                  </li>
                  <li>
                    Confirm your copy of the key — next time.
                    <span className="block pl-2 text-sm font-normal text-[var(--dim)]">
                      The next time you open the Lockbox, it asks you to paste your copy back
                      so it can confirm it matches Muse's key.
                    </span>
                  </li>
                </ol>
                <p className="density-hide-tight mt-5 text-base leading-relaxed">
                  Have your password manager handy — that's the best place to keep your copy of
                  Muse's key.
                </p>
              </>
            ) : null}

            {screen.step === "key" && !hasRecipient ? (
              // No delivered or persisted key: the handover shows the
              // waiting state — never a key it does not hold.
              renderWaitingForKey()
            ) : screen.step === "key" ? (
              <>
                <h1 className="screen-heading text-3xl font-bold leading-tight">
                  {keyUpdated ? "Save your new copy of Muse's key" : "Your copy of Muse's key"}
                </h1>
                {keyUpdated ? (
                  <>
                    <p className="mt-3 text-base leading-relaxed">
                      Muse's key has changed — the old copy will no longer match, so replace it
                      with this one.
                    </p>
                    <p className="mt-2 text-base leading-relaxed">
                      Save a copy of it in your password manager (or somewhere safe that you can
                      find again later)
                    </p>
                    <p className="density-hide-compact mt-2 text-base leading-relaxed">
                      Rotation itself happens on Muse's side: this page never holds a private key;
                      it only hands you the new public key and re-checks your copy of it.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="mt-3 text-base leading-relaxed">
                      Save a copy of it in your password manager (or somewhere safe that you can
                      find again later)
                    </p>
                    <p className="density-hide-compact mt-2 text-base leading-relaxed">
                      This page was given Muse's public key. The copy you save is your
                      installation record — the copy you will paste back when the wizard checks the
                      key.
                    </p>
                  </>
                )}
                <div className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-4">
                  <p className="break-all font-mono text-lg leading-relaxed">{museRecipient}</p>
                </div>
                {/* One row (item 31): Copy and Download on the left,
                    About the key right-aligned on the same line. The
                    row wraps only if a compact tier cannot fit it.
                    Confirmations live on the buttons (item 34) — no
                    status line, and no explanation of what Copy and
                    Download do: nobody needs to be told. */}
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => void handleCopyKey()}
                    className="min-h-[48px] rounded-full bg-[var(--accent)] px-5 text-base font-semibold text-white dark:text-[#0b1512]"
                  >
                    {keyCopied ? "✓ Copied" : "Copy"}
                  </button>
                  <button
                    type="button"
                    onClick={handleDownloadKey}
                    className="min-h-[48px] rounded-full border border-[var(--border)] bg-[var(--surface)] px-5 text-base font-medium"
                  >
                    {keyDownloaded ? "✓ Downloaded" : "Download"}
                  </button>
                  <button
                    type="button"
                    onClick={openAboutKey}
                    className="ml-auto min-h-[44px] rounded-full border border-[var(--border)] bg-[var(--surface)] px-5 text-base font-medium"
                  >
                    About the key...
                  </button>
                </div>
                {handoverGate ? (
                  <div className="mt-5">
                    <label className="flex min-h-[48px] cursor-pointer items-start gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
                      <input
                        type="checkbox"
                        checked={copySaved}
                        onChange={(e) => setCopySaved(e.target.checked)}
                        className="mt-1 h-5 w-5 shrink-0 accent-[var(--accent)]"
                      />
                      <span className="text-base">
                        {keyUpdated
                          ? "I've saved my new copy of Muse's key"
                          : "I've saved my copy of Muse's key"}
                      </span>
                    </label>
                    {/* Standing text (item 33): the hint stays under
                        the checkbox whether or not it is ticked —
                        the tick and the lit Next are the state. */}
                    <p className="mt-2 text-sm text-[var(--dim)]">
                      {keyUpdated
                        ? "Tick the box once you've saved your new copy, and Continue will light up."
                        : "Tick the box once you've saved your copy of Muse's key, and Next will light up."}
                    </p>
                  </div>
                ) : null}
              </>
            ) : null}

            {screen.step === "about" ? (
              <>
                <h1 className="screen-heading text-3xl font-bold leading-tight">About the key</h1>
                <p className="mt-4 text-lg leading-relaxed">Muse's key has two halves.</p>
                <p className="mt-3 text-base leading-relaxed">
                  The public half is the key this app holds — it's what the app encrypts your
                  credential to. It can lock a credential, but it can't unlock one.
                </p>
                <p className="mt-3 text-base leading-relaxed">
                  The private half is a protected file on Muse's machine, and it is never shown
                  anywhere — you will never see it on a screen or in a message.
                </p>
                <p className="density-hide-compact mt-3 text-base leading-relaxed">
                  When one of your credentials is needed, the private key is loaded only inside
                  the program doing the decryption, in memory, just for the moments that takes.
                </p>
                <p className="density-hide-compact mt-3 text-base leading-relaxed">
                  Credential Lockbox never saves, stores or logs the decrypted credential.
                </p>
                <a
                  href="https://en.wikipedia.org/wiki/Public-key_cryptography"
                  target="_blank"
                  rel="noreferrer"
                  className="mt-5 flex min-h-[52px] w-full items-center rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 text-left text-lg font-medium text-[var(--text)] no-underline"
                >
                  Public-key cryptography on Wikipedia ↗
                </a>
              </>
            ) : null}

            {screen.step === "keycheck" ? renderKeyCheck() : null}

            {screen.step === "sending" ? (
              <>
                <h1 className="screen-heading text-3xl font-bold leading-tight">Sending to Muse</h1>
                <p className="density-hide-compact mt-3 text-base leading-relaxed">
                  After a credential is encrypted, how should it get to Muse?
                </p>
                <div className="mt-4 flex flex-col gap-3" role="radiogroup" aria-label="Sending to Muse">
                  <label
                    className={`flex min-h-[52px] cursor-pointer items-start gap-3 rounded-[var(--radius)] border px-4 py-3 ${
                      (prefs?.deliveryPref ?? "save") === "save"
                        ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                        : "border-[var(--border)] bg-[var(--surface)]"
                    }`}
                  >
                    <input
                      type="radio"
                      name="delivery-pref"
                      value="save"
                      checked={(prefs?.deliveryPref ?? "save") === "save"}
                      onChange={() => setPrefsMutation.mutate({ deliveryPref: "save" })}
                      className="mt-1 h-5 w-5 shrink-0 accent-[var(--accent)]"
                    />
                    <span>
                      <span className="block text-base font-medium">
                        Save to Muse directly{" "}
                        <span className="font-semibold text-[var(--accent)]">(Recommended)</span>
                      </span>
                      <span className="block text-sm text-[var(--dim)]">
                        Goes straight to Muse. Nothing lands in a chat or on your clipboard.
                      </span>
                      <span className="mt-1 block text-sm text-[var(--dim)]">
                        Saves to: {storeName} — the store you chose during setup. Ask your Muse
                        if you want to change it.
                      </span>
                    </span>
                  </label>
                  <label
                    className={`flex min-h-[52px] cursor-pointer items-start gap-3 rounded-[var(--radius)] border px-4 py-3 ${
                      prefs?.deliveryPref === "copy"
                        ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                        : "border-[var(--border)] bg-[var(--surface)]"
                    }`}
                  >
                    <input
                      type="radio"
                      name="delivery-pref"
                      value="copy"
                      checked={prefs?.deliveryPref === "copy"}
                      onChange={() => setPrefsMutation.mutate({ deliveryPref: "copy" })}
                      className="mt-1 h-5 w-5 shrink-0 accent-[var(--accent)]"
                    />
                    <span>
                      <span className="block text-base font-medium">Copy it and paste it in a chat</span>
                      <span className="block text-sm text-[var(--dim)]">
                        You'll copy the encrypted text and paste it into a chat yourself. It ends up
                        in whichever chat you paste it into, and clipboard apps can see what you
                        copy.
                      </span>
                    </span>
                  </label>
                </div>
                <p className="mt-4 text-base leading-relaxed">
                  One last thing: the next time you open the Lockbox, it will ask you to
                  confirm your copy of Muse's key — paste it in, and you're straight in.
                </p>
              </>
            ) : null}

            {screen.step === "other" ? (
              <>
                <h1 className="screen-heading text-3xl font-bold leading-tight">Other ways to encrypt</h1>
                <p className="other-text mt-4 text-base leading-relaxed">
                  This app is installed by default and works fully on its own. There is also an
                  optional utility for people who prefer a terminal: a script called handoff
                  (handoff.sh / handoff.ps1). It is another way to encrypt — it produces exactly
                  the same encrypted text as this page. It does not send anything: its output is
                  pasted into a chat, just like this page's Copy. You can use both — this app for
                  your phone, the script for your computer. Setting it up is separate and
                  optional.
                </p>
                <ol className="other-text mt-4 list-decimal space-y-2 pl-5 text-base leading-relaxed">
                  <li>
                    Download the Credential Lockbox release your Muse names.
                    <span className="block pl-2 text-sm font-normal text-[var(--dim)]">
                      The release number matters.
                    </span>
                  </li>
                  <li>
                    Install age if your computer doesn&apos;t have it.
                    <span className="block pl-2 text-sm font-normal text-[var(--dim)]">
                      The release&apos;s install page explains how.
                    </span>
                  </li>
                  <li>
                    Put Muse&apos;s key into the script&apos;s key file.
                    <span className="block pl-2 text-sm font-normal text-[var(--dim)]">
                      The key is on the key screen.
                    </span>
                  </li>
                  <li>
                    Run the script.
                    <span className="block pl-2 text-sm font-normal text-[var(--dim)]">
                      It asks for the service name and the credential, and prints the encrypted
                      text for you to paste into a chat.
                    </span>
                  </li>
                </ol>
                <p className="density-hide-compact mt-3 text-sm text-[var(--dim)]">
                  A short summary — the release&apos;s install pages have the full steps. The
                  script does its own key check during its setup; this app&apos;s check
                  doesn&apos;t cover the script&apos;s key file.
                </p>
              </>
            ) : null}
          </section>
        ) : screen.kind === "hub" ? (
          <section aria-label="Setup & reset" className="flex flex-1 flex-col">
            <h1 className="screen-heading text-3xl font-bold leading-tight">Setup &amp; reset</h1>
            {/* A settings-style list, not a button stack: plain text
                rows on the background, hairline dividers, small muted
                group headings, and one chevron on every row that goes
                somewhere. The web row leaves the app, so it keeps its
                ↗ instead. Reset sits in its own group at the bottom as
                a plain row in the danger colour. */}
            <h2 className="mt-5 text-sm font-semibold text-[var(--dim)]">Your key &amp; sending</h2>
            <div className="mt-1 divide-y divide-[var(--border)] border-y border-[var(--border)]">
              <button
                type="button"
                onClick={() => openFromHub({ kind: "setup", mode: "single", step: "key" })}
                className="hub-row flex w-full items-center justify-between gap-3 text-left text-lg"
              >
                <span>Your copy of Muse's key</span>
                <span aria-hidden="true" className="shrink-0 text-[var(--dim)]">›</span>
              </button>
              <button
                type="button"
                onClick={() => openFromHub({ kind: "setup", mode: "single", step: "about" })}
                className="hub-row flex w-full items-center justify-between gap-3 text-left text-lg"
              >
                <span>About the key</span>
                <span aria-hidden="true" className="shrink-0 text-[var(--dim)]">›</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setSubReturn({ kind: "hub" });
                  showKeyCheck("single");
                }}
                className="hub-row flex w-full items-center justify-between gap-3 text-left text-lg"
              >
                <span>Key check</span>
                <span aria-hidden="true" className="shrink-0 text-[var(--dim)]">›</span>
              </button>
              <button
                type="button"
                onClick={() => openFromHub({ kind: "setup", mode: "single", step: "sending" })}
                className="hub-row flex w-full items-center justify-between gap-3 text-left text-lg"
              >
                <span>Sending to Muse</span>
                <span aria-hidden="true" className="shrink-0 text-[var(--dim)]">›</span>
              </button>
            </div>
            <h2 className="mt-5 text-sm font-semibold text-[var(--dim)]">More</h2>
            <div className="mt-1 divide-y divide-[var(--border)] border-y border-[var(--border)]">
              <button
                type="button"
                onClick={() => openFromHub({ kind: "setup", mode: "single", step: "other" })}
                className="hub-row flex w-full items-center justify-between gap-3 text-left text-lg"
              >
                <span>Other ways to encrypt</span>
                <span aria-hidden="true" className="shrink-0 text-[var(--dim)]">›</span>
              </button>
              <button
                type="button"
                onClick={() => openFromHub({ kind: "sentitems" })}
                className="hub-row flex w-full items-center justify-between gap-3 text-left text-lg"
              >
                <span>Sent to Muse in this prototype</span>
                <span aria-hidden="true" className="shrink-0 text-[var(--dim)]">›</span>
              </button>
              <a
                href="https://credential-lockbox.github.io"
                target="_blank"
                rel="noreferrer"
                className="hub-row flex w-full items-center justify-between gap-3 text-left text-lg text-[var(--text)] no-underline"
              >
                <span>Credential Lockbox on the web ↗</span>
              </a>
            </div>
            <div className="mt-6 divide-y divide-[var(--border)] border-y border-[var(--border)]">
              <button
                type="button"
                onClick={() => openFromHub({ kind: "reset" })}
                className="hub-row flex w-full items-center justify-between gap-3 text-left text-lg text-[var(--bad)]"
              >
                <span>Reset this wizard</span>
                <span aria-hidden="true" className="shrink-0">›</span>
              </button>
            </div>
          </section>
        ) : screen.kind === "reset" ? (
          <section aria-label="Reset this wizard" className="flex flex-1 flex-col">
            <h1 className="screen-heading text-3xl font-bold leading-tight">Reset this wizard</h1>
            <div className="mt-5 rounded-[var(--radius)] border border-[var(--warn-border)] bg-[var(--warn-bg)] px-4 py-4">
              <p className="text-base text-[var(--warn-text)]">
                Resetting clears the confirmed key pin, your choice for sending to Muse, and
                the setup flag, and returns the wizard to its first-run state. It does not
                delete anything you've already sent to Muse — those are encrypted and waiting
                for Muse.
              </p>
              {resetArmed ? (
                <div className="mt-4">
                  <p className="text-base font-semibold text-[var(--warn-text)]">Are you sure?</p>
                  <div className="mt-3 flex gap-3">
                    <button
                      type="button"
                      onClick={handleReset}
                      disabled={resetMutation.isPending}
                      className="min-h-[48px] flex-1 rounded-full bg-[var(--bad)] px-5 text-base font-semibold text-white disabled:opacity-40"
                    >
                      {resetMutation.isPending ? "Resetting…" : "Reset"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setResetArmed(false)}
                      className="min-h-[48px] flex-1 rounded-full border border-[var(--warn-border)] px-5 text-base font-medium text-[var(--warn-text)]"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setResetArmed(true)}
                  className="mt-4 min-h-[48px] rounded-full border border-[var(--warn-border)] px-5 text-base font-semibold text-[var(--warn-text)]"
                >
                  Reset this wizard
                </button>
              )}
            </div>
          </section>
        ) : screen.kind === "keydetails" ? (
          <section aria-label="Key details" className="flex flex-1 flex-col">
            {!hasRecipient ? (
              renderWaitingForKey()
            ) : (
            <>
            <div>
              <h2 className="screen-heading text-base font-semibold text-[var(--text)]">
                Muse's key (delivered with this page)
              </h2>
              <div
                className="mt-2 select-none rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-4"
                style={{ userSelect: "none", WebkitUserSelect: "none" }}
                onCopy={(e) => e.preventDefault()}
                aria-label="Muse's key (delivered with this page)"
              >
                <p className="break-all font-mono text-lg leading-relaxed">
                  {museRecipient.trim()}
                </p>
              </div>
              <p className="mt-2 text-sm text-[var(--dim)]">
                This box can't be copied on purpose — paste your copy of Muse's key in the
                field on the key check so the check means something.
              </p>
            </div>
            <div className="mt-6">
              <h2 className="text-base font-semibold text-[var(--text)]">
                Your copy (what you pasted)
              </h2>
              <div className="mt-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-4">
                {recipientRaw ? (
                  <p className="break-all font-mono text-lg leading-relaxed">{recipientRaw}</p>
                ) : (
                  <p className="text-base text-[var(--dim)]">Nothing pasted yet</p>
                )}
              </div>
            </div>
            </>
            )}
          </section>
        ) : screen.kind === "sentitems" ? (
          <section aria-label="Sent to Muse in this prototype" className="flex flex-1 flex-col">
            <h1 className="screen-heading text-3xl font-bold leading-tight">Sent to Muse in this prototype</h1>
            <p className="mt-2 text-sm text-[var(--dim)]">Test items only.</p>
            {(savedList.data?.items ?? []).length === 0 ? (
              <p className="mt-3 text-base text-[var(--dim)]">Nothing sent yet.</p>
            ) : null}
            {/* Stacked rows (item B): the item's name on its own
                line, then the hash on its own line, then the date on
                its own line — nothing is squeezed onto one line or
                ellipsised, and the list flows in the content region,
                which scrolls as a whole, so every card renders whole
                and every item is reachable. */}
            <ul className="sent-list mt-3 flex flex-col gap-2">
              {(savedList.data?.items ?? []).map((item) => (
                <li
                  key={item.id}
                  className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-3"
                >
                  <span className="block font-medium">{item.label}</span>
                  <span className="mt-1 block font-mono text-xs text-[var(--dim)]">{item.sha256Short}…</span>
                  {item.recipientHashShort ? (
                    <span className="mt-1 block font-mono text-xs text-[var(--dim)]">
                      Key hash: {item.recipientHashShort}…
                    </span>
                  ) : null}
                  <span className="mt-1 block text-xs text-[var(--dim)]">{formatTime(item.createdAt)}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : screen.kind === "aboutbuild" ? (
          <section aria-label="About this build" className="flex flex-1 flex-col">
            <h1 className="screen-heading text-3xl font-bold leading-tight">About this build</h1>
            <p className="mt-4 text-base leading-relaxed">
              The version is{" "}
              <span className="font-mono font-semibold">{BUILD_FINGERPRINT}</span> — the release
              this page was built from. It sits in the bottom bar of every screen, so any
              screenshot of this page shows which version it came from.
            </p>
            <p className="mt-3 text-base leading-relaxed">
              Under it is the build checksum,{" "}
              <span className="font-mono font-semibold">{BUILD_HASH}</span> — a short fingerprint
              of the exact code in this build. Two pages can share a version number, but the
              checksum only matches when the code is identical, so a screenshot identifies the
              build precisely.
            </p>
            <p className="mt-3 text-base leading-relaxed">
              Sometimes the checksum line also says{" "}
              <span className="font-semibold">“custom”</span>
              {isCustomBuild ? " — and this copy says it now" : ""}. That means this copy's code
              differs from the release it was built from, usually because you or your Muse
              changed it on purpose. If yours says “custom” and you don't know why, ask your
              Muse before sending anything.
            </p>
            <p className="mt-3 text-base leading-relaxed">
              This page doesn't check for new versions — your Muse does, and tells you in chat
              when one is available.
            </p>
          </section>
        ) : screen.kind === "receipt" ? (
          <section aria-label="Receipt" className="flex flex-1 flex-col">
            <h1 className="screen-heading text-3xl font-bold leading-tight">It's encrypted and saved</h1>
            {receipt ? (
              <div className="receipt-card mt-5 rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--accent-soft)] px-4 py-4" role="status">
                <h2 className="text-lg font-semibold">Sent to Muse directly</h2>
                <dl className="receipt-dl mt-2 text-base">
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="shrink-0 whitespace-nowrap text-[var(--dim)]">Service:</dt>
                    <dd className="min-w-0 break-words text-right font-medium">{receipt.label}</dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="shrink-0 whitespace-nowrap text-[var(--dim)]">Saved to:</dt>
                    <dd className="min-w-0 break-words text-right font-medium">{storeName}</dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="shrink-0 whitespace-nowrap text-[var(--dim)]">Fingerprint:</dt>
                    <dd className="min-w-0 truncate font-mono text-sm">{receipt.sha256Short}…</dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="shrink-0 whitespace-nowrap text-[var(--dim)]">Saved at:</dt>
                    <dd className="min-w-0 text-right">{formatTime(receipt.createdAt)}</dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="shrink-0 whitespace-nowrap text-[var(--dim)]">Status:</dt>
                    <dd className="min-w-0 text-right font-medium">{receipt.status}</dd>
                  </div>
                </dl>
                <p className="mt-3 text-sm text-[var(--dim)]">
                  Tell your Muse the service name — “{receipt.label}” — and it can fetch what
                  you sent.
                </p>
              </div>
            ) : null}
          </section>
        ) : (
          <>
        {screen.kind === "encrypt" && screen.step === 1 && (
          <section aria-label="Service" className="flex flex-1 flex-col">
            {!hasRecipient ? (
              // No delivered or persisted key: the Encrypt flow cannot
              // start — the waiting state shows instead of the form.
              renderWaitingForKey()
            ) : (
            <>
            <h1 className="screen-heading text-3xl font-bold leading-tight">Which service is this for?</h1>
            <div className="mt-4">
              <label htmlFor="svc-input" className={labelClass}>
                Service name <span className="font-normal text-[var(--dim)]">(required)</span>
              </label>
              <input
                id="svc-input"
                {...FIELDS.depositBlob.label}
                value={svc}
                onChange={handleServiceChange}
                className={inputClass}
                autoComplete="off"
                placeholder="e.g. github, cloudflare, discord"
                aria-describedby="svc-help"
              />
              <div id="svc-help" className="mt-2 text-sm text-[var(--dim)]">
                <p>Lowercase letters, numbers and hyphens — the exact name your Muse will use to fetch this.</p>
                <p className="mt-1">
                  If your Muse gave you a label, use it exactly. If not, pick a name and tell
                  your Muse what you used.
                </p>
              </div>
              {svc.length >= SERVICE_CAP ? (
                <p className="mt-2 text-sm font-medium text-[var(--warn-text)]" role="status">
                  Maximum length reached
                </p>
              ) : null}
            </div>
            <fieldset className="mt-5">
              <legend className="density-hide-micro text-base font-medium">What kind of credential is it?</legend>
              <div className="type-grid mt-3 flex flex-col gap-2">
                {TYPE_OPTIONS.map((option) => (
                  <label
                    key={option.value}
                    className={`flex min-h-[52px] cursor-pointer items-start gap-3 rounded-[var(--radius)] border px-4 py-2 ${
                      credType === option.value
                        ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                        : "border-[var(--border)] bg-[var(--surface)]"
                    }`}
                  >
                    <input
                      type="radio"
                      name="cred-type"
                      value={option.value}
                      checked={credType === option.value}
                      onChange={() => setCredType(option.value)}
                      className="mt-1 h-5 w-5 shrink-0 accent-[var(--accent)]"
                    />
                    <span>
                      <span className="block text-base font-medium">{option.label}</span>
                      <span className="density-hide-compact block text-sm text-[var(--dim)]">{option.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            </>
            )}
          </section>
        )}

        {screen.kind === "encrypt" && screen.step === 2 && (
          <section
            aria-label="Details"
            className={`flex flex-1 flex-col ${credType === "pem" ? "pem-step" : ""}`}
          >
            <h1 className="screen-heading text-3xl font-bold leading-tight">Enter the details</h1>
            <p className="density-hide-compact mt-3 text-base leading-relaxed">
              Only the fields for a {TYPE_OPTIONS.find((o) => o.value === credType)?.label.toLowerCase()}{" "}
              are shown.
            </p>
            <div className="fields-col mt-5 flex flex-col gap-4">
              {fieldDefs.map((def) => {
                const value = values[def.key] ?? "";
                return (
                  <div key={def.key}>
                    <label htmlFor={`field-${def.key}`} className={labelClass}>
                      {def.label}
                      {def.optional ? (
                        <span className="font-normal text-[var(--dim)]"> (optional)</span>
                      ) : (
                        <span className="font-normal text-[var(--dim)]"> (required)</span>
                      )}
                    </label>
                    {def.multiline ? (
                      <textarea
                        id={`field-${def.key}`}
                        value={value}
                        onChange={(e) => handleFieldChange(def, e.target.value)}
                        rows={5}
                        spellCheck={false}
                        className={`${inputClass} font-mono text-sm`}
                        placeholder="-----BEGIN PRIVATE KEY-----"
                      />
                    ) : (
                      <input
                        id={`field-${def.key}`}
                        type={def.secret ? "password" : "text"}
                        value={value}
                        onChange={(e) => handleFieldChange(def, e.target.value)}
                        className={inputClass}
                        autoComplete="off"
                      />
                    )}
                    {def.hint ? (
                      <p className="mt-2 text-sm text-[var(--dim)]">{def.hint}</p>
                    ) : null}
                    {def.key === "password" && credType === "userpass" ? (
                      // The strength meter (proto-wizard-1.2): standing
                      // furniture directly under the password field,
                      // always visible for this credential type only.
                      // Position carries the meaning — the pointer
                      // travels the red→green track as the length/variety
                      // score rises. Empty field: grey track, pointer
                      // parked at the left end. It never blocks Next.
                      <div
                        className={`strength-meter mt-3${value === "" ? " strength-meter-empty" : ""}`}
                        role="img"
                        aria-label={
                          value === ""
                            ? "Password strength: nothing entered yet"
                            : "Password strength meter — the further right the marker, the stronger the password"
                        }
                      >
                        <div className="strength-track" aria-hidden="true" />
                        <div
                          className="strength-pointer"
                          aria-hidden="true"
                          style={{
                            left: `calc(0.5rem + ${passwordStrength(value)} * (100% - 1rem))`,
                          }}
                        />
                      </div>
                    ) : null}
                    {def.key === "private_key" && pemInvalid ? (
                      <p className="mt-2 text-base font-medium text-[var(--bad)]" role="alert">
                        This looks like a public key, not a private key.
                      </p>
                    ) : null}
                    {value.length >= def.cap ? (
                      <p className="mt-2 text-sm font-medium text-[var(--warn-text)]" role="status">
                        Maximum length reached
                      </p>
                    ) : null}
                    {def.key === "private_key" ? (
                      <div className="mt-3">
                        <button
                          type="button"
                          onClick={() => pemFileRef.current?.click()}
                          className="min-h-[48px] rounded-full border border-[var(--border)] bg-[var(--surface)] px-5 text-base font-medium"
                        >
                          Browse...
                        </button>
                        <input
                          ref={pemFileRef}
                          type="file"
                          accept=".pem,.key"
                          className="hidden"
                          aria-label="Choose a private key file"
                          onChange={handlePemFile}
                        />
                        <p className="density-hide-compact mt-2 text-sm text-[var(--dim)]">
                          {pemFileName || "The file is read on this device only — or paste the key above."}
                        </p>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>

            <div className="summary-box density-hide-tight mt-5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
              <h2 className="text-base font-semibold">What will be encrypted</h2>
              <p className="density-hide-compact mt-1 text-sm text-[var(--dim)]">
                Shown here: names and sizes only. The values are encrypted too — they never
                appear in this list.
              </p>
              <ul className="summary-rows mt-3">
                {payloadRows.map((row) => (
                  <li key={row.key} className="flex items-baseline justify-between gap-4">
                    <span className="shrink-0 text-base">{row.label}:</span>
                    <span
                      className={`whitespace-nowrap text-sm ${row.value === "" && row.required ? "font-medium text-[var(--bad)]" : "text-[var(--dim)]"}`}
                    >
                      {row.value === ""
                        ? row.required
                          ? "empty — needed"
                          : row.includeEmpty
                            ? "0 bytes"
                            : "empty — left out"
                        : `${byteLen(row.value)} ${byteLen(row.value) === 1 ? "byte" : "bytes"}`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}

        {screen.kind === "encrypt" && screen.step === 3 && (
          <section aria-label="Review and encrypt" className="flex flex-1 flex-col">
            <h1 className="screen-heading text-3xl font-bold leading-tight">One last look</h1>
            <p className="density-hide-compact mt-3 text-lg leading-relaxed">
              When you're ready, tap Encrypt. The encryption happens here, on this device.
            </p>
            <div className="review-card mt-5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
              <dl className="review-dl flex flex-col gap-3">
                <div>
                  <dt className="text-sm text-[var(--dim)]">Service:</dt>
                  <dd className="text-lg font-medium">{svc.trim()}</dd>
                </div>
                <div>
                  <dt className="text-sm text-[var(--dim)]">What's inside:</dt>
                  <dd>
                    <ul className="mt-1 flex flex-col gap-1">
                      {payloadRows
                        .filter((row) => row.key !== "svc" && (row.value !== "" || row.includeEmpty))
                        .map((row) => (
                          <li key={row.key} className="flex items-baseline justify-between gap-4">
                            <span className="text-base">{row.label}:</span>
                            <span className="text-sm text-[var(--dim)]">
                              {byteLen(row.value)} {byteLen(row.value) === 1 ? "byte" : "bytes"}
                            </span>
                          </li>
                        ))}
                    </ul>
                  </dd>
                </div>
              </dl>
            </div>
            {encryptError ? (
              <p className="mt-4 text-base font-medium text-[var(--bad)]" role="alert">
                {encryptError}
              </p>
            ) : null}
          </section>
        )}

        {screen.kind === "encrypt" && screen.step === 4 && (
          <section aria-label="Delivery" className="flex flex-1 flex-col">
            <h1 className="screen-heading text-3xl font-bold leading-tight">It's encrypted</h1>
            <p className="density-hide-compact mt-3 text-base leading-relaxed">
              This is the encrypted text. On its own it reveals nothing — save it to Muse
              directly, or copy it and paste it into a Muse chat.
            </p>
            <div className="mt-4">
              <label htmlFor="blob-output" className={labelClass}>
                Your encrypted text:
              </label>
              {/* Sized in whole lines (rows × line-height, no fixed
                  pixel height anywhere in the density ladder), so the
                  field's visible region never slices a line of the
                  blob mid-glyph (item B). Longer blobs scroll inside
                  the field, a whole line at a time. */}
              <textarea
                id="blob-output"
                {...FIELDS.depositBlob.blob}
                value={blob}
                readOnly
                onCopy={() => {
                  recordCompletionOnce();
                }}
                rows={4}
                spellCheck={false}
                className={`${inputClass} break-all font-mono text-xs leading-relaxed`}
              />
              <p className="density-hide-micro mt-2 font-mono text-sm text-[var(--accent)]">{checkLine}</p>
            </div>

            <div className="mt-5 flex flex-col gap-3">
              {deliveryPref === "save" ? (
                <>
                  {saveDeliveryButton}
                  {copyDeliveryButton}
                </>
              ) : (
                <>
                  {copyDeliveryButton}
                  {saveDeliveryButton}
                </>
              )}
            </div>
          </section>
        )}
          </>
        )}

        {nav?.hint ? (
          <p className="mt-3 shrink-0 text-center text-sm text-[var(--dim)]">{nav.hint}</p>
        ) : null}
        {/* Worst-case nav fallback (item G): at the tightest density
            tier the build label leaves the nav bar (the buttons keep
            the full bar at usable sizes) and appears here, at the
            bottom of the screen's content, visible when scrolled to.
            Hidden at every other tier — see theme.css. */}
        <button
          type="button"
          onClick={openAboutBuild}
          aria-label="About this build"
          className="provenance-block provenance-fallback mt-6 flex-col justify-center leading-tight"
        >
          <span className="whitespace-nowrap text-xs font-medium text-[var(--dim)]">{BUILD_FINGERPRINT}</span>
          <span className="provenance-hash font-mono text-[10px] text-[var(--dim)]">
            {BUILD_HASH}
            {isCustomBuild ? " · custom" : ""}
          </span>
        </button>
      </main>
      {/* Fixed bottom stack: the screen's Back/Next bar, with the small
          provenance block at its left — version on the first line, the
          short build hash (plus "· custom" when the self-check fails)
          on the second. The block is capped at the buttons' height so
          the bar never grows taller, and the buttons keep width
          priority: on narrow screens the hash truncates rather than
          squeezing the buttons. The stack reserves the bottom safe-area
          inset so nothing is clipped by a gesture bar or app chrome. */}
      <div
        className="shrink-0"
        style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      >
        {nav ? (
          <div className="mx-auto flex w-full max-w-xl items-center gap-3 px-5 pb-1 pt-2">
            <button
              type="button"
              onClick={openAboutBuild}
              aria-label="About this build"
              className="provenance-block provenance-inbar flex shrink-0 flex-col justify-center leading-tight"
            >
              <span className="whitespace-nowrap text-xs font-medium text-[var(--dim)]">{BUILD_FINGERPRINT}</span>
              <span className="provenance-hash font-mono text-[10px] text-[var(--dim)]">
                {BUILD_HASH}
                {isCustomBuild ? " · custom" : ""}
              </span>
            </button>
            <div className="min-w-0 flex-1">
              {nav.single ? (
                <button
                  type="button"
                  onClick={nav.single.onClick}
                  className={nav.single.primary ? navSinglePrimaryClass : navSingleClass}
                >
                  {nav.single.label}
                </button>
              ) : nav.triple ? (
                <div className="flex gap-3">
                  {nav.triple.map((btn) => (
                    <button
                      key={btn.label}
                      type="button"
                      onClick={btn.onClick}
                      disabled={btn.disabled}
                      className={btn.primary ? navNextClass : navThirdClass}
                    >
                      {btn.label}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="flex gap-3">
                  {nav.back ? (
                    <button type="button" onClick={nav.back.onClick} className={navBackClass}>
                      {nav.back.label}
                    </button>
                  ) : null}
                  {nav.next ? (
                    <button
                      type="button"
                      onClick={nav.next.onClick}
                      disabled={nav.next.disabled}
                      className={navNextClass}
                    >
                      {nav.next.label}
                    </button>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
      </div>
    </div>
  );
}
