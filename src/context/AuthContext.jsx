// Who is signed in, what they may do, and which organisations they may open.
//
// The server answers all of it in one call. GET /api/v1/auth/me returns the
// user, the organisations they can open, the permissions they hold IN EACH
// (org-scoped roles mean the answer differs per organisation), and the vehicle
// scope where their view is narrowed. Splitting that across several requests
// would mean rendering a half-authorised UI while the rest arrived.
//
// That answer is one TanStack Query entry (authKeys.me): `null` is signed out,
// an object is signed in. Sign-in is a mutation that writes the entry; sign-out
// and a lost session empty it AND drop every other cached query, so the next
// person to sign in on this browser never sees the last one's fleet, reports
// or feed. `useAuth()` keeps the shape every screen was written against.
//
// The access token itself stays out of the cache, in memory in services/api.
//
// <AuthProvider> now only registers the session-lost handler; it still sits
// above AppProvider, whose organisation switcher is built from `orgs`.

import { useCallback, useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, setAccessToken, setSessionLostHandler, refreshOnce } from "../services/api";
import { ACCESS_CHANGED } from "../lib/accessChanged";

export const authKeys = { me: ["auth", "me"] };

const readMe = async () => (await apiFetch("/api/v1/auth/me")).data;

/**
 * Silent re-login, then who this is. The access token lives in memory and is
 * gone after a reload; the refresh cookie is httpOnly and survives, so trading
 * it here keeps a signed-in user signed in across reloads. No session is not an
 * error — it is the signed-out state, and the login screen says so already.
 */
async function bootSession() {
  try {
    await refreshOnce();
    return await readMe();
  } catch {
    setAccessToken(null);
    return null;
  }
}

const meQuery = {
  queryKey: authKeys.me,
  queryFn: bootSession,
  // Changes by sign-in, sign-out, an explicit reload(), or a role change
  // (AuthProvider below re-reads it; the query itself never refetches).
  staleTime: Infinity,
  gcTime: Infinity,
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
};

/** Signed out: forget the token, the user, and everything read as them. */
function signOutLocally(queryClient) {
  setAccessToken(null);
  queryClient.setQueryData(authKeys.me, null);
  // On the next tick, once the login screen has replaced the app: removed
  // while its screens are still mounted, a query would just be re-created by
  // its reader and asked again without a token.
  setTimeout(() => {
    if (queryClient.getQueryData(authKeys.me)) return;   // already signed back in
    queryClient.cancelQueries({ predicate: (q) => q.queryKey[0] !== "auth" });
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== "auth" });
  }, 0);
}

export function AuthProvider({ children }) {
  const queryClient = useQueryClient();
  // A refused refresh anywhere in the app means the cookie is spent — most
  // often because token reuse was detected and the family was revoked. Drop
  // straight to the login screen rather than letting every panel render its
  // own "failed to load".
  useEffect(() => {
    setSessionLostHandler(() => signOutLocally(queryClient));
    return () => setSessionLostHandler(null);
  }, [queryClient]);

  /* A role change shows at once (operator, 2026-10-27). The live stream's
     `access_changed` is the prompt; returning to the tab and a slow timer are
     the fallback for accounts with no stream open (no live map, a closed
     laptop, a dropped connection). Only re-read while signed in. */
  useEffect(() => {
    let busy = false;
    const reread = async () => {
      if (busy || !queryClient.getQueryData(authKeys.me)) return;
      busy = true;
      try {
        const data = await readMe();
        if (data) queryClient.setQueryData(authKeys.me, data);
      } catch { /* a lost session is handled by apiFetch; anything else waits for the next prompt */ }
      finally { busy = false; }
    };
    const onVisible = () => { if (document.visibilityState === "visible") reread(); };
    window.addEventListener(ACCESS_CHANGED, reread);
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(reread, ACCESS_POLL_MS);
    return () => {
      window.removeEventListener(ACCESS_CHANGED, reread);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, [queryClient]);
  return children;
}

/** The fallback re-read of /auth/me for a signed-in tab with no live stream. */
const ACCESS_POLL_MS = 2 * 60_000;

export function useAuth() {
  const queryClient = useQueryClient();
  // `booting` covers the silent-refresh round trip on first load. Rendering
  // the login screen during it would flash a sign-in form at someone who is
  // already signed in, on every single page load.
  const { data: me, isPending: booting } = useQuery(meQuery);

  const signIn = useMutation({
    mutationKey: ["auth", "login"],
    mutationFn: async ({ email, password }) => {
      const { data } = await apiFetch("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setAccessToken(data.accessToken ?? null);
      return readMe();
    },
    onSuccess: (data) => queryClient.setQueryData(authKeys.me, data),
  });

  const login = useCallback(async (email, password) => {
    try {
      await signIn.mutateAsync({ email, password });
      return true;
    } catch {
      return false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signIn.mutateAsync]);

  const logout = useCallback(async () => {
    // The cookie is what actually ends the session, so the request matters
    // more than its answer — clear locally whatever it says.
    try { await apiFetch("/api/v1/auth/logout", { method: "POST" }); } catch { /* ignore */ }
    signOutLocally(queryClient);
  }, [queryClient]);

  /** Read who this is again (after a role or profile change); resolves to the answer. */
  const reload = useCallback(async () => {
    const data = await readMe();
    queryClient.setQueryData(authKeys.me, data);
    return data;
  }, [queryClient]);

  // The server answers every failed sign-in identically on purpose, so nobody
  // can probe which addresses exist. Pass that through unchanged.
  const err = signIn.error;
  const error = err ? (err.status === 401 ? "Invalid email or password." : (err.message ?? "Sign-in failed.")) : null;

  return useMemo(() => {
    const user = me?.user ?? null;
    const orgs = me?.organisations ?? NO_ORGS;   // [{ id, name, code, permissions[], vehicleIds|null }]
    const byId = new Map(orgs.map((o) => [o.id, o]));
    const permsFor = (orgId) => new Set(byId.get(orgId)?.permissions ?? []);

    return {
      user,
      orgs,
      isPlatform: Boolean(me?.isPlatform),
      booting,
      error,
      isAuthenticated: Boolean(user),
      login,
      logout,
      reload,

      /**
       * Does this person hold `slug` in this organisation?
       *
       * `platform:admin` is the wildcard the server also honours; checking it
       * here as well keeps the UI from hiding controls a super admin would then
       * find perfectly usable if they guessed the URL.
       */
      can: (slug, orgId) => {
        const held = permsFor(orgId);
        return held.has("platform:admin") || held.has(slug);
      },

      /**
       * The vehicles visible in this organisation, or NULL for no restriction.
       *
       * Null and an empty array are different answers and must not be
       * conflated: null is the whole fleet, an empty array is nothing.
       */
      vehicleScope: (orgId) => byId.get(orgId)?.vehicleIds ?? null,
    };
  }, [me, booting, error, login, logout, reload]);
}

const NO_ORGS = [];
