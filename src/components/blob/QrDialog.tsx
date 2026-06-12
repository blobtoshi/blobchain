import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { QrCode, Camera, X } from "lucide-react";

export function ShowQrDialog({
  open, onOpenChange, address,
}: { open: boolean; onOpenChange: (o: boolean) => void; address: string }) {
  const [dataUrl, setDataUrl] = useState<string>("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open || !address) return;
    QRCode.toDataURL(address, {
      width: 320,
      margin: 1,
      color: { dark: "#0a0a0a", light: "#ffffff" },
      errorCorrectionLevel: "M",
    }).then(setDataUrl).catch(() => setDataUrl(""));
  }, [open, address]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <QrCode className="w-4 h-4 text-primary" /> Receive BLOB
          </DialogTitle>
          <DialogDescription>Scan this QR code to send BLOB to your address.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-4 py-2">
          <div className="rounded-2xl bg-white p-3 shadow-lg">
            {dataUrl ? (
              <img src={dataUrl} alt="Wallet QR code" width={280} height={280} className="block" />
            ) : (
              <div className="w-[280px] h-[280px] bg-muted animate-pulse rounded-lg" />
            )}
          </div>
          <div className="w-full">
            <div className="num text-xs text-center text-muted-foreground break-all px-2">{address}</div>
            <button
              onClick={copy}
              className="mt-3 w-full py-2.5 rounded-lg border border-border hover:border-primary/40 hover:text-primary text-sm transition"
            >
              {copied ? "✓ Copied" : "Copy address"}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ScanQrDialog({
  open, onOpenChange, onResult,
}: { open: boolean; onOpenChange: (o: boolean) => void; onResult: (text: string) => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const [err, setErr] = useState<string>("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setErr("");

    const stop = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };

    const tick = () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      const w = video.videoWidth;
      const h = video.videoHeight;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      ctx.drawImage(video, 0, 0, w, h);
      const img = ctx.getImageData(0, 0, w, h);
      const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
      if (code && code.data) {
        onResult(code.data.trim());
        onOpenChange(false);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setErr("Camera not supported on this device");
          return;
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          video.setAttribute("playsinline", "true");
          await video.play();
          rafRef.current = requestAnimationFrame(tick);
        }
      } catch (e: any) {
        setErr(e?.message || "Camera access denied");
      }
    })();

    return () => {
      cancelled = true;
      stop();
    };
  }, [open, onOpenChange, onResult]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Camera className="w-4 h-4 text-primary" /> Scan QR code
          </DialogTitle>
          <DialogDescription>Point your camera at a BLOB address QR code.</DialogDescription>
        </DialogHeader>
        <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-black">
          <video
            ref={videoRef}
            className="w-full h-full object-cover"
            muted
            playsInline
          />
          <canvas ref={canvasRef} className="hidden" />
          <div className="pointer-events-none absolute inset-6 border-2 border-primary/70 rounded-lg shadow-[0_0_24px_hsl(var(--primary)/0.4)]" />
          {err && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/80 text-sm text-destructive p-4 text-center">
              {err}
            </div>
          )}
        </div>
        <button
          onClick={() => onOpenChange(false)}
          className="w-full py-2.5 rounded-lg border border-border hover:border-primary/40 text-sm transition flex items-center justify-center gap-2"
        >
          <X className="w-4 h-4" /> Cancel
        </button>
      </DialogContent>
    </Dialog>
  );
}
