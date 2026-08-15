import { nip19 } from "nostr-tools";
import { UserLink, type UserLinkProps } from "@/components/UserAvatar";

type CICoordinatorLinkProps = Omit<UserLinkProps, "profilePath">;

/** Identity link whose primary destination is the CI coordinator profile. */
export function CICoordinatorLink({
  pubkey,
  ...props
}: CICoordinatorLinkProps) {
  return (
    <UserLink
      {...props}
      pubkey={pubkey}
      profilePath={`/coordinator/${nip19.npubEncode(pubkey)}`}
    />
  );
}
