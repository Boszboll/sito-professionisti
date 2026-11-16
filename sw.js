/**
 * Service worker della web app: rende la pagina usabile offline dopo la prima
 * visita (network-first, con caduta sulla cache). È ciò che rende vera la
 * frase «provala in modalità aereo»: se funziona senza connessione, non può
 * star parlando con nessun server. Le richieste verso altri domini (i file
 * del modello AI) non vengono toccate.
 */
const VERSIONE = "gdpr-sanitizer-v2";
// Solo i file indispensabili per aprire la pagina: HTML, CSS e il bundle.
// Il runtime WASM (21 MB) e il worker di pdf.js (1,3 MB) NON si precaricano:
// verrebbero scaricati da ogni visitatore anche se non usa mai l'AI o i PDF.
// Ci pensa la cache a runtime, alla prima utilizzazione reale.
const CORE = [
  "./",
  "index.html",
  "app.html",
  "scheda-tecnica.html",
  "sanitizer.js",
  "assets/app.js",
  "assets/app.css"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSIONE)
      .then((cache) => cache.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((chiavi) => Promise.all(chiavi.filter((k) => k !== VERSIONE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const richiesta = event.request;
  if (richiesta.method !== "GET") return;
  const url = new URL(richiesta.url);
  if (url.origin !== self.location.origin) return; // il modello AI resta com'è

  event.respondWith(
    fetch(richiesta)
      .then((risposta) => {
        if (risposta && risposta.ok) {
          const copia = risposta.clone();
          caches.open(VERSIONE).then((cache) => cache.put(richiesta, copia));
        }
        return risposta;
      })
      .catch(() =>
        caches.match(richiesta).then((inCache) => inCache || Response.error())
      )
  );
});
