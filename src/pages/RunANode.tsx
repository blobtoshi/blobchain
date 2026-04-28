import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Copy, Check, Github, Server, Shield, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";

const QUICKSTART = `git clone https://github.com/blobchain/blobchain
cd blobchain/node
npm install
npm start                  # listens on :8080`;

const DOCKER = `docker run -d --name blob-node \\
  -p 8080:8080 \\
  -v blob-data:/data \\
  -e PEERS=wss://node1.blobchain.network/ws,wss://node2.blobchain.network/ws \\
  ghcr.io/blobchain/node:latest`;

const COMPOSE = `# Spin up two peered nodes locally for testing
cd blobchain/node
docker compose up --build
# → node A on :8081, node B on :8082, peered together`;

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* noop */ }
  };
  return (
    <div className="relative group">
      <pre className="glass-hi p-4 pr-12 rounded-lg text-xs font-mono overflow-x-auto whitespace-pre text-foreground/90">
        {code}
      </pre>
      <button
        onClick={onCopy}
        className="absolute top-2 right-2 p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors"
        aria-label="Copy"
      >
        {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
      </button>
    </div>
  );
}

export default function RunANode() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-3xl mx-auto px-6 py-10 space-y-10">
        {/* Header */}
        <div className="space-y-4">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Back to Blob Chain
          </Link>
          <div className="space-y-2">
            <div className="label-eyebrow text-primary">Self-host</div>
            <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-brand-gradient">
              Run your own Blob node
            </h1>
            <p className="text-sm text-muted-foreground max-w-xl">
              Don't trust — verify. Running a full node gives you a private, censorship-resistant
              endpoint for your wallet, the desktop app, and anyone you choose to share it with.
            </p>
          </div>
        </div>

        {/* Why */}
        <section className="grid sm:grid-cols-3 gap-3">
          {[
            { icon: Shield, title: "Sovereignty", body: "No third party between you and the chain." },
            { icon: Zap,    title: "Speed",       body: "Local RPC means zero network round-trips." },
            { icon: Server, title: "Contribute",  body: "More nodes = a more resilient network." },
          ].map(({ icon: Icon, title, body }) => (
            <div key={title} className="glass-hi p-4 rounded-lg space-y-1.5">
              <Icon className="w-4 h-4 text-primary" />
              <div className="text-sm font-medium">{title}</div>
              <div className="text-xs text-muted-foreground leading-relaxed">{body}</div>
            </div>
          ))}
        </section>

        {/* Quickstart */}
        <section className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">Quickstart (Node.js)</h2>
          <p className="text-xs text-muted-foreground">
            Requires Node.js 20+ and ~200 MB of disk for the chain database.
          </p>
          <CodeBlock code={QUICKSTART} />
        </section>

        {/* Docker */}
        <section className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">Or with Docker</h2>
          <CodeBlock code={DOCKER} />
        </section>

        {/* Docker compose / peers */}
        <section className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">Peer with the network</h2>
          <p className="text-xs text-muted-foreground">
            Pass a comma-separated <code className="px-1 py-0.5 rounded bg-foreground/5 text-foreground text-[11px]">PEERS</code> list
            to gossip blocks with other nodes. New blocks propagate in ~1 second; depth-1 reorgs heal automatically.
          </p>
          <CodeBlock code={COMPOSE} />
        </section>

        {/* Connect */}
        <section className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">Point your wallet at it</h2>
          <ol className="space-y-2 text-sm text-muted-foreground list-decimal list-inside">
            <li>Open the Blob Chain desktop app.</li>
            <li>On first launch (or via <span className="text-foreground">Settings → Node</span>), pick <span className="text-foreground">Custom URL…</span></li>
            <li>Enter <code className="px-1.5 py-0.5 rounded bg-foreground/5 text-foreground text-xs">http://localhost:8080</code> and click Connect.</li>
          </ol>
        </section>

        {/* Links */}
        <section className="flex flex-wrap gap-3">
          <Button asChild variant="outline">
            <a href="https://github.com/blobchain/blobchain" target="_blank" rel="noopener noreferrer">
              <Github className="w-4 h-4 mr-2" /> View on GitHub
            </a>
          </Button>
          <Button asChild variant="ghost">
            <a href="https://github.com/blobchain/blobchain/blob/main/node/README.md" target="_blank" rel="noopener noreferrer">
              Full node docs →
            </a>
          </Button>
        </section>

        <footer className="pt-6 text-center text-[11px] text-muted-foreground/60">
          Blob Chain © 2026
        </footer>
      </div>
    </div>
  );
}
