ALTER TABLE public.blob_players ENABLE ROW LEVEL SECURITY;
CREATE POLICY "players_public_read" ON public.blob_players FOR SELECT USING (true);