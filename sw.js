// Coshelf service worker
// 현재는 등록 확인용 뼈대만 존재합니다. push/notificationclick 핸들러는
// 다음 단계(Firebase 스캐폴딩 이후)에서 추가됩니다.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
