DROP VIEW IF EXISTS public.blob_players_public;
CREATE VIEW public.blob_players_public
WITH (security_invoker = true) AS
SELECT address, blocks_won, total_mined, best_score, games_played, first_seen, last_active
FROM public.blob_players;
GRANT SELECT ON public.blob_players_public TO anon, authenticated;
