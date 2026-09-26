export function DraftStatus({ saved }: { saved: boolean }) {
  if (saved) return null;

  return (
    <p role="status" className="text-xs text-muted-foreground">
      Changes could not be saved on this device
    </p>
  );
}
