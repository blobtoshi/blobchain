CREATE TABLE IF NOT EXISTS public.blob_chain (
  height BIGINT PRIMARY KEY, previous_hash TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
  timestamp BIGINT NOT NULL, winner TEXT, winner_username TEXT,
  winner_score INTEGER DEFAULT 0, reward NUMERIC(18,6) DEFAULT 0, seed TEXT NOT NULL,
  transactions TEXT DEFAULT '[]', mining_entries TEXT DEFAULT '[]',
  node_count INTEGER DEFAULT 1, total_supply NUMERIC(18,6) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS public.blob_mempool (
  id TEXT PRIMARY KEY, from_address TEXT NOT NULL, from_username TEXT,
  to_address TEXT NOT NULL, amount NUMERIC(18,6) NOT NULL CHECK(amount > 0),
  fee NUMERIC(18,6) DEFAULT 0.001, signature TEXT NOT NULL, public_key TEXT NOT NULL,
  timestamp BIGINT NOT NULL, status TEXT DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS public.blob_entries (
  address TEXT NOT NULL, block_height BIGINT NOT NULL, block_seed TEXT,
  username TEXT, score INTEGER NOT NULL DEFAULT 0, signature TEXT NOT NULL,
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (address, block_height)
);
CREATE TABLE IF NOT EXISTS public.blob_players (
  address TEXT PRIMARY KEY, username TEXT NOT NULL, public_key TEXT,
  blocks_won INTEGER DEFAULT 0, total_mined NUMERIC(18,6) DEFAULT 0,
  best_score INTEGER DEFAULT 0, games_played INTEGER DEFAULT 0,
  first_seen TIMESTAMPTZ DEFAULT NOW(), last_active TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chain_height   ON public.blob_chain(height DESC);
CREATE INDEX IF NOT EXISTS idx_mempool_status ON public.blob_mempool(status, timestamp);
CREATE INDEX IF NOT EXISTS idx_entries_block  ON public.blob_entries(block_height, score DESC);
CREATE INDEX IF NOT EXISTS idx_entries_addr   ON public.blob_entries(address);
CREATE INDEX IF NOT EXISTS idx_players_mined  ON public.blob_players(total_mined DESC);

ALTER TABLE public.blob_chain   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blob_mempool ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blob_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blob_players ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "chain_public_read"   ON public.blob_chain;
DROP POLICY IF EXISTS "mempool_public_read" ON public.blob_mempool;
DROP POLICY IF EXISTS "entries_public_read" ON public.blob_entries;
DROP POLICY IF EXISTS "players_public_read" ON public.blob_players;
DROP POLICY IF EXISTS "chain_insert"        ON public.blob_chain;
DROP POLICY IF EXISTS "mempool_insert"      ON public.blob_mempool;
DROP POLICY IF EXISTS "mempool_delete"      ON public.blob_mempool;
DROP POLICY IF EXISTS "entries_upsert"      ON public.blob_entries;
DROP POLICY IF EXISTS "entries_update"      ON public.blob_entries;
DROP POLICY IF EXISTS "players_upsert"      ON public.blob_players;
DROP POLICY IF EXISTS "players_update"      ON public.blob_players;

CREATE POLICY "chain_public_read"   ON public.blob_chain   FOR SELECT USING (TRUE);
CREATE POLICY "mempool_public_read" ON public.blob_mempool FOR SELECT USING (TRUE);
CREATE POLICY "entries_public_read" ON public.blob_entries FOR SELECT USING (TRUE);
CREATE POLICY "players_public_read" ON public.blob_players FOR SELECT USING (TRUE);
CREATE POLICY "chain_insert"   ON public.blob_chain   FOR INSERT WITH CHECK (TRUE);
CREATE POLICY "mempool_insert" ON public.blob_mempool FOR INSERT WITH CHECK (TRUE);
CREATE POLICY "mempool_delete" ON public.blob_mempool FOR DELETE USING (TRUE);
CREATE POLICY "entries_upsert" ON public.blob_entries FOR INSERT WITH CHECK (TRUE);
CREATE POLICY "entries_update" ON public.blob_entries FOR UPDATE USING (TRUE);
CREATE POLICY "players_upsert" ON public.blob_players FOR INSERT WITH CHECK (TRUE);
CREATE POLICY "players_update" ON public.blob_players FOR UPDATE USING (TRUE);

ALTER TABLE public.blob_chain   REPLICA IDENTITY FULL;
ALTER TABLE public.blob_mempool REPLICA IDENTITY FULL;
ALTER TABLE public.blob_entries REPLICA IDENTITY FULL;

DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.blob_chain;   EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.blob_mempool; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.blob_entries; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION public.get_block_leaderboard(p_height BIGINT)
RETURNS TABLE(rank BIGINT, address TEXT, username TEXT, score INTEGER, win_pct NUMERIC)
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH totals AS (SELECT SUM(score) AS total FROM public.blob_entries WHERE block_height = p_height)
  SELECT ROW_NUMBER() OVER (ORDER BY e.score DESC) AS rank,
         e.address, e.username, e.score,
         ROUND((e.score::NUMERIC / NULLIF(t.total,0)) * 100, 2) AS win_pct
  FROM public.blob_entries e, totals t
  WHERE e.block_height = p_height
  ORDER BY e.score DESC LIMIT 100;
$$;

CREATE OR REPLACE FUNCTION public.get_player_stats(p_address TEXT)
RETURNS TABLE(blocks_won BIGINT, total_mined NUMERIC, best_score INTEGER, avg_score NUMERIC, games_played BIGINT)
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COUNT(*) FILTER (WHERE winner = p_address) AS blocks_won,
         COALESCE(SUM(reward) FILTER (WHERE winner = p_address), 0) AS total_mined,
         COALESCE(MAX(e.score), 0) AS best_score,
         COALESCE(AVG(e.score), 0) AS avg_score,
         COUNT(DISTINCT e.block_height) AS games_played
  FROM public.blob_chain c
  FULL JOIN public.blob_entries e ON e.address = p_address
  WHERE c.height IS NOT NULL OR e.address IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION public.update_player_on_block()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.winner IS NOT NULL THEN
    INSERT INTO public.blob_players (address, username, blocks_won, total_mined, best_score)
    VALUES (NEW.winner, COALESCE(NEW.winner_username, 'anonymous'), 1, NEW.reward, NEW.winner_score)
    ON CONFLICT (address) DO UPDATE SET
      blocks_won  = public.blob_players.blocks_won + 1,
      total_mined = public.blob_players.total_mined + NEW.reward,
      best_score  = GREATEST(public.blob_players.best_score, NEW.winner_score),
      last_active = NOW();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_block_update_player ON public.blob_chain;
CREATE TRIGGER trg_block_update_player
  AFTER INSERT ON public.blob_chain
  FOR EACH ROW EXECUTE FUNCTION public.update_player_on_block();

INSERT INTO public.blob_chain (
  height, previous_hash, hash, timestamp,
  winner, winner_username, winner_score, reward, seed,
  transactions, mining_entries, total_supply
) VALUES (
  0,
  '0000000000000000000000000000000000000000000000000000000000000000',
  'genesis00000000000000000000000000000000000000000000000000000blob',
  1745000000000,
  NULL, 'Satoshi Blobamoto', 0, 0, 'genesis',
  '[]', '[]', 0
) ON CONFLICT (height) DO NOTHING;