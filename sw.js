/* ============================================================
   揀啱 PICKED RIGHT IT — Service Worker
   策略:
   - /api/ 一律唔cache(收銀/落單/數據必須即時)
   - 頁面(HTML):network-first,離線先用cache後備
   - 靜態資源(icon/manifest):cache-first
   改版時記得升VERSION,舊cache會自動清走
   ============================================================ */
const VERSION = "prit-v1";
const CORE = ["/", "/track.html", "/favicon.svg", "/icon-192.png", "/icon-512.png", "/manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;                 // 非GET唔掂
  if (url.origin !== location.origin) return;             // 第三方(Stripe/CJ圖)唔掂
  if (url.pathname.startsWith("/api/")) return;           // API一律直連

  // 靜態資源:cache-first
  if (/\.(png|svg|json|ico)$/.test(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        const clone = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, clone));
        return res;
      }))
    );
    return;
  }

  // 頁面/其他:network-first,離線fallback cache
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("/")))
  );
});
