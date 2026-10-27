/**
 * Web Push on this browser: register the service worker (public/push-sw.js),
 * ask for permission, and hand the subscription to the server under the
 * signed-in user. The server pushes repair ticket numbers to the operator,
 * Head of Security and Assistant Head of Security (2026-10-27).
 *
 * Permission is asked only from a click (the account menu), never on load:
 * browsers bury or block a prompt nobody asked for.
 */
import { apiFetch } from "../services/api";

const SW_URL = "/push-sw.js";

export const pushSupported = () =>
  typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** "unsupported" | "denied" | "on" | "off" */
export async function pushState() {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration(SW_URL);
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "on" : "off";
}

function keyBytes(base64url) {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function subscription() {
  const reg = await navigator.serviceWorker.register(SW_URL);
  await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  if (existing) return existing;
  const { data } = await apiFetch("/api/v1/notifications/vapid-key");
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(data.publicKey) });
}

const send = (orgId, sub) => apiFetch(`/api/v1/organisations/${orgId}/notifications/subscribe`, {
  method: "POST", body: JSON.stringify({ subscription: sub.toJSON() }),
});

/** From a click: ask, subscribe, register with the server. Resolves to the new state. */
export async function enablePush(orgId) {
  if (!pushSupported()) return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  await send(orgId, await subscription());
  return "on";
}

export async function disablePush(orgId) {
  const reg = await navigator.serviceWorker.getRegistration(SW_URL);
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await apiFetch(`/api/v1/organisations/${orgId}/notifications/subscribe`, {
      method: "DELETE", body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => {});
    await sub.unsubscribe();
  }
  return "off";
}

/**
 * Re-send an existing subscription once a session starts, without asking:
 * it ties the device to whoever is signed in now, and a browser that rotated
 * the endpoint gets the new one on file.
 */
export async function refreshPush(orgId) {
  if (!orgId || !pushSupported() || Notification.permission !== "granted") return;
  const reg = await navigator.serviceWorker.getRegistration(SW_URL);
  const sub = await reg?.pushManager.getSubscription();
  if (sub) await send(orgId, sub).catch(() => {});
}
