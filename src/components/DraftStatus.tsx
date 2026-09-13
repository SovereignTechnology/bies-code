import { Button } from "@/components/ui/button";

export function DraftStatus({
  saved,
  onDiscard,
}: {
  saved: boolean;
  onDiscard: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
      <span role="status">
        {saved
          ? "Draft saved on this device"
          : "Changes could not be saved on this device"}
      </span>
      <Button type="button" variant="ghost" size="sm" onClick={onDiscard}>
        Discard draft
      </Button>
    </div>
  );
}
