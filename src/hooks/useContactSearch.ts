import { useState, useEffect, useMemo } from "react";
import { use$ } from "@/hooks/use$";
import { useEventStore } from "@/hooks/useEventStore";
import { useProfilesForPubkeys } from "@/hooks/useProfilesForPubkeys";
import { pool } from "@/services/nostr";
import { resilientRequest } from "@/lib/resilientSubscription";
import { mapEventsToStore } from "applesauce-core";
import { onlyEvents } from "applesauce-relay";
import { PublicContactsModel } from "applesauce-core/models";
import { useActiveAccount } from "applesauce-react/hooks";
import {
  getProfileContent,
  getPublicContacts,
  isValidProfile,
} from "applesauce-core/helpers";
import type { Filter } from "applesauce-core/helpers";
import type { ProfileContent } from "applesauce-core/helpers";
import { map } from "rxjs/operators";

// NIP-50 search relay — relay.ditto.pub supports the `search` filter field
const NIP50_RELAY = "wss://relay.ditto.pub";
const NIP50_DEBOUNCE_MS = 300;
const MAX_RESULTS = 8;
const NIP50_RESULT_LIMIT = 20;
const AUTHORS_PER_SEARCH_FILTER = 256;
const EMPTY_PUBKEYS: string[] = [];

/** kind:10017 — NIP-51 Git authors follow list */
const GIT_AUTHORS_KIND = 10017;

function getNip50SearchQuery(query: string): string {
  const trimmed = query.trim();
  const words = trimmed.split(/\s+/);

  // Ditto can return no matches while a new word is only one character long
  // (for example, "Derek R"), even though both "Derek" and "Derek Ro" match.
  // Search the completed words during that brief state, then apply the full
  // query to profile metadata locally below.
  if (words.length > 1 && words[words.length - 1]?.length === 1) {
    return words.slice(0, -1).join(" ");
  }

  return trimmed;
}

export interface ContactSearchResult {
  pubkey: string;
  profile: ProfileContent | undefined;
  isGitFollow: boolean;
  isSocialFollow: boolean;
}

export interface ContactSearchState {
  results: ContactSearchResult[];
  isSearching: boolean;
}

/**
 * Priority tiers for mention autocomplete results.
 *
 * 0 = priority pubkeys (repo maintainers, parent event participants)
 * 1 = git follows (kind:10017 — git author follow list)
 * 2 = social follows (kind:3 — Nostr contact list)
 * 3 = NIP-50 relay search results
 * 4 = EventStore cache hits (profiles already loaded for other reasons)
 */
type Tier = 0 | 1 | 2 | 3 | 4;

interface ScoredResult {
  pubkey: string;
  profile: ProfileContent | undefined;
  tier: Tier;
}

/**
 * Search for mentionable users with priority ordering:
 *   priority pubkeys → git follows → social follows → NIP-50 relay results → EventStore cache
 *
 * - Profile names are loaded reactively from the EventStore (Applesauce-native).
 * - NIP-50 search is debounced 300ms and fires against relay.ditto.pub.
 * - Priority users and follows are searched in author-constrained filters so
 *   they cannot be crowded out by the global NIP-50 result limit.
 * - When query is empty, shows priority pubkeys + git follows + social follows (up to MAX_RESULTS).
 * - Returns [] when no results are available yet.
 *
 * @param query           - The text typed after "@"
 * @param priorityPubkeys - Pubkeys to surface first (maintainers, participants)
 * @param excludePubkeys  - Pubkeys hidden by the owning autocomplete
 * @param enabled         - Whether the autocomplete is currently open
 */
export function useContactSearch(
  query: string,
  priorityPubkeys: string[] = EMPTY_PUBKEYS,
  excludePubkeys: string[] = EMPTY_PUBKEYS,
  enabled = true,
): ContactSearchState {
  const account = useActiveAccount();
  const store = useEventStore();

  // ── 1. Git follows (kind:10017) ───────────────────────────────────────────
  const myPubkey = account?.pubkey;
  const rawGitFollowPubkeys = use$(() => {
    if (!myPubkey) return undefined;
    return store.replaceable(GIT_AUTHORS_KIND, myPubkey).pipe(
      map((event) => {
        if (!event) return [] as string[];
        return getPublicContacts(event).map((contact) => contact.pubkey);
      }),
    );
  }, [myPubkey, store]);
  const gitFollowPubkeys = useMemo(
    () => rawGitFollowPubkeys ?? [],
    [rawGitFollowPubkeys],
  );

  // ── 2. Social follows (kind:3) ────────────────────────────────────────────
  const contacts = use$(() => {
    if (!myPubkey) return undefined;
    return store.model(PublicContactsModel, myPubkey);
  }, [myPubkey, store]);
  const followPubkeys = useMemo<string[]>(
    () => contacts?.map((contact) => contact.pubkey) ?? [],
    [contacts],
  );

  // ── 3. Candidate pubkey pool ──────────────────────────────────────────────
  // Union of priority + git follows + social follows, deduplicated, for profile fetching.
  const localPubkeys = useMemo<string[]>(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const pk of [
      ...priorityPubkeys,
      ...gitFollowPubkeys,
      ...followPubkeys,
    ]) {
      if (!seen.has(pk)) {
        seen.add(pk);
        out.push(pk);
      }
    }
    return out;
  }, [priorityPubkeys, gitFollowPubkeys, followPubkeys]);

  // Keep the first visible trusted candidates reactively profiled while the
  // dropdown is open. They can appear without profiles for an empty "@" query,
  // but matching typed text requires their metadata. Limiting this to the
  // visible result count avoids loading every follow.
  const seededProfilePubkeys = useMemo(() => {
    if (!enabled) return EMPTY_PUBKEYS;
    const excluded = new Set(excludePubkeys);
    return localPubkeys
      .filter((pubkey) => !excluded.has(pubkey))
      .slice(0, MAX_RESULTS);
  }, [enabled, excludePubkeys, localPubkeys]);
  const seededProfileMap = useProfilesForPubkeys(seededProfilePubkeys);

  // ── 4. NIP-50 search (debounced) ─────────────────────────────────────────
  const [nip50Pubkeys, setNip50Pubkeys] = useState<string[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setNip50Pubkeys([]);
      setIsSearching(false);
      return;
    }

    let sub: { unsubscribe(): void } | undefined;
    let cancelled = false;
    const nip50Query = getNip50SearchQuery(trimmed);
    setIsSearching(true);

    const timer = setTimeout(() => {
      setNip50Pubkeys([]); // clear stale results before new search
      const trustedFilters: Filter[] = [];
      for (
        let start = 0;
        start < localPubkeys.length;
        start += AUTHORS_PER_SEARCH_FILTER
      ) {
        trustedFilters.push({
          kinds: [0],
          authors: localPubkeys.slice(start, start + AUTHORS_PER_SEARCH_FILTER),
          search: nip50Query,
          limit: NIP50_RESULT_LIMIT,
        } as Filter);
      }
      const filters: Filter[] = [
        ...trustedFilters,
        {
          kinds: [0],
          search: nip50Query,
          limit: NIP50_RESULT_LIMIT,
        } as Filter,
      ];
      // Stream results as they arrive — each event triggers a state update so
      // the dropdown populates progressively rather than waiting for EOSE.
      sub = resilientRequest(pool, [NIP50_RELAY], filters)
        .pipe(onlyEvents(), mapEventsToStore(store))
        .subscribe({
          next: (ev) =>
            setNip50Pubkeys((prev) =>
              prev.includes(ev.pubkey) ? prev : [...prev, ev.pubkey],
            ),
          error: () => {
            if (!cancelled) setIsSearching(false);
          },
          complete: () => {
            if (!cancelled) setIsSearching(false);
          },
        });
    }, NIP50_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      sub?.unsubscribe();
    };
  }, [query, localPubkeys, store]);

  // ── 7. Profiles for NIP-50 results ───────────────────────────────────────
  // NIP-50 events are already synchronously in the store (mapEventsToStore
  // above completes before setNip50Pubkeys is called), so a plain synchronous
  // read is sufficient — no reactive subscription needed.
  const nip50ProfileMap = useMemo(() => {
    const profileMap = new Map<string, ProfileContent>();
    for (const pubkey of nip50Pubkeys) {
      const ev = store.getReplaceable(0, pubkey);
      if (ev && isValidProfile(ev)) {
        const content = getProfileContent(ev);
        if (content) profileMap.set(pubkey, content);
      }
    }
    return profileMap;
  }, [nip50Pubkeys, store]);

  // ── 5. Snapshot profiles for local candidates from the EventStore cache ────
  // We read synchronously from the store rather than opening a subscription
  // over potentially thousands of pubkeys. The actual network fetch for
  // rendered items is handled by UserAutocompleteDropdown via
  // useProfilesForPubkeys, which targets only the small set of pubkeys visible
  // in the dropdown.
  const localProfileMap = useMemo(() => {
    const profileMap = new Map<string, ProfileContent>();
    for (const pubkey of localPubkeys) {
      const ev = store.getReplaceable(0, pubkey);
      if (ev && isValidProfile(ev)) {
        const content = getProfileContent(ev);
        if (content) profileMap.set(pubkey, content);
      }
    }
    for (const [pubkey, profile] of seededProfileMap) {
      profileMap.set(pubkey, profile);
    }
    return profileMap;
  }, [localPubkeys, seededProfileMap, store]);

  // ── 6. Assemble + filter + sort ───────────────────────────────────────────
  const results = useMemo<ContactSearchResult[]>(() => {
    const lowerQuery = query.trim().toLowerCase();
    const prioritySet = new Set(priorityPubkeys);
    const gitFollowSet = new Set(gitFollowPubkeys);
    const followSet = new Set(followPubkeys);

    // Collect all candidate pubkeys with their tier
    const scored = new Map<string, ScoredResult>();

    const add = (
      pubkey: string,
      profile: ProfileContent | undefined,
      tier: Tier,
    ) => {
      const existing = scored.get(pubkey);
      // Keep the highest-priority (lowest tier number) entry
      if (!existing || tier < existing.tier) {
        scored.set(pubkey, { pubkey, profile, tier });
      }
    };

    // Tier 0: priority pubkeys
    for (const pk of priorityPubkeys) {
      add(pk, localProfileMap?.get(pk), 0);
    }

    // Tier 1: git follows
    for (const pk of gitFollowPubkeys) {
      const tier: Tier = prioritySet.has(pk) ? 0 : 1;
      add(pk, localProfileMap?.get(pk), tier);
    }

    // Tier 2: social follows
    for (const pk of followPubkeys) {
      let tier: Tier = 2;
      if (prioritySet.has(pk)) tier = 0;
      else if (gitFollowSet.has(pk)) tier = 1;
      add(pk, localProfileMap?.get(pk), tier);
    }

    // Tier 3: NIP-50 results
    for (const pk of nip50Pubkeys) {
      let tier: Tier = 3;
      if (prioritySet.has(pk)) tier = 0;
      else if (gitFollowSet.has(pk)) tier = 1;
      else if (followSet.has(pk)) tier = 2;
      const profile = nip50ProfileMap?.get(pk) ?? localProfileMap?.get(pk);
      add(pk, profile, tier);
    }

    // Tier 4: EventStore cache (profiles already loaded for other reasons)
    // Only include when there's a query — avoids flooding the empty-state list
    if (lowerQuery) {
      const cachedEvents = store.getByFilters([{ kinds: [0] }] as Filter[]);
      for (const ev of cachedEvents) {
        if (scored.has(ev.pubkey)) continue;
        if (!isValidProfile(ev)) continue;
        const content = getProfileContent(ev);
        if (!content) continue;
        add(ev.pubkey, content, 4);
      }
    }

    // Filter by query
    const candidates = Array.from(scored.values()).filter(
      ({ profile, tier }) => {
        if (!lowerQuery) {
          // Empty query: show priority + git follows + social follows regardless
          // of whether their profile is loaded yet
          return tier <= 2;
        }
        // With a query we can only match against profile metadata — if we don't
        // have a profile for this pubkey yet, we have nothing to search against
        // so exclude it. It will appear once its profile arrives in the store.
        if (!profile) return false;
        const name = (profile.name ?? "").toLowerCase();
        const displayName = (
          profile.display_name ??
          profile.displayName ??
          ""
        ).toLowerCase();
        const nip05 = (profile.nip05 ?? "").toLowerCase();
        return (
          name.includes(lowerQuery) ||
          displayName.includes(lowerQuery) ||
          nip05.includes(lowerQuery)
        );
      },
    );

    // Sort: tier first, then alphabetical within tier
    candidates.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      const nameA = (
        a.profile?.display_name ??
        a.profile?.displayName ??
        a.profile?.name ??
        a.pubkey
      ).toLowerCase();
      const nameB = (
        b.profile?.display_name ??
        b.profile?.displayName ??
        b.profile?.name ??
        b.pubkey
      ).toLowerCase();
      return nameA.localeCompare(nameB);
    });

    return candidates.slice(0, MAX_RESULTS).map(({ pubkey, profile }) => ({
      pubkey,
      profile,
      isGitFollow: gitFollowSet.has(pubkey),
      isSocialFollow: followSet.has(pubkey),
    }));
  }, [
    query,
    priorityPubkeys,
    gitFollowPubkeys,
    followPubkeys,
    localProfileMap,
    nip50Pubkeys,
    nip50ProfileMap,
    store,
  ]);

  return { results, isSearching };
}
