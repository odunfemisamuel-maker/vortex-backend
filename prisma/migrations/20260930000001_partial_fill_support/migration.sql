-- Migration: partial fill support (issue #427)
-- Adds intent_fills table and partial-fill fields to the intents table.

-- ── New columns on intents ─────────────────────────────────────────────────

ALTER TABLE "intents"
  ADD COLUMN IF NOT EXISTS "allow_partial_fill"  BOOLEAN  NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "min_fill_amount"      TEXT,
  ADD COLUMN IF NOT EXISTS "filled_amount"        TEXT     NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS "remaining_amount"     TEXT,
  ADD COLUMN IF NOT EXISTS "slash_reason"         TEXT,
  ADD COLUMN IF NOT EXISTS "slashed_at"           INTEGER,
  ADD COLUMN IF NOT EXISTS "params_version"       INTEGER,
  ADD COLUMN IF NOT EXISTS "version"              INTEGER  NOT NULL DEFAULT 0;

-- Composite partial index: allows fast lookup of open partial-fill intents
-- that still have remaining capacity.
CREATE INDEX IF NOT EXISTS "intents_partial_fill_state_idx"
  ON "intents" ("allow_partial_fill", "state")
  WHERE "allow_partial_fill" = TRUE;

-- ── intent_fills table ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "intent_fills" (
  "id"              TEXT        NOT NULL,
  "fill_id"         TEXT        NOT NULL,
  "intent_id"       TEXT        NOT NULL REFERENCES "intents"("intent_id") ON DELETE CASCADE,
  "solver"          TEXT        NOT NULL,
  "fill_amount"     TEXT        NOT NULL,
  "reserved_amount" TEXT        NOT NULL,
  "tx_hash"         TEXT        NOT NULL,
  "filled_at"       INTEGER     NOT NULL,

  CONSTRAINT "intent_fills_pkey"        PRIMARY KEY ("id"),
  CONSTRAINT "intent_fills_fill_id_key" UNIQUE ("fill_id"),
  CONSTRAINT "intent_fills_tx_hash_key" UNIQUE ("tx_hash")
);

CREATE INDEX IF NOT EXISTS "intent_fills_intent_idx"
  ON "intent_fills" ("intent_id");

CREATE INDEX IF NOT EXISTS "intent_fills_solver_idx"
  ON "intent_fills" ("solver");
