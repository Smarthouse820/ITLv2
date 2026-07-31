// In The Lab Fitness — service worker
//
// SCOPE: this file does push notifications and nothing else. It deliberately does NOT cache —
// every fetch goes straight to the network, unchanged. That was true before and stays true: while
// the app is deploying several times a day, a cache is a way to serve someone yesterday's build.
//
// PUSH ADDED 2026-07-31, and it closes a gap that made every other piece of push infrastructure
// pointless. The app was subscribing correctly (five real subscriptions live in the Worker's KV
// namespace, across FCM and Apple endpoints), and the Cloudflare cron was genuinely sending to
// them every 15 minutes — but a service worker with NO 'push' listener receives the payload and
// silently discards it. Nothing ever appeared on anyone's phone. Some browsers additionally show
// their own generic "this site was updated in the background" notice in that situation, which is
// worse than silence because it looks like the app did something wrong.
// So: every layer existed except the last fifteen lines, and nothing anywhere reported a failure.

self.addEventListener("install", function () {
  // Take over immediately rather than waiting for every tab to close. Reminders are the whole
  // point of this file — a fix that only lands after the user quits the app is not a fix.
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", function (event) {
  // Pass-through, with a catch. Previously this was a bare respondWith(fetch(...)), which is
  // slightly WORSE than having no fetch handler at all: when the network is unavailable the
  // promise rejects and the browser shows its own failure instead of the graceful behaviour it
  // would have used if the service worker had never intervened. Falling back to fetch() here
  // hands control back rather than turning an offline moment into a broken page.
  event.respondWith(fetch(event.request).catch(function () { return fetch(event.request); }));
});

// ---------------------------------------------------------------------------
// PUSH
// The Worker sends: JSON.stringify({ title, body }) — see checkAllSchedulesAndNotify in the
// worker source. Keep this parser tolerant: a payload that fails to parse must still produce a
// notification, because a silent drop is the exact failure this handler exists to end.
// ---------------------------------------------------------------------------
self.addEventListener("push", function (event) {
  var payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    // Not JSON — fall back to the raw text as the body rather than showing nothing.
    try { payload = { body: event.data.text() }; } catch (e2) { payload = {}; }
  }

  var title = payload.title || "In The Lab Fitness";
  var options = {
    body: payload.body || "You have a reminder.",
    icon: "icon-192.png",
    badge: "icon-192.png",
    // Tag + renotify: a second reminder REPLACES an unread one rather than stacking a pile of
    // them on the lock screen, but still alerts. Reminders are time-specific — three stale ones
    // are noise, and noise is how people turn notifications off.
    tag: payload.tag || "itl-reminder",
    renotify: true,
    // Vibration also improves relay to a paired watch, which is where a gym reminder is most
    // likely to actually be seen.
    vibrate: [200, 100, 200],
    // Carried through to notificationclick so a future payload can deep-link to a tab.
    data: { url: payload.url || "/", sentAt: Date.now() },
  };

  // waitUntil is REQUIRED, not optional: without it the service worker may be terminated before
  // showNotification resolves, and the notification never appears. That failure is intermittent
  // and load-dependent, which makes it far harder to diagnose than the one this file just fixed.
  event.waitUntil(self.registration.showNotification(title, options));
});

// ---------------------------------------------------------------------------
// CLICK
// Focus an existing tab if the app is already open; otherwise open one. Without this, tapping a
// reminder dismisses it and does nothing — which teaches people the notifications aren't worth
// tapping.
// ---------------------------------------------------------------------------
self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        // Any open tab on this origin counts — reusing it is better than spawning a duplicate,
        // and the app is a single page so there is nowhere else it needs to go.
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
