-- Drop tables that are now node-only (chain consensus moved off Supabase).
-- Bridge tables (bridge_requests, bridge_redeems) and access tables (access_codes, access_requests) are kept.
DROP FUNCTION IF EXISTS public.get_block_leaderboard(bigint) CASCADE;
DROP FUNCTION IF EXISTS public.get_address_stats(text) CASCADE;
DROP FUNCTION IF EXISTS public.compute_block_hash_v2(bigint, text, bigint, text, text, numeric, integer, text) CASCADE;
DROP FUNCTION IF EXISTS public.update_address_on_block() CASCADE;

DROP TABLE IF EXISTS public.blob_entries CASCADE;
DROP TABLE IF EXISTS public.blob_mempool CASCADE;
DROP TABLE IF EXISTS public.blob_chain CASCADE;
DROP TABLE IF EXISTS public.blob_addresses CASCADE;