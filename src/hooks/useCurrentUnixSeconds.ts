import { useEffect, useState } from "react";

/**
 * Keeps pending CI durations accurate without polling completed workflow rows.
 */
export function useCurrentUnixSeconds(enabled: boolean): number {
  const [nowSeconds, setNowSeconds] = useState(() =>
    Math.floor(Date.now() / 1000),
  );

  useEffect(() => {
    if (!enabled) return;

    const tick = () => setNowSeconds(Math.floor(Date.now() / 1000));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [enabled]);

  return nowSeconds;
}
