CREATE TABLE public.bridge_redeems (
  sol_signature   text PRIMARY KEY,
  blob_address    text NOT NULL,
  amount          numeric NOT NULL,
  credit_amount   numeric,
  bridge_fee      numeric,
  status          text NOT NULL DEFAULT 'pending',
  blob_tx_id      text,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  verified_at     timestamptz,
  credited_at     timestamptz
);

ALTER TABLE public.bridge_redeems ENABLE ROW LEVEL SECURITY;

CREATE POLICY "redeems_public_read"
ON public.bridge_redeems
FOR SELECT
USING (true);

CREATE INDEX idx_bridge_redeems_blob_address ON public.bridge_redeems (blob_address, created_at DESC);
CREATE INDEX idx_bridge_redeems_status ON public.bridge_redeems (status);