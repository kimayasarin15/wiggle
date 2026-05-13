const STATIC_CACHE = "motion-static-v7";
const API_CACHE = "motion-api-v1";
const IMAGE_CACHE = "motion-images-v1";

const STATIC_ASSETS = ["./", "./index.html", "./manifest.json", "./app.js", "./style.css"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  const currentCaches = [STATIC_CACHE, API_CACHE, IMAGE_CACHE];
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((name) => !currentCaches.includes(name))
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isApiRequest(url) {
  return url.hostname === "api.are.na";
}

function isHtmlRequest(request) {
  const url = new URL(request.url);
  const accept = request.headers.get("Accept") || "";
  return (
    accept.includes("text/html") ||
    url.pathname.endsWith(".html") ||
    url.pathname.endsWith("/")
  );
}

function isImageRequest(request) {
  const url = new URL(request.url);
  const acceptHeader = request.headers.get("Accept") || "";
  const imageExtensions = [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".svg",
    ".avif",
  ];

  const isImageAccept = acceptHeader.includes("image/");
  const isImageUrl = imageExtensions.some((ext) =>
    url.pathname.toLowerCase().endsWith(ext),
  );
  const isArenaImage =
    url.hostname.includes("arena") && url.pathname.includes("original");
  const isS3Image =
    url.hostname.includes("s3") || url.hostname.includes("amazonaws");

  return isImageAccept || isImageUrl || isArenaImage || isS3Image;
}

function isStaticAsset(url) {
  const staticExtensions = [".js", ".css", ".woff", ".woff2", ".ttf", ".eot"];
  return staticExtensions.some((ext) => url.pathname.endsWith(ext));
}

async function networkFirst(request, cacheName, timeoutMs = 5000) {
  const cache = await caches.open(cacheName);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const networkResponse = await fetch(request, { signal: controller.signal });

    clearTimeout(timeoutId);

    if (networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }

    return networkResponse;
  } catch (error) {
    const cachedResponse = await cache.match(request);
    if (cachedResponse) return cachedResponse;
    throw error;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cachedResponse = await cache.match(request);

  if (cachedResponse) return cachedResponse;

  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (_error) {
    return new Response("Offline", {
      status: 503,
      statusText: "Service Unavailable",
    });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cachedResponse = await cache.match(request);
  const fetchPromise = fetch(request)
    .then((networkResponse) => {
      if (networkResponse.ok) {
        cache.put(request, networkResponse.clone());
      }
      return networkResponse;
    })
    .catch(() => cachedResponse);

  return cachedResponse || fetchPromise;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET") return;
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  if (isApiRequest(url)) {
    event.respondWith(networkFirst(request, API_CACHE, 5000));
    return;
  }

  // Always fetch HTML fresh from the network so deploys are visible immediately.
  // Falls back to cache only when offline.
  if (isHtmlRequest(request)) {
    event.respondWith(networkFirst(request, STATIC_CACHE, 3000));
    return;
  }

  if (isImageRequest(request)) {
    event.respondWith(cacheFirst(request, IMAGE_CACHE));
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
    return;
  }

  event.respondWith(fetch(request));
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
