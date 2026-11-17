/**
 * Service worker della web app: rende la pagina usabile offline dopo la prima
 * visita (network-first, con caduta sulla cache). È ciò che rende vera la
 * frase «provala in modalità aereo»: se funziona senza connessione, non può
 * star parlando con nessun server. Le richieste verso altri domini (i file
 * del modello AI) non vengono toccate.
 */
const VERSIONE = "gdpr-sanitizer-v4";
// Solo i file indispensabili per aprire la pagina: HTML, CSS e il bundle con
// i suoi chunk iniziali. Le librerie per office, PDF, AI e OCR (decine di MB)
// NON si precaricano: entrano nella cache alla prima utilizzazione reale.
// L'elenco dei chunk viene scritto dal build: sono i moduli che il bundle
// importa subito, senza i quali la pagina non si avvierebbe offline.
const CORE = [
  "./",
  "index.html",
  "app.html",
  "scheda-tecnica.html",
  "condizioni.html",
  "sanitizer.js",
  "assets/app.js",
  "assets/app.css",
  "assets/chunk-C2HO2HXM.js"
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
