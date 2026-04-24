import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const { code, fingerprint } = await req.json();
    if (typeof code !== 'string' || typeof fingerprint !== 'string' || !code.trim() || !fingerprint.trim()) {
      return new Response(JSON.stringify({ ok: false, error: 'invalid input' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const normalized = code.trim().toUpperCase();
    const { data: row, error } = await supabase
      .from('access_codes')
      .select('code, used_at, used_by_fingerprint')
      .eq('code', normalized)
      .maybeSingle();

    if (error) throw error;
    if (!row) {
      return new Response(JSON.stringify({ ok: false, error: 'invalid code' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // If already used, only same fingerprint may re-validate
    if (row.used_at && row.used_by_fingerprint && row.used_by_fingerprint !== fingerprint) {
      return new Response(JSON.stringify({ ok: false, error: 'code already used' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!row.used_at) {
      await supabase.from('access_codes').update({
        used_at: new Date().toISOString(),
        used_by_fingerprint: fingerprint,
      }).eq('code', normalized);
    }

    return new Response(JSON.stringify({ ok: true, token: normalized }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
