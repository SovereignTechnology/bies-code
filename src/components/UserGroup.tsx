import { UserAvatar, UserLink } from "@/components/UserAvatar";
import { cn } from "@/lib/utils";

/**
 * Compactly name a small group of people, then collapse larger groups into
 * overlapping avatars and a remaining count.
 */
export function UserGroup({
  pubkeys,
  className,
}: {
  pubkeys: readonly string[];
  className?: string;
}) {
  if (pubkeys.length === 0) return null;

  const person = (pubkey: string) => (
    <UserLink
      key={pubkey}
      pubkey={pubkey}
      noLink
      className="inline-flex rounded-full bg-muted/70 py-0.5 pl-0.5 pr-2 text-foreground"
      nameClassName="text-xs"
    />
  );

  if (pubkeys.length === 1) {
    return (
      <span className={cn("inline", className)}>{person(pubkeys[0])}</span>
    );
  }
  if (pubkeys.length === 2) {
    return (
      <span className={cn("inline", className)}>
        {person(pubkeys[0])} <span>and</span> {person(pubkeys[1])}
      </span>
    );
  }
  if (pubkeys.length === 3) {
    return (
      <span className={cn("inline", className)}>
        {person(pubkeys[0])}, {person(pubkeys[1])} <span>and</span>{" "}
        {person(pubkeys[2])}
      </span>
    );
  }

  const avatarPubkeys = pubkeys.slice(2, 6);
  const remainingCount = pubkeys.length - avatarPubkeys.length - 2;
  return (
    <span className={cn("inline", className)}>
      {person(pubkeys[0])}, {person(pubkeys[1])} <span>and</span>{" "}
      <span className="inline-flex -space-x-1.5 align-middle">
        {avatarPubkeys.map((pubkey) => (
          <UserAvatar
            key={pubkey}
            pubkey={pubkey}
            size="sm"
            className="h-5 w-5 border border-background text-[8px]"
            noHoverCard
          />
        ))}
      </span>
      {remainingCount > 0 && <span> +{remainingCount}</span>}
    </span>
  );
}
