-- Rename blob_players table → blob_addresses
ALTER TABLE public.blob_players RENAME TO blob_addresses;

-- Recreate the public view with the new name
DROP VIEW IF EXISTS public.blob_players_public;
CREATE VIEW public.blob_addresses_public
WITH (security_invoker = true) AS
SELECT address, blocks_won, total_mined, best_score, games_played, first_seen, last_active
FROM public.blob_addresses;
GRANT SELECT ON public.blob_addresses_public TO anon, authenticated;

-- Replace trigger function with address-named version
DROP TRIGGER IF EXISTS trg_block_update_player ON public.blob_chain;
DROP FUNCTION IF EXISTS public.update_player_on_block();

CREATE OR REPLACE FUNCTION public.update_address_on_block()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.winner IS NOT NULL THEN
    INSERT INTO public.blob_addresses (address, blocks_won, total_mined, best_score)
    VALUES (NEW.winner, 1, NEW.reward, NEW.winner_score)
    ON CONFLICT (address) DO UPDATE SET
      blocks_won  = public.blob_addresses.blocks_won + 1,
      total_mined = public.blob_addresses.total_mined + NEW.reward,
      best_score  = GREATEST(public.blob_addresses.best_score, NEW.winner_score),
      last_active = NOW();
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_block_update_address
  AFTER INSERT ON public.blob_chain
  FOR EACH ROW EXECUTE FUNCTION public.update_address_on_block();

-- Rename stats RPC
DROP FUNCTION IF EXISTS public.get_player_stats(text);
CREATE OR REPLACE FUNCTION public.get_address_stats(p_address text)
RETURNS TABLE(blocks_won bigint, total_mined numeric, best_score integer, avg_score numeric, games_played bigint)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COUNT(*) FILTER (WHERE winner = p_address) AS blocks_won,
         COALESCE(SUM(reward) FILTER (WHERE winner = p_address), 0) AS total_mined,
         COALESCE(MAX(e.score), 0) AS best_score,
         COALESCE(AVG(e.score), 0) AS avg_score,
         COUNT(DISTINCT e.block_height) AS games_played
  FROM public.blob_chain c
  FULL JOIN public.blob_entries e ON e.address = p_address
  WHERE c.height IS NOT NULL OR e.address IS NOT NULL;
$function$;