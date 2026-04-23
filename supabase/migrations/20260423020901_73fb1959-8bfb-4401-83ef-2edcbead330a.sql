
-- 1. Restrict blob_players: drop the public read policy that exposes public_key,
--    and create a public view that excludes that column.
DROP POLICY IF EXISTS players_public_read ON public.blob_players;

CREATE OR REPLACE VIEW public.blob_players_public
WITH (security_invoker = true)
AS
SELECT
  address,
  username,
  blocks_won,
  total_mined,
  best_score,
  games_played,
  first_seen,
  last_active
FROM public.blob_players;

GRANT SELECT ON public.blob_players_public TO anon, authenticated;

-- The base table now has no public SELECT policy. Service role (edge functions)
-- still bypasses RLS and can read public_key for signature verification.

-- 2. Realtime subscription scope: only allow public subscriptions to the
--    three published tables. Reject any other channel topic.
ALTER TABLE IF EXISTS realtime.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "blob_realtime_topic_whitelist" ON realtime.messages;

CREATE POLICY "blob_realtime_topic_whitelist"
ON realtime.messages
FOR SELECT
TO anon, authenticated
USING (
  realtime.topic() IN (
    'blob_chain',
    'blob_mempool',
    'blob_entries',
    'realtime:public:blob_chain',
    'realtime:public:blob_mempool',
    'realtime:public:blob_entries'
  )
);
