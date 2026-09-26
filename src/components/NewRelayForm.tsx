import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ensureWebSocketURL } from "applesauce-core/helpers";
import { normalizeUrl } from "@/lib/url";

export function NewRelayForm({
  onAdd,
}: {
  onAdd: (relay: string) => void | Promise<void>;
}) {
  const [newRelay, setNewRelay] = useState("");
  const [adding, setAdding] = useState(false);

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAdd();
    }
  };

  const handleAdd = async (e?: React.FormEvent<HTMLFormElement>) => {
    e?.preventDefault();
    setAdding(true);
    await onAdd(normalizeUrl(ensureWebSocketURL(newRelay.trim())));
    setNewRelay("");
    setAdding(false);
  };

  return (
    <form className="flex w-full min-w-0 gap-2" onSubmit={handleAdd}>
      <Input
        type="text"
        placeholder="wss://relay.example.com"
        value={newRelay}
        onChange={(e) => setNewRelay(e.target.value)}
        onKeyDown={handleKeyPress}
        className="min-w-0 flex-1"
        disabled={adding}
      />
      <Button
        type="submit"
        disabled={!newRelay.trim() || adding}
        className="shrink-0"
      >
        Add
      </Button>
    </form>
  );
}
