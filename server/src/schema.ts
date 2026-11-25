// Drizzle schema for this space: the prototype blob store.
//
// One table, `saved_blobs`, holding CIPHERTEXT ONLY. The deposit action
// shape-checks the blob server-side before insert; no plaintext credential
// field ever reaches an action, so none can be stored here.

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const savedBlobs = sqliteTable("saved_blobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  label: text("label").notNull(),
  blob: text("blob").notNull(),
  sha256: text("sha256").notNull(),
  // SHA-256 hash of the recipient the client encrypted this blob to,
  // supplied by the client at deposit time. Null for items saved
  // before the recipient was recorded per save.
  recipientHash: text("recipient_hash"),
  status: text("status", { enum: ["staged"] }).notNull().default("staged"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Wizard preferences: a single row (id = 1) holding the skip/restore state.
// Stores NO credential values — the recipient is a public key, and only its
// SHA-256 hash is kept here.
export const wizardPrefs = sqliteTable("wizard_prefs", {
  id: integer("id").primaryKey(),
  skipWelcome: integer("skip_welcome", { mode: "boolean" }).notNull().default(false),
  skipKeyCheck: integer("skip_key_check", { mode: "boolean" }).notNull().default(false),
  confirmedRecipientHash: text("confirmed_recipient_hash"),
  confirmedBuildFingerprint: text("confirmed_build_fingerprint"),
  completions: integer("completions").notNull().default(0),
  lastKeyCheckAt: integer("last_key_check_at", { mode: "timestamp_ms" }),
  setupCompleted: integer("setup_completed", { mode: "boolean" }).notNull().default(false),
  deliveryPref: text("delivery_pref", { enum: ["save", "copy"] }).notNull().default("save"),
  // Set whenever a key is delivered for saving (a completed setup
  // handover, or a changed key arriving through the Delivery Slot);
  // cleared only by a successful key-check match. While set, the next
  // launch opens on the key check as a gate before Encrypt Step 1.
  confirmationPending: integer("confirmation_pending", { mode: "boolean" }).notNull().default(false),
  // The setupVersion of the Setup flow the user last completed. Setup
  // re-runs at launch when this differs from the current build's
  // setupVersion (held in release_info) — a bundle fingerprint change
  // alone no longer re-runs setup.
  completedSetupVersion: text("completed_setup_version"),
});

// Release info: a single row (id = 1) the agent maintains — the latest
// released build version, whether that release is an "update" (fixes and
// small improvements, behavior unchanged) or an "upgrade" (changes how
// some things work), an optional note, and the name of the store behind
// "Save to Muse directly" (the user's choice, made during setup with
// Muse from the stores Muse checked and presented; the page displays
// it, never offers it as a picker in the Space). The page
// compares the version against its own build fingerprint on load. No
// credential data of any kind.
export const releaseInfo = sqliteTable("release_info", {
  id: integer("id").primaryKey(),
  latestVersion: text("latest_version").notNull(),
  releaseKind: text("release_kind", { enum: ["update", "upgrade"] }).notNull().default("update"),
  releaseNote: text("release_note"),
  storeName: text("store_name").notNull().default("Muse's store (prototype)"),
  // The version of the Setup flow itself. The page re-runs Setup at
  // launch only when the user's completed setupVersion differs from
  // this (or a key change / pending confirmation intervenes).
  setupVersion: text("setup_version").notNull().default("2"),
});

// Delivery Slot: a single one-shot record (id = 1) Muse writes from
// outside the page — the recipient key to deliver with the next launch,
// plus an optional service label to pre-fill on Encrypt Step 1. The app
// reads and clears it at launch, so a delivery is consumed exactly
// once. Holds a PUBLIC key only — never a credential or a private key.
export const deliverySlot = sqliteTable("delivery_slot", {
  id: integer("id").primaryKey(),
  recipient: text("recipient"),
  serviceLabel: text("service_label"),
  writtenAt: integer("written_at", { mode: "timestamp_ms" }),
});

// Persisted recipient: a single row (id = 1) holding the recipient most
// recently delivered through the Delivery Slot, kept across launches so
// the app encrypts to the delivered key — never a built-in fallback —
// on every launch, not only the one that consumed the delivery. Holds
// a PUBLIC key only. The value is returned to the client only through
// the consume-at-launch path; status and prefs actions expose at most
// its hash.
export const persistedRecipient = sqliteTable("persisted_recipient", {
  id: integer("id").primaryKey(),
  recipient: text("recipient"),
  writtenAt: integer("written_at", { mode: "timestamp_ms" }),
});
