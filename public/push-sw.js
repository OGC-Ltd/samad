/*
 * Web Push service worker. Shows the notifications the server pushes (repair
 * ticket numbers to the operator and the security heads, 2026-10-27) and
 * brings the app forward when one is clicked. Nothing is cached here.
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let p = {};
  try { p = event.data ? event.data.json() : {}; } catch { p = { title: "Rai Operations", body: event.data?.text() ?? "" }; }
  event.waitUntil(self.registration.showNotification(p.title || "Rai Operations", {
    body: p.body || "",
    icon: p.icon || "/samad-logo.svg",
    badge: p.badge || "/samad-logo.svg",
    tag: p.tag,
    data: p.data || {},
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const here = open.find((c) => new URL(c.url).origin === self.location.origin);
    if (here) return here.focus();
    return self.clients.openWindow(url);
  })());
});
