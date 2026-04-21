-- Lock down all writes; service role (used by edge functions) bypasses RLS.
-- Public can still SELECT for read-only realtime/queries.

-- blob_entries: drop public write policies
DROP POLICY IF EXISTS entries_upsert ON public.blob_entries;
DROP POLICY IF EXISTS entries_update ON public.blob_entries;

-- blob_mempool: drop public write/delete policies
DROP POLICY IF EXISTS mempool_insert ON public.blob_mempool;
DROP POLICY IF EXISTS mempool_delete ON public.blob_mempool;

-- blob_chain: drop public insert
DROP POLICY IF EXISTS chain_insert ON public.blob_chain;

-- blob_players: drop public write policies
DROP POLICY IF EXISTS players_upsert ON public.blob_players;
DROP POLICY IF EXISTS players_update ON public.blob_players;

-- (SELECT policies remain so public reads still work via PostgREST + realtime.)
