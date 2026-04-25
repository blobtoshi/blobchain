-- Drop and recreate views with security_invoker so they run as the caller, not creator.
DROP VIEW IF EXISTS public.bridge_audit;
DROP VIEW IF EXISTS public.bridge_ledger;

CREATE VIEW public.bridge_ledger
WITH (security_invoker = true) AS
WITH bridge_txs AS (
  SELECT
    c.height                                 AS block_height,
    c.timestamp                              AS block_timestamp,
    (tx.value->>'id')                        AS blob_tx_id,
    (tx.value->>'from')                      AS from_address,
    (tx.value->>'to')                        AS to_address,
    ((tx.value->>'amount')::numeric)         AS amount,
    coalesce((tx.value->>'memo'), '')        AS memo
  FROM public.blob_chain c
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN c.transactions IS NULL OR c.transactions = ''
         THEN '[]'::jsonb
         ELSE c.transactions::jsonb
    END
  ) AS tx(value)
  WHERE (tx.value->>'to') = '1E4QWFYb5Pqj8iAV2be8Ee88yEbvhU9iTs'
)
SELECT
  bt.block_height,
  bt.block_timestamp,
  bt.blob_tx_id,
  bt.from_address,
  bt.to_address,
  bt.amount,
  bt.memo,
  CASE WHEN bt.memo LIKE 'sol:%' THEN substring(bt.memo from 5) ELSE NULL END AS memo_sol_address,
  br.status        AS mint_status,
  br.sol_signature AS mint_signature,
  br.sol_address   AS mint_sol_address,
  br.minted_at,
  br.error         AS mint_error
FROM bridge_txs bt
LEFT JOIN public.bridge_requests br ON br.blob_tx_id = bt.blob_tx_id;

GRANT SELECT ON public.bridge_ledger TO anon, authenticated;

CREATE VIEW public.bridge_audit
WITH (security_invoker = true) AS
SELECT
  coalesce(sum(amount), 0)                                              AS total_locked_blob,
  coalesce(sum(amount) FILTER (WHERE mint_status = 'minted'), 0)        AS total_minted_blob,
  coalesce(sum(amount) FILTER (
    WHERE mint_status IS NULL OR mint_status NOT IN ('minted','failed')
  ), 0)                                                                 AS unreconciled_blob,
  count(*) FILTER (
    WHERE mint_status IS NULL OR mint_status NOT IN ('minted','failed')
  )                                                                     AS unreconciled_count,
  count(*)                                                              AS total_bridge_txs
FROM public.bridge_ledger;

GRANT SELECT ON public.bridge_audit TO anon, authenticated;

-- Pin search_path on the hash function
CREATE OR REPLACE FUNCTION public.compute_block_hash_v2(
  p_height bigint,
  p_previous_hash text,
  p_timestamp bigint,
  p_seed text,
  p_winner text,
  p_reward numeric,
  p_winner_score integer,
  p_transactions text
) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, extensions
AS $$
  SELECT encode(
    digest(
      'blobchain.v2|' ||
      p_height::text || '|' ||
      coalesce(p_previous_hash,'') || '|' ||
      p_timestamp::text || '|' ||
      coalesce(p_seed,'') || '|' ||
      coalesce(p_winner,'') || '|' ||
      coalesce(p_reward,0)::text || '|' ||
      coalesce(p_winner_score,0)::text || '|' ||
      coalesce(p_transactions,'[]'),
      'sha256'
    ),
    'hex'
  );
$$;