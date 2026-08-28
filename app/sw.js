// Service worker: cache the app shell so the PWA opens locally like an app;
// the URL is only checked for updates (spec §1: the PWA is the larva, the APK
// is the product). Bump VERSION on every deploy that changes app files —
// clients pick the new shell up on the next open after that.
const VERSION = "tsct-app-v2";
const SHELL = [
  "./",
  "./index.html",
  "./ui.js",
  "./build.js",
  "./drive.js",
  "./pipeline.js",
  "./core/config.js",
  "./core/prompts.js",
  "./core/questions.js",
  "./core/gift.js",
  "./core/costs.js",
  "./core/runname.js",
  "./core/gemini.js",
  "./vendor/js-yaml.min.js",
  "./icon.svg",
  "./manifest.webmanifest",
  "../resources/system.yaml",
  "../resources/prompts/transcription.txt",
  "../resources/prompts/generation_system.txt",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// App-shell requests: network first (so a deploy is picked up when online),
// cache fallback (so the app opens with no network). API calls pass through.
// cache:"no-cache" forces revalidation with the server — GitHub Pages sends a
// 10-minute max-age, which otherwise lets plain F5 serve a stale shell from
// the browser's HTTP cache after a deploy (seen 2026-08-28).
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request, { cache: "no-cache" })
      .then((r) => {
        const copy = r.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return r;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((m) => m || caches.match("./index.html")))
  );
});
