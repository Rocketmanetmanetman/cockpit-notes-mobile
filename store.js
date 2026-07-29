// store.js — STOCKAGE de l'application mobile de notes (IndexedDB).
//
// Trois magasins, une seule règle d'or : **rien n'est jamais purgé** (§2-4). Une note
// envoyée est FIGÉE — ni modifiable, ni supprimable (D6) —, et le garde-fou vit ici, pas
// dans l'interface : c'est le stockage qui refuse, quelle que soit la façon dont on
// l'appelle. La restauration auto-réparante du PC (« Tout renvoyer ») suppose que le
// téléphone a tout gardé.
//
// **Le service worker ne touche JAMAIS ce magasin** : une mise à jour de l'application ne
// peut donc pas perdre une note.
(function (global) {
  'use strict';

  var NOM_BASE = 'cockpit-notes-mobile';
  var VERSION_BASE = 1;
  var base = null;

  function ouvrir() {
    if (base) return Promise.resolve(base);
    return new Promise(function (resoudre, rejeter) {
      var requete = indexedDB.open(NOM_BASE, VERSION_BASE);
      requete.onupgradeneeded = function () {
        var db = requete.result;
        // Migration additive, gardée : une version future ajoute sans jamais casser.
        if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'uuid' });
        if (!db.objectStoreNames.contains('envois')) db.createObjectStore('envois', { keyPath: 'uuid' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'cle' });
      };
      requete.onsuccess = function () {
        base = requete.result;
        resoudre(base);
      };
      requete.onerror = function () {
        rejeter(requete.error || new Error('base locale indisponible'));
      };
    });
  }

  function transaction(magasins, mode) {
    return ouvrir().then(function (db) {
      return db.transaction(magasins, mode);
    });
  }

  function promesse(requete) {
    return new Promise(function (resoudre, rejeter) {
      requete.onsuccess = function () { resoudre(requete.result); };
      requete.onerror = function () { rejeter(requete.error); };
    });
  }

  // Met les données à l'abri du nettoyage automatique du navigateur. Appelée au premier
  // geste utilisateur, idempotente, et tolérante à l'absence de l'API.
  function demanderPersistance() {
    if (!navigator.storage || !navigator.storage.persist) return Promise.resolve(false);
    return navigator.storage.persist().catch(function () { return false; });
  }

  // Compteur monotone persisté : il donne un ORDRE STABLE aux notes, indépendant de la
  // date de saisie (que Julien peut reculer à la main).
  function prochaineSeq() {
    return transaction(['meta'], 'readwrite').then(function (t) {
      var magasin = t.objectStore('meta');
      return promesse(magasin.get('seq')).then(function (ligne) {
        var suivant = (ligne && ligne.valeur ? ligne.valeur : 0) + 1;
        return promesse(magasin.put({ cle: 'seq', valeur: suivant })).then(function () {
          return suivant;
        });
      });
    });
  }

  function toutes(magasin) {
    return transaction([magasin], 'readonly').then(function (t) {
      return promesse(t.objectStore(magasin).getAll());
    });
  }

  // Toutes les notes, les plus récemment saisies en tête.
  function listerNotes() {
    return Promise.all([toutes('notes'), toutes('envois')]).then(function (r) {
      var envoyees = {};
      r[1].forEach(function (e) { envoyees[e.uuid] = e; });
      return r[0]
        .map(function (n) {
          var e = envoyees[n.uuid];
          return Object.assign({}, n, { envoyee: !!e, envoye_le: e ? e.envoye_le : null });
        })
        .sort(function (a, b) { return (b.seq || 0) - (a.seq || 0); });
    });
  }

  function estEnvoyee(uuid) {
    return transaction(['envois'], 'readonly').then(function (t) {
      return promesse(t.objectStore('envois').get(uuid)).then(function (e) { return !!e; });
    });
  }

  function ajouterNote(note) {
    return transaction(['notes'], 'readwrite').then(function (t) {
      return promesse(t.objectStore('notes').add(note));
    });
  }

  // Modification refusée dès l'envoi (D6) — le garde-fou est ici, jamais seulement dans
  // l'interface.
  function modifierNote(uuid, champs) {
    return estEnvoyee(uuid).then(function (figee) {
      if (figee) throw new Error('Cette note a été envoyée : elle ne peut plus être modifiée.');
      return transaction(['notes'], 'readwrite').then(function (t) {
        var magasin = t.objectStore('notes');
        return promesse(magasin.get(uuid)).then(function (note) {
          if (!note) throw new Error('Note introuvable.');
          return promesse(magasin.put(Object.assign({}, note, champs)));
        });
      });
    });
  }

  function supprimerNote(uuid) {
    return estEnvoyee(uuid).then(function (figee) {
      if (figee) throw new Error('Cette note a été envoyée : elle ne peut plus être supprimée.');
      return transaction(['notes'], 'readwrite').then(function (t) {
        return promesse(t.objectStore('notes').delete(uuid));
      });
    });
  }

  // « En attente d'envoi » = UUID absent du magasin des envois. Marquer un envoi ne touche
  // JAMAIS la donnée d'origine.
  function enAttente() {
    return listerNotes().then(function (notes) {
      return notes.filter(function (n) { return !n.envoyee; }).sort(function (a, b) {
        return (a.seq || 0) - (b.seq || 0);
      });
    });
  }

  // Tout l'historique, envoyées comprises — c'est « Tout renvoyer », l'outil de réparation
  // après une restauration de sauvegarde du PC (le PC dédoublonne par UUID).
  function tout() {
    return listerNotes().then(function (notes) {
      return notes.slice().sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
    });
  }

  function marquerEnvoyees(uuids, lot, envoyeLe) {
    return transaction(['envois'], 'readwrite').then(function (t) {
      var magasin = t.objectStore('envois');
      // `put` idempotent : renvoyer une note déjà envoyée ne casse rien.
      uuids.forEach(function (uuid) {
        magasin.put({ uuid: uuid, lot: lot, envoye_le: envoyeLe });
      });
      return new Promise(function (resoudre, rejeter) {
        t.oncomplete = function () { resoudre(); };
        t.onerror = function () { rejeter(t.error); };
      });
    });
  }

  // Les deux référentiels reçus du PC, persistés tels quels et relus au démarrage.
  function enregistrerReferentiel(genre, contenu) {
    return transaction(['meta'], 'readwrite').then(function (t) {
      return promesse(t.objectStore('meta').put({ cle: 'ref_' + genre, valeur: contenu }));
    });
  }

  function lireReferentiel(genre) {
    return transaction(['meta'], 'readonly').then(function (t) {
      return promesse(t.objectStore('meta').get('ref_' + genre)).then(function (l) {
        return l ? l.valeur : null;
      });
    });
  }

  // Le dernier lot fabriqué est CONSERVÉ (nom + contenu). Un téléchargement peut échouer,
  // un fichier peut se perdre dans les Téléchargements : on doit pouvoir le refabriquer à
  // l'identique sans rien renvoyer ni rien dupliquer.
  function enregistrerDernierLot(lot) {
    return transaction(['meta'], 'readwrite').then(function (t) {
      return promesse(t.objectStore('meta').put({ cle: 'dernier_lot', valeur: lot }));
    });
  }

  function lireDernierLot() {
    return transaction(['meta'], 'readonly').then(function (t) {
      return promesse(t.objectStore('meta').get('dernier_lot')).then(function (l) {
        return l ? l.valeur : null;
      });
    });
  }

  global.Store = {
    ouvrir: ouvrir,
    demanderPersistance: demanderPersistance,
    prochaineSeq: prochaineSeq,
    ajouterNote: ajouterNote,
    modifierNote: modifierNote,
    supprimerNote: supprimerNote,
    listerNotes: listerNotes,
    enAttente: enAttente,
    tout: tout,
    marquerEnvoyees: marquerEnvoyees,
    enregistrerReferentiel: enregistrerReferentiel,
    lireReferentiel: lireReferentiel,
    enregistrerDernierLot: enregistrerDernierLot,
    lireDernierLot: lireDernierLot,
  };
})(window);
