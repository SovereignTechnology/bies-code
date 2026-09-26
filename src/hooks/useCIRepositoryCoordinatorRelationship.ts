import { useMemo } from "react";
import type { CastRefEventStore } from "applesauce-common/casts/cast";
import type { Filter } from "applesauce-core/helpers";
import type { NostrEvent } from "nostr-tools";
import { of } from "rxjs";
import { map } from "rxjs/operators";
import {
  CIServiceControl,
  isValidCIServiceControl,
} from "@/casts/CICoordinator";
import { use$ } from "@/hooks/use$";
import { useEventStore } from "@/hooks/useEventStore";
import { CI_SERVICE_REQUEST_KIND, CI_SERVICE_STOP_KIND } from "@/lib/ci";
import type { CICoordinatorRelationship } from "@/lib/ciCoordinatorRelationship";
import type { ResolvedRepo } from "@/lib/nip34";
import { ciRepositoryServiceControls$ } from "@/services/ciQueries";

export interface CIRepositoryCoordinatorRelationshipState {
  relationship: CICoordinatorRelationship;
  settled: boolean;
  partial: boolean;
}

const EMPTY_CONTROLS: readonly CIServiceControl[] = [];

function isLaterControl(a: CIServiceControl, b: CIServiceControl): boolean {
  if (a.event.created_at !== b.event.created_at) {
    return a.event.created_at > b.event.created_at;
  }
  return a.event.id.localeCompare(b.event.id) < 0;
}

/** Resolve one repository's maintainer-authored relationship to a coordinator. */
export function useCIRepositoryCoordinatorRelationship(
  repo: ResolvedRepo | undefined,
  coordinatorPubkey: string,
): CIRepositoryCoordinatorRelationshipState {
  const store = useEventStore();
  const castStore = store as unknown as CastRefEventStore;
  const coordinates = repo?.confirmedMaintainerCoordinates ?? [];
  const maintainers = repo?.confirmedMaintainers ?? [];
  const relays = repo?.relays ?? [];
  const coordinateKey = [...coordinates].sort().join(",");
  const maintainerKey = [...maintainers].sort().join(",");
  const relayKey = [...relays].sort().join(",");

  const query = use$(() => {
    if (!repo) {
      return of({ settled: false, relayCount: 0, failedRelayCount: 0 });
    }
    if (coordinates.length === 0 || maintainers.length === 0) {
      return of({
        settled: true,
        relayCount: relays.length,
        failedRelayCount: 0,
      });
    }
    return ciRepositoryServiceControls$(coordinates, maintainers, relays);
  }, [coordinateKey, maintainerKey, relayKey, repo !== undefined]);

  const controls: readonly CIServiceControl[] =
    use$(() => {
      if (!repo || coordinates.length === 0 || maintainers.length === 0) {
        return of([] as CIServiceControl[]);
      }
      return store
        .timeline([
          {
            kinds: [CI_SERVICE_REQUEST_KIND, CI_SERVICE_STOP_KIND],
            authors: maintainers,
            "#a": coordinates,
          } as Filter,
        ])
        .pipe(
          map((events) =>
            (events as NostrEvent[]).flatMap((event) =>
              isValidCIServiceControl(event)
                ? [new CIServiceControl(event, castStore)]
                : [],
            ),
          ),
        );
    }, [coordinateKey, maintainerKey, repo !== undefined, store]) ??
    EMPTY_CONTROLS;

  const relationship = useMemo<CICoordinatorRelationship>(() => {
    const matching = controls.filter(
      (control) => control.coordinatorPubkey === coordinatorPubkey,
    );
    const latest = matching.reduce<CIServiceControl | undefined>(
      (current, control) =>
        !current || isLaterControl(control, current) ? control : current,
      undefined,
    );
    const wasRequested = matching.some((control) => control.isRequest);
    return {
      level: latest?.isRequest
        ? "requested"
        : wasRequested
          ? "previously-requested"
          : "unassociated",
      manualRunCount: 0,
      serviceRunCount: 0,
      requesterPubkeys: [
        ...new Set(
          matching
            .filter((control) => control.isRequest)
            .map((control) => control.event.pubkey),
        ),
      ],
    };
  }, [controls, coordinatorPubkey]);

  const settled = query?.settled === true;
  return {
    relationship,
    settled,
    partial:
      (query?.failedRelayCount ?? 0) > 0 ||
      (settled && (query?.relayCount ?? 0) === 0),
  };
}
