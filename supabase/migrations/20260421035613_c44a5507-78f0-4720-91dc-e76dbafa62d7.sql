-- Bridge requests: tracks $BLOB → Solana SPL bridge operations.
-- Inserted/updated by the bridge-mint edge function only. Publicly readable
-- so users can see the global bridge feed and verify mints.
CREATE TABLE IF NOT EXISTS public.bridge_requests (
  blob_tx_id      text PRIMARY KEY,
  from_address    text NOT NULL,
  from_username   text,
  sol_address     text NOT NULL,
  amount          numeric NOT NULL,
  status          text NOT NULL DEFAULT 'pending',  -- pending | confirmed | minting | minted | failed
  sol_signature   text,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  confirmed_at    timestamptz,
  minted_at       timestamptz,
  CONSTRAINT bridge_requests_status_chk
    CHECK (status IN ('pending','confirmed','minting','minted','failed')),
  CONSTRAINT bridge_requests_amount_chk CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS bridge_requests_created_idx
  ON public.bridge_requests (created_at DESC);
CREATE INDEX IF NOT EXISTS bridge_requests_from_idx
  ON public.bridge_requests (from_address);
CREATE INDEX IF NOT EXISTS bridge_requests_status_idx
  ON public.bridge_requests (status);

ALTER TABLE public.bridge_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bridge_public_read ON public.bridge_requests;
CREATE POLICY bridge_public_read ON public.bridge_requests
  FOR SELECT TO public USING (true);

-- No INSERT/UPDATE/DELETE policies → only the service role (edge function) can write.
