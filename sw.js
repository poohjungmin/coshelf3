// Coshelf service worker

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
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
