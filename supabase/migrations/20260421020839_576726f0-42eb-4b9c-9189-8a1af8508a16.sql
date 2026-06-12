ALTER TABLE public.blob_mempool
  ADD COLUMN IF NOT EXISTS memo TEXT,
  ADD COLUMN IF NOT EXISTS fee_rate NUMERIC DEFAULT 10;

UPDATE public.blob_mempool SET fee_rate = 10 WHERE fee_rate IS NULL;