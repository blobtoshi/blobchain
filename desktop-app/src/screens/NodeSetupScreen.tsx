import { useState } from "react";
import { BlobNodeClient } from "@web/lib/blobNodeClient";
import { Button } from "@web/components/ui/button";
import { Input } from "@web/components/ui/input";
import { Label } from "@web/components/ui/label";
import { DEFAULT_NODE } from "../hooks/useNodeConfig";

// Mandatory first-run screen: nothing else loads until the user picks a node.
// They can change it anytime later from the Node tab.
export function NodeSetupScreen({
  onChosen,
}: {
  onChosen: (url: string) => void;
}) {
  const [draft, setDraft] = useState(DEFAULT_NODE);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<"" | "ok" | "fail">("");

  const cleanDraft = draft.trim().replace(/\/$/, "");
  const validDraft = /^https?:\/\//.test(cleanDraft);

  async function test() {
    if (!validDraft) return;
    setTesting(true);
    setResult("");
    const ok = await BlobNodeClient.healthcheck(cleanDraft, 3000);
    setResult(ok ? "ok" : "fail");
    setTesting(false);
  }

  function connect() {
    if (!validDraft) return;
    onChosen(cleanDraft);
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="node-url" className="text-xs text-muted-foreground">
          Full node base URL (REST + /ws)
        </Label>
        <Input
          id="node-url"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setResult("");
          }}
          placeholder="http://localhost:9090"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </div>

      <div className="flex gap-2">
        <Button
          variant="outline"
          className="flex-1"
          onClick={test}
          disabled={!validDraft || testing}
        >
          {testing ? "Testing…" : "Test connection"}
        </Button>
        <Button
          className="flex-[2]"
          onClick={connect}
          disabled={!validDraft}
        >
          Continue
        </Button>
      </div>

      {result === "ok" && (
        <p className="text-xs text-emerald-400">✓ Node reachable</p>
      )}
      {result === "fail" && (
        <p className="text-xs text-destructive">
          Couldn't reach node at {cleanDraft}. You can still continue — the wallet
          will keep retrying in the background.
        </p>
      )}
    </div>
  );
}
