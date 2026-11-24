// Actions for the Credential Lockbox Wizard Prototype store.
//
// Ciphertext ONLY: every action here deals in base64 age blobs and their
// metadata. No action accepts, returns (except fetchBlob, which returns the
// ciphertext itself for the exact label), or stores any plaintext credential
// field. depositBlob re-runs the Ciphertext Intake shape checks server-side
// before anything is stored.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { desc, eq } from "drizzle-orm";
import * as schema from "./schema";

const AGE_HEADER = "age-encryption.org/v1";

/**
 * Shape-check a candidate blob the same way Ciphertext Intake does.
 * Returns an error message, or null when the blob is well-formed.
 */
function blobShapeError(blob: string): string | null {
  if (blob.length < 200 || blob.length > 65536) {
    return `Blob must be 200–65536 characters long (got ${blob.length}).`;
  }
  // Printable ASCII only (base64 alphabet plus padding, single line).
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) {
    return "Blob must be a single line of base64 characters.";
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(blob, "base64");
  } catch {
    return "Blob does not base64-decode.";
  }
  // Canonical round-trip: rejects padding/alphabet tricks Buffer tolerates.
  if (decoded.toString("base64") !== blob) {
    return "Blob is not canonical base64.";
  }
  const head = decoded.subarray(0, 4096).toString("latin1");
  const headerEnd = head.indexOf("\n---");
  if (headerEnd === -1) {
    return "Blob has no complete age header.";
  }
  const lines = head.slice(0, headerEnd).split("\n");
  if (lines[0] !== AGE_HEADER) {
    return "Blob does not start with the age v1 header.";
  }
  const stanzas = lines.filter((line) => line.startsWith("-> "));
  if (stanzas.length !== 1 || !stanzas[0]?.startsWith("-> X25519 ")) {
    return "Blob must have exactly one X25519 recipient stanza.";
  }
  return null;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

type WizardPrefsRow = typeof schema.wizardPrefs.$inferSelect;

const DEFAULT_PREFS: WizardPrefsRow = {
  id: 1,
  skipWelcome: false,
  skipKeyCheck: false,
  confirmedRecipientHash: null,
  confirmedBuildFingerprint: null,
  completions: 0,
  lastKeyCheckAt: null,
  setupCompleted: false,
  deliveryPref: "save",
  confirmationPending: false,
  completedSetupVersion: null,
};

async function loadPrefs(ctx: Ctx): Promise<WizardPrefsRow> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.wizardPrefs)
    .where(eq(schema.wizardPrefs.id, 1))
    .limit(1);
  if (rows[0]) return rows[0];
  await db.insert(schema.wizardPrefs).values({ id: 1 }).onConflictDoNothing();
  const again = await db
    .select()
    .from(schema.wizardPrefs)
    .where(eq(schema.wizardPrefs.id, 1))
    .limit(1);
  return again[0] ?? DEFAULT_PREFS;
}

function prefsResponse(row: WizardPrefsRow) {
  return {
    skipWelcome: row.skipWelcome,
    skipKeyCheck: row.skipKeyCheck,
    confirmedRecipientHash: row.confirmedRecipientHash,
    confirmedBuildFingerprint: row.confirmedBuildFingerprint,
    completions: row.completions,
    lastKeyCheckAt: row.lastKeyCheckAt ? row.lastKeyCheckAt.toISOString() : null,
    setupCompleted: row.setupCompleted,
    deliveryPref: row.deliveryPref,
    confirmationPending: row.confirmationPending,
    completedSetupVersion: row.completedSetupVersion,
  };
}

const prefsShape = z.object({
  skipWelcome: z.boolean(),
  skipKeyCheck: z.boolean(),
  confirmedRecipientHash: z.string().nullable(),
  confirmedBuildFingerprint: z.string().nullable(),
  completions: z.number(),
  lastKeyCheckAt: z.string().nullable(),
  setupCompleted: z.boolean(),
  deliveryPref: z.enum(["save", "copy"]),
  confirmationPending: z.boolean(),
  completedSetupVersion: z.string().nullable(),
});

type ReleaseInfoRow = typeof schema.releaseInfo.$inferSelect;

/** The build version this server code ships with. The release-info row is
 * seeded to match it, so a fresh install reports "no release available". */
const CURRENT_BUILD_VERSION = "proto-wizard-1.5";

/** The version of the Setup flow this build ships. Setup re-runs at
 * launch only when the user's completed setupVersion differs from it
 * (or a key change / pending confirmation intervenes). */
const CURRENT_SETUP_VERSION = "2";

const DEFAULT_STORE_NAME = "Muse's store (prototype)";

const DEFAULT_RELEASE: ReleaseInfoRow = {
  id: 1,
  latestVersion: CURRENT_BUILD_VERSION,
  releaseKind: "update",
  releaseNote: null,
  storeName: DEFAULT_STORE_NAME,
  setupVersion: CURRENT_SETUP_VERSION,
};

async function loadReleaseInfo(ctx: Ctx): Promise<ReleaseInfoRow> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.releaseInfo)
    .where(eq(schema.releaseInfo.id, 1))
    .limit(1);
  if (rows[0]) return rows[0];
  await db
    .insert(schema.releaseInfo)
    .values({
      id: 1,
      latestVersion: CURRENT_BUILD_VERSION,
      releaseKind: "update",
      releaseNote: null,
      storeName: DEFAULT_STORE_NAME,
      setupVersion: CURRENT_SETUP_VERSION,
    })
    .onConflictDoNothing();
  const again = await db
    .select()
    .from(schema.releaseInfo)
    .where(eq(schema.releaseInfo.id, 1))
    .limit(1);
  return again[0] ?? DEFAULT_RELEASE;
}

const releaseShape = z.object({
  latestVersion: z.string(),
  releaseKind: z.enum(["update", "upgrade"]),
  releaseNote: z.string().nullable(),
  storeName: z.string(),
  setupVersion: z.string(),
});

function releaseResponse(row: ReleaseInfoRow) {
  return {
    latestVersion: row.latestVersion,
    releaseKind: row.releaseKind,
    releaseNote: row.releaseNote,
    storeName: row.storeName || DEFAULT_STORE_NAME,
    setupVersion: row.setupVersion || CURRENT_SETUP_VERSION,
  };
}

/** Shape-check a candidate recipient (an age X25519 public key) the same
 * way the page does. Returns an error message, or null when well-formed. */
function recipientShapeError(recipient: string): string | null {
  if (!recipient.startsWith("age1")) {
    return "Recipient must be an age public key (it starts with “age1”).";
  }
  if (recipient.length !== 62) {
    return `Recipient must be 62 characters long (got ${recipient.length}).`;
  }
  if (!/^age1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/.test(recipient)) {
    return "Recipient contains a character that doesn't belong in an age key.";
  }
  return null;
}

type DeliverySlotRow = typeof schema.deliverySlot.$inferSelect;

async function loadDeliverySlot(ctx: Ctx): Promise<DeliverySlotRow | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.deliverySlot)
    .where(eq(schema.deliverySlot.id, 1))
    .limit(1);
  return rows[0] ?? null;
}

const receiptShape = z.object({
  label: z.string(),
  sha256: z.string(),
  sha256Short: z.string(),
  createdAt: z.string(),
  status: z.string(),
});

export const Actions = {
  depositBlob: defineAction({
    description:
      "Stores one base64 age ciphertext blob (ciphertext only, shape-checked) under a service label in the prototype store and returns a receipt.",
    request: z.object({
      label: z.string().trim().min(1).max(200),
      blob: z.string().min(1).max(65536),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      receipt: receiptShape.nullable(),
    }),
    async handler(ctx, args) {
      const shapeError = blobShapeError(args.blob);
      if (shapeError) {
        return { ok: false, error: shapeError, receipt: null };
      }
      const sha256 = await sha256Hex(args.blob);
      const db = ctx.db<typeof schema>();
      const result = await db
        .insert(schema.savedBlobs)
        .values({ label: args.label, blob: args.blob, sha256, status: "staged" })
        .returning({ createdAt: schema.savedBlobs.createdAt });
      const inserted = result[0];
      if (!inserted) {
        return { ok: false, error: "The store did not accept the blob.", receipt: null };
      }
      ctx.invalidateQueries();
      return {
        ok: true,
        error: null,
        receipt: {
          label: args.label,
          sha256,
          sha256Short: sha256.slice(0, 16),
          createdAt: inserted.createdAt.toISOString(),
          status: "staged",
        },
      };
    },
  }),

  fetchBlob: defineAction({
    description:
      "Returns the staged ciphertext blob saved under one exact service label, or found:false when no blob is stored under that label.",
    request: z.object({
      label: z.string().trim().min(1).max(200),
    }),
    response: z.object({
      found: z.boolean(),
      label: z.string(),
      blob: z.string().nullable(),
      sha256: z.string().nullable(),
      createdAt: z.string().nullable(),
      status: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.savedBlobs)
        .where(eq(schema.savedBlobs.label, args.label))
        .orderBy(desc(schema.savedBlobs.id))
        .limit(1);
      const row = rows[0];
      if (!row) {
        return {
          found: false,
          label: args.label,
          blob: null,
          sha256: null,
          createdAt: null,
          status: null,
        };
      }
      return {
        found: true,
        label: row.label,
        blob: row.blob,
        sha256: row.sha256,
        createdAt: row.createdAt.toISOString(),
        status: row.status,
      };
    },
  }),

  listSaved: defineAction({
    description:
      "Lists metadata only (label, short blob hash, saved time, status) for blobs in the prototype store — never blob contents.",
    request: z.object({
      limit: z.number().int().positive().max(100).default(20),
    }),
    response: z.object({
      items: z.array(
        z.object({
          id: z.number(),
          label: z.string(),
          sha256Short: z.string(),
          createdAt: z.string(),
          status: z.string(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select({
          id: schema.savedBlobs.id,
          label: schema.savedBlobs.label,
          sha256: schema.savedBlobs.sha256,
          createdAt: schema.savedBlobs.createdAt,
          status: schema.savedBlobs.status,
        })
        .from(schema.savedBlobs)
        .orderBy(desc(schema.savedBlobs.id))
        .limit(args.limit);
      return {
        items: rows.map((row) => ({
          id: row.id,
          label: row.label,
          sha256Short: row.sha256.slice(0, 16),
          createdAt: row.createdAt.toISOString(),
          status: row.status,
        })),
      };
    },
  }),

  getWizardPrefs: defineAction({
    description:
      "Returns the wizard's skip/restore preferences (skip toggles, confirmed recipient hash, confirmed build fingerprint, completion count, last key-check time). Stores no credential values.",
    request: z.object({}),
    response: prefsShape,
    async handler(ctx) {
      const row = await loadPrefs(ctx);
      return prefsResponse(row);
    },
  }),

  setWizardPrefs: defineAction({
    description:
      "Updates the wizard's skip/restore preferences: either skip toggle, and — when the user confirms the recipient key — the recipient's SHA-256 hash, the build fingerprint, and the key-check time.",
    request: z.object({
      skipWelcome: z.boolean().optional(),
      skipKeyCheck: z.boolean().optional(),
      confirmedRecipientHash: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .nullable()
        .optional(),
      confirmedBuildFingerprint: z.string().max(100).nullable().optional(),
      lastKeyCheckAt: z.string().max(40).nullable().optional(),
      setupCompleted: z.boolean().optional(),
      deliveryPref: z.enum(["save", "copy"]).optional(),
      confirmationPending: z.boolean().optional(),
      completedSetupVersion: z.string().max(40).nullable().optional(),
    }),
    response: prefsShape,
    async handler(ctx, args) {
      await loadPrefs(ctx);
      const patch: Partial<WizardPrefsRow> = {};
      if (args.skipWelcome !== undefined) patch.skipWelcome = args.skipWelcome;
      if (args.skipKeyCheck !== undefined) patch.skipKeyCheck = args.skipKeyCheck;
      if (args.setupCompleted !== undefined) patch.setupCompleted = args.setupCompleted;
      if (args.deliveryPref !== undefined) patch.deliveryPref = args.deliveryPref;
      if (args.confirmationPending !== undefined) {
        patch.confirmationPending = args.confirmationPending;
      }
      if (args.completedSetupVersion !== undefined) {
        patch.completedSetupVersion = args.completedSetupVersion;
      }
      if (args.confirmedRecipientHash !== undefined) {
        patch.confirmedRecipientHash = args.confirmedRecipientHash;
      }
      if (args.confirmedBuildFingerprint !== undefined) {
        patch.confirmedBuildFingerprint = args.confirmedBuildFingerprint;
      }
      if (args.lastKeyCheckAt !== undefined) {
        patch.lastKeyCheckAt = args.lastKeyCheckAt ? new Date(args.lastKeyCheckAt) : null;
      }
      const db = ctx.db<typeof schema>();
      if (Object.keys(patch).length > 0) {
        await db
          .update(schema.wizardPrefs)
          .set(patch)
          .where(eq(schema.wizardPrefs.id, 1));
      }
      const row = await loadPrefs(ctx);
      ctx.invalidateQueries();
      return prefsResponse(row);
    },
  }),

  recordCompletion: defineAction({
    description:
      "Records one finished encryption (the user copied or saved the blob on the delivery screen), incrementing the wizard's completion count, and returns the updated preferences.",
    request: z.object({}),
    response: prefsShape,
    async handler(ctx) {
      const current = await loadPrefs(ctx);
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.wizardPrefs)
        .set({ completions: current.completions + 1 })
        .where(eq(schema.wizardPrefs.id, 1));
      const row = await loadPrefs(ctx);
      ctx.invalidateQueries();
      return prefsResponse(row);
    },
  }),

  resetWizardPrefs: defineAction({
    description:
      "Resets the wizard to first-run state: clears the confirmed recipient pin, both skip settings, the delivery preference, and the setup flag. Saved blobs are NOT touched — they are encrypted and staged for Muse.",
    request: z.object({}),
    response: prefsShape,
    async handler(ctx) {
      await loadPrefs(ctx);
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.wizardPrefs)
        .set({
          skipWelcome: false,
          skipKeyCheck: false,
          confirmedRecipientHash: null,
          confirmedBuildFingerprint: null,
          lastKeyCheckAt: null,
          setupCompleted: false,
          deliveryPref: "save",
          confirmationPending: false,
          completedSetupVersion: null,
        })
        .where(eq(schema.wizardPrefs.id, 1));
      const row = await loadPrefs(ctx);
      ctx.invalidateQueries();
      return prefsResponse(row);
    },
  }),

  getReleaseInfo: defineAction({
    description:
      "Returns the release info the agent maintains: the expected build fingerprint (the page compares it against its own for the provenance line's 'custom' self-check), whether the release is an update or an upgrade, an optional note, and the name of the store behind 'Save to Muse directly', which the page displays.",
    request: z.object({}),
    response: releaseShape,
    async handler(ctx) {
      const row = await loadReleaseInfo(ctx);
      return releaseResponse(row);
    },
  }),

  setReleaseInfo: defineAction({
    description:
      "Sets the latest released build info (version, update-vs-upgrade kind, optional note, and optionally the store name shown for 'Save to Muse directly') that the page's release check compares against its own build fingerprint.",
    request: z.object({
      latestVersion: z.string().trim().min(1).max(100),
      releaseKind: z.enum(["update", "upgrade"]),
      releaseNote: z.string().max(500).nullable().optional(),
      storeName: z.string().trim().min(1).max(200).optional(),
      setupVersion: z.string().trim().min(1).max(40).optional(),
    }),
    response: releaseShape,
    async handler(ctx, args) {
      await loadReleaseInfo(ctx);
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.releaseInfo)
        .set({
          latestVersion: args.latestVersion,
          releaseKind: args.releaseKind,
          releaseNote: args.releaseNote ?? null,
          ...(args.storeName !== undefined ? { storeName: args.storeName } : {}),
          ...(args.setupVersion !== undefined ? { setupVersion: args.setupVersion } : {}),
        })
        .where(eq(schema.releaseInfo.id, 1));
      const row = await loadReleaseInfo(ctx);
      ctx.invalidateQueries();
      return releaseResponse(row);
    },
  }),

  setDelivery: defineAction({
    description:
      "Writes the Delivery Slot: the recipient key (a public age key) to deliver with the app's next launch, plus an optional service label to pre-fill on Encrypt Step 1. Overwrites any delivery already waiting.",
    request: z.object({
      recipient: z.string().trim().min(1).max(200),
      serviceLabel: z.string().trim().min(1).max(200).optional(),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      writtenAt: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const shapeError = recipientShapeError(args.recipient);
      if (shapeError) {
        return { ok: false, error: shapeError, writtenAt: null };
      }
      const writtenAt = new Date();
      const db = ctx.db<typeof schema>();
      await db
        .insert(schema.deliverySlot)
        .values({
          id: 1,
          recipient: args.recipient,
          serviceLabel: args.serviceLabel ?? null,
          writtenAt,
        })
        .onConflictDoUpdate({
          target: schema.deliverySlot.id,
          set: {
            recipient: args.recipient,
            serviceLabel: args.serviceLabel ?? null,
            writtenAt,
          },
        });
      ctx.invalidateQueries();
      return { ok: true, error: null, writtenAt: writtenAt.toISOString() };
    },
  }),

  getDeliveryStatus: defineAction({
    description:
      "Reports whether a delivery is waiting in the Delivery Slot — its recipient's SHA-256 hash only (never the recipient itself), the optional service label, and when it was written.",
    request: z.object({}),
    response: z.object({
      waiting: z.boolean(),
      recipientHash: z.string().nullable(),
      serviceLabel: z.string().nullable(),
      writtenAt: z.string().nullable(),
    }),
    async handler(ctx) {
      const row = await loadDeliverySlot(ctx);
      if (!row?.recipient) {
        return { waiting: false, recipientHash: null, serviceLabel: null, writtenAt: null };
      }
      return {
        waiting: true,
        recipientHash: await sha256Hex(row.recipient),
        serviceLabel: row.serviceLabel,
        writtenAt: row.writtenAt ? row.writtenAt.toISOString() : null,
      };
    },
  }),

  consumeDelivery: defineAction({
    description:
      "The app's launch path: returns the waiting delivery (recipient and optional service label) and clears the slot, so each delivery is consumed exactly once. Returns delivered:false when nothing is waiting.",
    request: z.object({}),
    response: z.object({
      delivered: z.boolean(),
      recipient: z.string().nullable(),
      serviceLabel: z.string().nullable(),
    }),
    async handler(ctx) {
      const row = await loadDeliverySlot(ctx);
      if (!row?.recipient) {
        return { delivered: false, recipient: null, serviceLabel: null };
      }
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.deliverySlot)
        .set({ recipient: null, serviceLabel: null, writtenAt: null })
        .where(eq(schema.deliverySlot.id, 1));
      ctx.invalidateQueries();
      return { delivered: true, recipient: row.recipient, serviceLabel: row.serviceLabel };
    },
  }),
} satisfies ActionsModule;
