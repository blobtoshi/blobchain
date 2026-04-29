ALTER TABLE public.bridge_requests
  ADD COLUMN IF NOT EXISTS confirmations integer NOT NULL DEFAULT 0;
COMMENT ON COLUMN public.bridge_requests.confirmations IS
  'Number of BLOB-chain blocks built on top of the originating tx''s block. Bridge mint waits for >= 3 confirmations to harden against depth-1 reorgs.';