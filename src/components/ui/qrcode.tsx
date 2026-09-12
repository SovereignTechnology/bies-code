import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import { ManualRetryAction } from "@/components/ErrorRetryAction";

interface QRCodeCanvasProps {
  value: string;
  size?: number;
  level?: "L" | "M" | "Q" | "H";
  className?: string;
}

export function QRCodeCanvas({
  value,
  size = 256,
  level = "M",
  className,
}: QRCodeCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string>();
  const [retryVersion, setRetryVersion] = useState(0);

  useEffect(() => {
    if (!canvasRef.current) return;
    let active = true;
    setError(undefined);
    const reportError = (caught: unknown) => {
      if (active)
        setError(
          caught instanceof Error
            ? caught.message
            : "Could not render QR code.",
        );
    };
    try {
      QRCode.toCanvas(
        canvasRef.current,
        value,
        {
          width: size,
          margin: 1,
          errorCorrectionLevel: level,
        },
        (error) => {
          if (error) reportError(error);
        },
      );
    } catch (caught) {
      reportError(caught);
    }
    return () => {
      active = false;
    };
  }, [value, size, level, retryVersion]);

  return (
    <>
      <canvas ref={canvasRef} className={className} hidden={!!error} />
      {error && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">
            Could not display QR code: {error}
          </p>
          <ManualRetryAction
            onRetry={() => setRetryVersion((version) => version + 1)}
          />
        </div>
      )}
    </>
  );
}
