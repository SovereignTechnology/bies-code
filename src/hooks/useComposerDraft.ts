import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useActiveAccount } from "applesauce-react/hooks";
import { z } from "zod";

const schema = z.object({
  subject: z.string().default(""),
  body: z.string().default(""),
  labels: z.array(z.string()).default([]),
  uploadedTagGroups: z.array(z.array(z.array(z.string()))).default([]),
});
type Draft = z.infer<typeof schema>;
const empty = schema.parse({});
interface Snapshot {
  raw: string | null;
  saved: boolean;
}
const snapshots = new Map<string, Snapshot>();
const listeners = new Set<() => void>();
let listening = false;
const notify = () => listeners.forEach((listener) => listener());
function onStorage(event: StorageEvent) {
  if (event.key === null) snapshots.clear();
  else snapshots.delete(event.key);
  notify();
}
function subscribe(listener: () => void) {
  if (!listening) {
    window.addEventListener("storage", onStorage);
    listening = true;
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function read(key: string): Snapshot {
  const cached = snapshots.get(key);
  if (cached) return cached;
  let snapshot: Snapshot;
  try {
    snapshot = { raw: localStorage.getItem(key), saved: true };
  } catch {
    snapshot = { raw: null, saved: false };
  }
  snapshots.set(key, snapshot);
  return snapshot;
}
function decode(value: string | null): Draft {
  try {
    return schema.parse(JSON.parse(value ?? "{}"));
  } catch {
    return empty;
  }
}
function write(key: string, draft: Draft) {
  const hasText = !!(draft.subject.trim() || draft.body.trim());
  // Preserve whitespace and metadata during editing, even when nothing needs persisting.
  const raw = JSON.stringify(draft);
  let saved = true;
  try {
    if (!hasText) localStorage.removeItem(key);
    else localStorage.setItem(key, raw);
  } catch {
    saved = false;
  }
  snapshots.set(key, { raw, saved });
  notify();
}

/** Local only; anonymous drafts never migrate into a signed-in account. */
export function useComposerDraft(scope: string) {
  const account = useActiveAccount();
  const key = `gitworkshop:draft:v1:${account?.pubkey ?? "anonymous"}:${scope}`;
  const snapshot = useSyncExternalStore(subscribe, () => read(key));
  const { raw, saved } = snapshot;
  const draft = useMemo(() => decode(raw), [raw]);
  const update = useCallback(
    <K extends keyof Draft>(
      field: K,
      value: Draft[K] | ((previous: Draft[K]) => Draft[K]),
    ) => {
      const current = decode(read(key).raw);
      write(key, {
        ...current,
        [field]: typeof value === "function" ? value(current[field]) : value,
      });
    },
    [key],
  );
  // Capture the submitted version so a late completion cannot erase newer edits.
  const clear = useCallback(() => {
    if (read(key) === snapshot) write(key, empty);
  }, [key, snapshot]);
  return {
    key,
    draft,
    update,
    clear,
    hasDraft: !!(draft.subject.trim() || draft.body.trim()),
    saved,
  };
}
