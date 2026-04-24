import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

const STORAGE_KEY = "blob_alpha_access";
const FP_KEY = "blob_alpha_fp";

function getFingerprint(): string {
  let fp = localStorage.getItem(FP_KEY);
  if (!fp) {
    fp = crypto.randomUUID();
    localStorage.setItem(FP_KEY, fp);
  }
  return fp;
}

export default function AlphaLock({ children }: { children: React.ReactNode }) {
  const [unlocked, setUnlocked] = useState<boolean | null>(null);
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const [requestOpen, setRequestOpen] = useState(false);
  const [xHandle, setXHandle] = useState("");
  const [requestMsg, setRequestMsg] = useState("");
  const [requestErr, setRequestErr] = useState("");
  const [requestBusy, setRequestBusy] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) { setUnlocked(false); return; }
    // Re-validate against backend so revoked codes lock the device again.
    (async () => {
      try {
        const { data } = await supabase.functions.invoke("verify-access-code", {
          body: { code: stored, fingerprint: getFingerprint() },
        });
        if (data?.ok) setUnlocked(true);
        else { localStorage.removeItem(STORAGE_KEY); setUnlocked(false); }
      } catch {
        // If backend unreachable, trust the local token to avoid soft-locking users.
        setUnlocked(true);
      }
    })();
  }, []);

  async function submitCode() {
    setErr(""); setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("verify-access-code", {
        body: { code: code.trim(), fingerprint: getFingerprint() },
      });
      if (error) throw error;
      if (data?.ok) {
        localStorage.setItem(STORAGE_KEY, data.token);
        setUnlocked(true);
      } else {
        setErr(data?.error || "Invalid code");
      }
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function submitRequest() {
    setRequestErr(""); setRequestMsg(""); setRequestBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("request-access-code", {
        body: { x_username: xHandle.trim() },
      });
      if (error) throw error;
      if (data?.ok) {
        setRequestMsg("Request submitted. You'll be contacted on X with your code.");
        setXHandle("");
      } else {
        setRequestErr(data?.error || "Could not submit request");
      }
    } catch (e: any) {
      setRequestErr(String(e?.message || e));
    } finally {
      setRequestBusy(false);
    }
  }

  if (unlocked === null) {
    return <div className="min-h-screen flex items-center justify-center text-muted-foreground text-sm">Loading…</div>;
  }
  if (unlocked) return <>{children}</>;

  return (
    <div className="min-h-screen flex items-center justify-center px-5 py-10">
      <div className="w-full max-w-md space-y-6">
        <div className="glass-hi p-8 space-y-6 text-center">
          <div className="space-y-2">
            <div className="text-[10px] tracking-[0.25em] text-primary/80 uppercase">Alpha</div>
            <h1 className="text-2xl font-semibold tracking-tight">Build Access Locked</h1>
            <p className="text-xs text-muted-foreground">Enter your access code to continue.</p>
          </div>

          <div className="space-y-3">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !busy && code.trim() && submitCode()}
              placeholder="ACCESS CODE"
              autoFocus
              spellCheck={false}
              autoCapitalize="characters"
              className="num w-full px-4 py-3 rounded-lg bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-sm text-center tracking-[0.3em] uppercase"
            />
            {err && <div className="text-xs text-destructive">{err}</div>}
            <button
              onClick={submitCode}
              disabled={busy || !code.trim()}
              className="w-full py-3 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              {busy ? "Verifying…" : "Unlock"}
            </button>
          </div>

          <button
            onClick={() => { setRequestOpen((v) => !v); setRequestMsg(""); setRequestErr(""); }}
            className="text-xs text-muted-foreground hover:text-foreground transition underline underline-offset-4"
          >
            {requestOpen ? "Hide request form" : "Request access code"}
          </button>

          {requestOpen && (
            <div className="space-y-3 pt-2 border-t border-border">
              <label className="label-eyebrow block text-left">X username</label>
              <input
                value={xHandle}
                onChange={(e) => setXHandle(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !requestBusy && xHandle.trim() && submitRequest()}
                placeholder="@yourhandle"
                className="w-full px-4 py-3 rounded-lg bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-sm"
              />
              {requestErr && <div className="text-xs text-destructive text-left">{requestErr}</div>}
              {requestMsg && <div className="text-xs text-primary text-left">{requestMsg}</div>}
              <button
                onClick={submitRequest}
                disabled={requestBusy || !xHandle.trim()}
                className="w-full py-3 rounded-lg border border-primary/40 text-primary text-sm font-medium hover:bg-primary/10 disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                {requestBusy ? "Submitting…" : "Request access"}
              </button>
            </div>
          )}
        </div>

        <p className="text-[11px] text-muted-foreground/80 text-center leading-relaxed px-4">
          Note: your access is tied to this browser. If you clear cookies or browsing data, you'll need to request a new code.
        </p>
      </div>
    </div>
  );
}
