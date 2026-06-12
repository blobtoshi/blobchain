-- Make usernames unique (case-insensitive) and a global proxy for wallet addresses.
-- 1) Resolve any pre-existing collisions on blob_players by suffixing duplicates
--    so the unique index can be added safely.
WITH ranked AS (
  SELECT address, username,
         ROW_NUMBER() OVER (PARTITION BY lower(username) ORDER BY first_seen NULLS LAST, address) AS rn
  FROM public.blob_players
)
UPDATE public.blob_players p
SET username = p.username || '_' || substr(p.address, 2, 6)
FROM ranked r
WHERE p.address = r.address AND r.rn > 1;

-- 2) Enforce a basic format constraint: 3-24 chars, [a-zA-Z0-9_]
ALTER TABLE public.blob_players
  ADD CONSTRAINT blob_players_username_format
  CHECK (username ~ '^[A-Za-z0-9_]{3,24}$');

-- 3) Case-insensitive uniqueness — usernames behave as global handles.
CREATE UNIQUE INDEX blob_players_username_lower_uniq
  ON public.blob_players (lower(username));

-- 4) Helper RPC: resolve a username (case-insensitive) to its owning address.
--    SECURITY DEFINER so anon can call it; reads only public columns.
CREATE OR REPLACE FUNCTION public.resolve_username(p_username text)
RETURNS TABLE(address text, username text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT address, username
  FROM public.blob_players
  WHERE lower(username) = lower(p_username)
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_username(text) TO anon, authenticated;