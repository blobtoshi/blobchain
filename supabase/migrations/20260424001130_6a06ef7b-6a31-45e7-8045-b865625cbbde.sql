ALTER TABLE public.blob_entries
  ADD COLUMN IF NOT EXISTS inputs_hash text,
  ADD COLUMN IF NOT EXISTS frame_count integer,
  ADD COLUMN IF NOT EXISTS inputs text;