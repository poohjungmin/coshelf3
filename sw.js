// Coshelf service worker
//
// 캐싱 전략 (별도 js/css 파일이 없는 단일 파일 앱이라 단순하게 유지):
// - index.html(네비게이션 요청)은 항상 네트워크를 먼저 시도한다(network-first).
//   GitHub Pages 새 배포가 홈 화면 앱 재실행 시 곧바로 반영되도록 하기 위함.
//   오프라인일 때만 캐시로 폴백한다.
// - 아이콘/매니페스트 같은 정적 자산은 cache-first로 서빙한다(자주 안 바뀜).
// - 그 외 cross-origin 요청(Gemini API, Firebase/gstatic CDN 등)은 손대지 않는다.

const CACHE_VERSION = "v1";
const CACHE_NAME = `coshelf-${CACHE_VERSION}`;
const PRECACHE_ASSETS = ["./", "icon.png", "icon-512.png", "manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
      .catch((e) => console.error("[ServiceWorker] 사전 캐싱 실패:", e))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  try {
    const fresh = await fetch(request, { cache: "no-store" });
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, fresh.clone());
    return fresh;
  } catch (e) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw e;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  const cache = await caches.open(CACHE_NAME);
  cache.put(request, fresh.clone());
  return fresh;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // POST(Gemini API 등) 또는 cross-origin(Firebase/gstatic CDN 등) 요청은
  // 우리가 관여하지 않고 브라우저 기본 동작에 맡긴다.
  if (req.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  const isNavigation = req.mode === "navigate" || url.pathname.endsWith("/index.html");
  if (isNavigation) {
    event.respondWith(networkFirst(req));
    return;
  }

  const isPrecachedAsset = PRECACHE_ASSETS.some(
    (asset) => asset !== "./" && url.pathname.endsWith(asset)
  );
  if (isPrecachedAsset) {
    event.respondWith(cacheFirst(req));
    return;
  }
  // 그 외(sw.js 자체 요청 등)는 기본 동작.
});

// GitHub Actions 스케줄 워크플로가 보낸 push 메시지를 화면에 표시한다.
// iOS는 무음(데이터 전용) push를 허용하지 않으므로 항상 알림을 띄운다.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "Coshelf", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "Coshelf";
  const options = {
    body: data.body || "",
    icon: "icon.png",
    badge: "icon.png",
    data: { url: data.url || "./" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// 알림을 탭하면 이미 열린 탭이 있으면 포커스하고, 없으면 새로 연다.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "./";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsArr) => {
      const existing = clientsArr.find((c) => c.url.includes(self.registration.scope));
      if (existing) return existing.focus();
      return self.clients.openWindow(targetUrl);
    })
  );
});
