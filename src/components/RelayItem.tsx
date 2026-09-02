import { useMemo, useState } from "react";
import { use$ } from "@/hooks/use$";
import { pool } from "@/services/nostr";
import { Button } from "@/components/ui/button";
import { ensureHttpURL } from "applesauce-core/helpers";
import { WifiIcon, WifiOffIcon, Loader2Icon, Trash2Icon } from "lucide-react";

export function RelayItem({
  relay,
  onRemove,
}: {
  relay: string;
  onRemove: () => void | Promise<void>;
}) {
  const inst = useMemo(() => pool.relay(relay), [relay]);
  const icon = use$(inst.icon$);
  const connected = use$(inst.connected$);
  const [removing, setRemoving] = useState(false);

  const handleRemove = async () => {
    setRemoving(true);
    await onRemove();
    setRemoving(false);
  };

  return (
    <div className="flex min-w-0 items-center gap-2">
      <a
        href={ensureHttpURL(relay)}
        target="_blank"
        title="Open in new tab"
        aria-label={`Open ${relay} in a new tab`}
        className="shrink-0"
      >
        <img src={icon} alt="" className="h-6 w-6" />
      </a>
      <code
        className="min-w-0 flex-1 truncate whitespace-nowrap rounded bg-muted p-2 font-mono text-xs select-all"
        title={relay}
      >
        {relay}
      </code>
      <span
        className="hidden shrink-0 text-xs text-muted-foreground sm:inline-flex"
        title={connected ? "Connected" : "Disconnected"}
      >
        {connected ? (
          <WifiIcon className="h-4 w-4 text-green-500" />
        ) : (
          <WifiOffIcon className="h-4 w-4 text-gray-500" />
        )}
      </span>
      <span className="sr-only">
        {connected ? "Connected" : "Disconnected"}
      </span>
      <Button
        variant="destructive"
        size="sm"
        onClick={handleRemove}
        disabled={removing}
        aria-label={`Remove ${relay}`}
        className="h-9 w-9 shrink-0 px-0 sm:w-auto sm:px-3"
      >
        {removing ? (
          <Loader2Icon className="h-4 w-4 animate-spin" />
        ) : (
          <Trash2Icon className="h-4 w-4" />
        )}
        <span className="hidden sm:inline">Remove</span>
      </Button>
    </div>
  );
}
