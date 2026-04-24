-- Access codes table
CREATE TABLE public.access_codes (
  code TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at TIMESTAMPTZ,
  used_by_fingerprint TEXT,
  note TEXT
);

ALTER TABLE public.access_codes ENABLE ROW LEVEL SECURITY;

-- No public policies: only edge functions (service role) can read/write.

-- Access requests table
CREATE TABLE public.access_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  x_username TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT
);

ALTER TABLE public.access_requests ENABLE ROW LEVEL SECURITY;

-- Allow anyone to submit a request
CREATE POLICY "anyone can request access"
ON public.access_requests
FOR INSERT
TO anon, authenticated
WITH CHECK (length(trim(x_username)) BETWEEN 1 AND 50);
