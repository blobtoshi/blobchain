const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const { code, fingerprint } = await req.json();
    if (typeof code !== 'string' || typeof fingerprint !== 'string' || !code.trim() || !fingerprint.trim()) {
      return json({ ok: false, error: 'invalid input' }, 400);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error('backend environment not configured');
    }

    const normalized = code.trim().toUpperCase();
    const lookupUrl = new URL(`${supabaseUrl}/rest/v1/access_codes`);
    lookupUrl.searchParams.set('select', 'code,used_at,used_by_fingerprint');
    lookupUrl.searchParams.set('code', `eq.${normalized}`);

    const lookupRes = await fetch(lookupUrl, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    });

    if (!lookupRes.ok) {
      throw new Error(`lookup failed (${lookupRes.status})`);
    }

    const rows = await lookupRes.json();
    const row = Array.isArray(rows) ? rows[0] : null;

    if (!row) {
      return json({ ok: false, error: 'invalid code' });
    }

    // If already used, only same fingerprint may re-validate
    if (row.used_at && row.used_by_fingerprint && row.used_by_fingerprint !== fingerprint) {
      return json({ ok: false, error: 'code already used' });
    }

    if (!row.used_at) {
      const updateRes = await fetch(`${supabaseUrl}/rest/v1/access_codes?code=eq.${encodeURIComponent(normalized)}`, {
        method: 'PATCH',
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
        used_at: new Date().toISOString(),
        used_by_fingerprint: fingerprint,
        }),
      });

      if (!updateRes.ok) {
        throw new Error(`update failed (${updateRes.status})`);
      }
    }

    return json({ ok: true, token: normalized });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
