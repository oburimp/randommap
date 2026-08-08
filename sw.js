/* 오늘 뭐 먹지 — 서비스 워커
   앱 껍데기는 캐시에 두고, 검색 결과는 캐시하지 않습니다(위치마다 달라지므로). */

const VERSION = "fp-v1";
const SHELL = "shell-" + VERSION;
const FONTS = "fonts-" + VERSION;

const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // 폰트: 한 번 받으면 계속 캐시에서
  if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    e.respondWith(
      caches.open(FONTS).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        cache.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  // 외부 API(프록시·구글 이미지)는 건드리지 않습니다.
  if (!sameOrigin) return;

  // 페이지: 네트워크 우선 — 배포 직후에도 최신 화면이 뜨도록
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  // 그 외 정적 파일: 캐시 우선 + 백그라운드 갱신
  e.respondWith(
    caches.open(SHELL).then(async (cache) => {
      const hit = await cache.match(req);
      const net = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
