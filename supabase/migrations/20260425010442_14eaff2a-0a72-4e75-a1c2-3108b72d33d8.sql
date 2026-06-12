-- Drop dependent view, RPCs, and constraints first
DROP VIEW IF EXISTS public.blob_players_public;
DROP FUNCTION IF EXISTS public.resolve_username(text);

DROP FUNCTION IF EXISTS public.get_block_leaderboard(bigint);
CREATE OR REPLACE FUNCTION public.get_block_leaderboard(p_height bigint)
RETURNS TABLE(rank bigint, address text, score integer, win_pct numeric)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH totals AS (SELECT SUM(score) AS total FROM public.blob_entries WHERE block_height = p_height)
  SELECT ROW_NUMBER() OVER (ORDER BY e.score DESC) AS rank,
         e.address, e.score,
         ROUND((e.score::NUMERIC / NULLIF(t.total,0)) * 100, 2) AS win_pct
  FROM public.blob_entries e, totals t
  WHERE e.block_height = p_height
  ORDER BY e.score DESC LIMIT 100;
$function$;
GRANT EXECUTE ON FUNCTION public.get_block_leaderboard(bigint) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.update_player_on_block()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.winner IS NOT NULL THEN
    INSERT INTO public.blob_players (address, blocks_won, total_mined, best_score)
    VALUES (NEW.winner, 1, NEW.reward, NEW.winner_score)
    ON CONFLICT (address) DO UPDATE SET
      blocks_won  = public.blob_players.blocks_won + 1,
      total_mined = public.blob_players.total_mined + NEW.reward,
      best_score  = GREATEST(public.blob_players.best_score, NEW.winner_score),
      last_active = NOW();
  END IF;
  RETURN NEW;
END;
$function$;

DROP INDEX IF EXISTS public.blob_players_username_lower_uniq;
ALTER TABLE public.blob_players DROP CONSTRAINT IF EXISTS blob_players_username_format;

ALTER TABLE public.blob_players    DROP COLUMN IF EXISTS username;
ALTER TABLE public.blob_chain      DROP COLUMN IF EXISTS winner_username;
ALTER TABLE public.blob_mempool    DROP COLUMN IF EXISTS from_username;
ALTER TABLE public.blob_entries    DROP COLUMN IF EXISTS username;
ALTER TABLE public.bridge_requests DROP COLUMN IF EXISTS from_username;

-- Recreate the public players view without username
CREATE VIEW public.blob_players_public AS
SELECT address, blocks_won, total_mined, best_score, games_played, first_seen, last_active
FROM public.blob_players;
GRANT SELECT ON public.blob_players_public TO anon, authenticated;
