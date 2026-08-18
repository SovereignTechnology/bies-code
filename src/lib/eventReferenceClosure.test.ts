import type { NostrEvent } from "nostr-tools";
import { BehaviorSubject, Observable, Subject } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import {
  loadEventReferenceClosure,
  type EventReferenceClosureResponse,
} from "@/lib/eventReferenceClosure";

function event(id: string, kind: number): NostrEvent {
  return {
    id,
    kind,
    pubkey: "pubkey",
    created_at: 1,
    content: "",
    tags: [],
    sig: "sig",
  };
}

describe("loadEventReferenceClosure", () => {
  it("loads late descendants once per relay and tears down every loader", () => {
    const relayUrls$ = new BehaviorSubject(["wss://repo.example"]);
    const streams = new Map<string, Subject<EventReferenceClosureResponse>>();
    const activeSubscriptions = new Map<string, number>();

    const loadReferences = vi.fn(
      (eventId: string, relays: string[]) =>
        new Observable<EventReferenceClosureResponse>((subscriber) => {
          const key = `${eventId}:${relays.join(",")}`;
          activeSubscriptions.set(key, (activeSubscriptions.get(key) ?? 0) + 1);

          let stream = streams.get(eventId);
          if (!stream) {
            stream = new Subject<EventReferenceClosureResponse>();
            streams.set(eventId, stream);
          }
          const streamSub = stream.subscribe(subscriber);

          return () => {
            streamSub.unsubscribe();
            activeSubscriptions.set(key, activeSubscriptions.get(key)! - 1);
          };
        }),
    );

    const received: EventReferenceClosureResponse[] = [];
    const closureSub = loadEventReferenceClosure(
      "root",
      relayUrls$,
      loadReferences,
    ).subscribe((message) => received.push(message));

    expect(loadReferences).toHaveBeenCalledWith("root", ["wss://repo.example"]);

    // The relay may settle before an intermediate comment arrives. The live
    // stream must still extend the closure when that comment appears later.
    streams.get("root")!.next("EOSE");
    streams.get("root")!.next(event("late-comment", 1111));
    expect(loadReferences).toHaveBeenCalledWith("late-comment", [
      "wss://repo.example",
    ]);

    streams.get("late-comment")!.next(event("nested-like", 7));
    expect(loadReferences).toHaveBeenCalledWith("nested-like", [
      "wss://repo.example",
    ]);

    streams.get("nested-like")!.next(event("like-deletion", 5));
    expect(loadReferences).toHaveBeenCalledWith("like-deletion", [
      "wss://repo.example",
    ]);
    expect(received).toContainEqual(event("nested-like", 7));
    expect(received).toContainEqual(event("like-deletion", 5));

    // Duplicate delivery and equivalent relay URLs must not schedule another
    // historical request for the same event/relay pair.
    streams.get("root")!.next(event("late-comment", 1111));
    relayUrls$.next(["wss://repo.example/"]);
    expect(
      loadReferences.mock.calls.filter(
        ([eventId]) => eventId === "late-comment",
      ),
    ).toEqual([["late-comment", ["wss://repo.example"]]]);

    // A genuinely new repository relay is queried once for every event that
    // has already entered the closure.
    relayUrls$.next(["wss://repo.example", "wss://mirror.example"]);
    for (const eventId of [
      "root",
      "late-comment",
      "nested-like",
      "like-deletion",
    ]) {
      expect(loadReferences).toHaveBeenCalledWith(eventId, [
        "wss://mirror.example",
      ]);
    }

    closureSub.unsubscribe();
    expect(
      [...activeSubscriptions.values()].every((count) => count === 0),
    ).toBe(true);
  });
});
