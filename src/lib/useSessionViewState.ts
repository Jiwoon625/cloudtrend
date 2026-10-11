import { useState, type Dispatch, type SetStateAction } from "react";

const prefix = "cloudtrend-view-v1:";
let sessionViewOwner: string | null | undefined;
/** CloudAccount calls this before revealing authenticated children or changing users. */
export function syncSessionViewOwner(owner: string | null): void {
  sessionViewOwner = owner;
  try {
    if (typeof window === "undefined") return;
    const storage = window.sessionStorage;
    const ownerKey = prefix + "owner";
    if (owner === null || storage.getItem(ownerKey) !== owner) {
      const keys: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key?.startsWith(prefix)) keys.push(key);
      }
      for (const key of keys) storage.removeItem(key);
    }
    if (owner !== null) storage.setItem(ownerKey, owner);
  } catch {
    /* Storage access is optional and never blocks authentication. */
  }
}

export function readSessionViewState<T>(
  key: string | undefined,
  initial: T,
  valid: (value: unknown) => value is T,
): T {
  try {
    if (
      key === undefined ||
      typeof window === "undefined" ||
      !sessionViewOwner ||
      window.sessionStorage.getItem(prefix + "owner") !== sessionViewOwner
    )
      return initial;
    const raw = window.sessionStorage.getItem(prefix + key);
    if (!raw) return initial;
    const parsed: unknown = JSON.parse(raw);
    return valid(parsed) ? parsed : initial;
  } catch {
    return initial;
  }
}

/** Tab-local UI preferences only; no rows, holdings, tokens or raw results are stored. */
export function useSessionViewState<T>(
  key: string | undefined,
  initial: T,
  valid: (value: unknown) => value is T,
): [T, Dispatch<SetStateAction<T>>] {
  const owner = sessionViewOwner;
  const [value, setValue] = useState<T>(
    typeof window === "undefined" ? initial : () => readSessionViewState(key, initial, valid),
  );
  const [scope, setScope] = useState({ key, owner });
  const scopeChanged = scope.key !== key || scope.owner !== owner;
  const current = scopeChanged ? readSessionViewState(key, initial, valid) : value;
  if (scopeChanged) {
    // A caller may change modes without unmounting. Never carry its previous view
    // into another key/account, or write that view into the new scope.
    setScope({ key, owner });
    setValue(current);
  }
  const set: Dispatch<SetStateAction<T>> = (next) =>
    setValue((previous) => {
      if (owner !== sessionViewOwner) return previous;
      const resolved = typeof next === "function" ? (next as (value: T) => T)(previous) : next;
      const safe = valid(resolved) ? resolved : initial;
      try {
        if (key !== undefined && typeof window !== "undefined" && sessionViewOwner) {
          if (window.sessionStorage.getItem(prefix + "owner") !== sessionViewOwner)
            syncSessionViewOwner(sessionViewOwner);
          window.sessionStorage.setItem(prefix + key, JSON.stringify(safe));
        }
      } catch {
        /* Navigation still works when storage is disabled. */
      }
      return safe;
    });
  return [current, set];
}
export const viewText = (v: unknown): v is string => typeof v === "string" && v.length <= 500;
export const viewPage = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10000;
export const viewChoice =
  <T extends string>(choices: readonly T[]) =>
  (v: unknown): v is T =>
    typeof v === "string" && choices.includes(v as T);
