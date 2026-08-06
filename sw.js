// sw.js — service worker de l'application mobile de notes.
//
// Deux règles, et rien d'autre :
//  1. **Hors-ligne d'abord** : la coquille est pré-mise en cache et servie depuis le cache.
//  2. **Il ne touche JAMAIS IndexedDB.** Une mise à jour de l'application ne peut donc pas
//     perdre une note. Le cache ne contient que des fichiers statiques.
//
// ⚠ **VERSION À INCRÉMENTER À CHAQUE PUBLICATION.** Sans cela, le service worker re-sert sa
// copie et la mise à jour ne parvient jamais au téléphone — le piège de développement le
// plus coûteux de ce genre d'application. `mobile/publier.ps1` refuse de publier tant que
// cette version n'a pas changé.
var CACHE = 'cockpit-notes-v11';

var COQUILLE = [
  './',
  './index.html',
  './styles.css',
  './core.js',
  './store.js',
  './app.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-maskable.svg',
];

self.addEventListener('install', function (evenement) {
  evenement.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(COQUILLE);
    }).then(function () {
      return self.skipWaiting();
    }),
  );
});

self.addEventListener('activate', function (evenement) {
  evenement.waitUntil(
    caches.keys().then(function (cles) {
      return Promise.all(
        cles.map(function (cle) {
          return cle === CACHE ? null : caches.delete(cle);
        }),
      );
    }).then(function () {
      return self.clients.claim();
    }),
  );
});

// Un appui sur la notification « notes à envoyer » (avenant A8) ramène l'application au
// premier plan — ou l'ouvre. C'est le seul rôle du service worker dans cette histoire :
// la notification est posée par la PAGE, jamais par un serveur (il n'y en a pas).
self.addEventListener('notificationclick', function (evenement) {
  evenement.notification.close();
  evenement.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (fenetres) {
      if (fenetres.length > 0) return fenetres[0].focus();
      return self.clients.openWindow('./');
    }),
  );
});

self.addEventListener('fetch', function (evenement) {
  if (evenement.request.method !== 'GET') return;
  evenement.respondWith(
    caches.match(evenement.request).then(function (reponse) {
      if (reponse) return reponse;
      return fetch(evenement.request)
        .then(function (reseau) {
          // On ne met en cache que ce qui appartient à l'application (même origine).
          if (reseau && reseau.ok && reseau.type === 'basic') {
            var copie = reseau.clone();
            caches.open(CACHE).then(function (cache) {
              cache.put(evenement.request, copie);
            });
          }
          return reseau;
        })
        .catch(function () {
          // Échec réseau total : on retombe sur la coquille, l'application reste utilisable.
          return caches.match('./index.html');
        });
    }),
  );
});
