// Service worker de Money Bag: abre rapido guardando la interfaz en el
// telefono. Nunca guarda datos de Supabase ni precios (eso siempre va en vivo).
const CACHE = "moneybag-v1";
const SHELL = ["./", "index.html", "app.js", "config.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // Supabase, CDN y fuentes: red directa
  // Red primero (para recibir cambios de la app); si no hay red, la copia guardada.
  e.respondWith(fetch(e.request).then((r) => {
    const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match("index.html"))));
});
