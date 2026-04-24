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
    const { x_username } = await req.json();
    if (typeof x_username !== 'string') {
      return json({ ok: false, error: 'invalid input' }, 400);
    }
    let handle = x_username.trim().replace(/^@/, '');
    if (handle.length < 1 || handle.length > 50 || !/^[A-Za-z0-9_]+$/.test(handle)) {
      return json({ ok: false, error: 'invalid X username' }, 400);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error('backend environment not configured');
    }

    const insertRes = await fetch(`${supabaseUrl}/rest/v1/access_requests`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ x_username: handle }),
    });

    if (!insertRes.ok) {
      throw new Error(`insert failed (${insertRes.status})`);
    }

    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
