// core.js — LOGIQUE PURE de l'application mobile de notes du Cockpit.
//
// Aucune de ces fonctions ne touche le DOM, IndexedDB ni le réseau : c'est ce qui les rend
// testables isolément (`tests.html`) et ce qui garde le téléphone simple. La séparation
// logique pure / stockage / interface est reprise telle quelle de l'application de budget,
// qui l'a éprouvée en service réel.
//
// **Le contrat de fichiers (§4 de la spec) vit ici et nulle part ailleurs.** Il est figé et
// versionné : un lecteur qui ne comprend pas une version la refuse PROPREMENT plutôt que
// d'ingérer des données à moitié ; les champs inconnus sont ignorés.
(function (global) {
  'use strict';

  var FORMAT_LOT = 'cockpit-notes-lot';
  var FORMAT_PROJETS = 'cockpit-projets';
  var FORMAT_BACKLOGS = 'cockpit-backlogs';
  var VERSION = 1;

  // Trait de séparation inséré DANS le corps de la note (D5). Il voyage avec le texte :
  // le PC le voit tel quel, et le fichier disque le montre comme une ligne de tirets.
  // Même chaîne des trois côtés — Rust, front du Cockpit, téléphone.
  var SEPARATEUR = '----------------------------------------';

  function deux(n) {
    return n < 10 ? '0' + n : String(n);
  }

  // ---- Dates (heure locale du téléphone) ----

  // 'AAAA-MM-JJ' d'une date.
  function dateISO(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + deux(d.getMonth() + 1) + '-' + deux(d.getDate());
  }

  // 'AAAA-MM-JJ HH:MM:SS' — l'instant réel d'une saisie ou d'une génération de lot.
  function horodatage(d) {
    d = d || new Date();
    return (
      dateISO(d) + ' ' + deux(d.getHours()) + ':' + deux(d.getMinutes()) + ':' + deux(d.getSeconds())
    );
  }

  // 'AAAA-MM-JJ' → 'JJ/MM/AAAA' (affichage).
  function dateFr(iso) {
    if (!iso || iso.length < 10) return iso || '';
    return iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);
  }

  // 'AAAA-MM-JJ HH:MM:SS' → 'JJ/MM/AAAA à HH:MM' (dates des référentiels).
  function horodatageFr(valeur) {
    if (!valeur) return '';
    var jour = dateFr(valeur.slice(0, 10));
    return valeur.length >= 16 ? jour + ' à ' + valeur.slice(11, 16) : jour;
  }

  // Validation stricte, années bissextiles comprises (mêmes bornes que le backend PC).
  function dateValide(iso) {
    if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
    var a = Number(iso.slice(0, 4));
    var m = Number(iso.slice(5, 7));
    var j = Number(iso.slice(8, 10));
    if (a < 1900 || a > 2200 || m < 1 || m > 12 || j < 1) return false;
    var d = new Date(a, m - 1, j);
    return d.getFullYear() === a && d.getMonth() === m - 1 && d.getDate() === j;
  }

  // Grille d'un mois pour le mini-calendrier maison (jamais le sélecteur système) :
  // 6 semaines de 7 jours, lundi en tête, chaque case portant sa date ISO.
  function grilleMois(annee, mois) {
    var premier = new Date(annee, mois, 1);
    var decalage = (premier.getDay() + 6) % 7; // 0 = lundi
    var cases = [];
    for (var i = 0; i < 42; i++) {
      var d = new Date(annee, mois, 1 - decalage + i);
      cases.push({ iso: dateISO(d), jour: d.getDate(), horsMois: d.getMonth() !== mois });
    }
    return cases;
  }

  var MOIS_FR = [
    'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
    'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
  ];

  function nomMois(mois) {
    return MOIS_FR[mois] || '';
  }

  // ---- UUID ----

  // `crypto.randomUUID` est disponible en contexte sécurisé (la PWA est servie en HTTPS
  // par GitHub Pages) ; le repli couvre les navigateurs anciens et les tests hors HTTPS.
  function uuid() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // ---- Le lot (téléphone → PC) ----

  // `lot AAAA-MM-JJ HHhMMmSS <6 hex>.json` : les 6 hexadécimaux sont le début de l'UUID du
  // lot (collision impossible, même à deux envois dans la même seconde), et l'ordre
  // alphabétique des noms EST l'ordre chronologique.
  function lotFilename(lotUuid, d) {
    d = d || new Date();
    var court = String(lotUuid || '').replace(/[^0-9a-f]/gi, '').slice(0, 6).toLowerCase();
    while (court.length < 6) court += '0';
    return (
      'lot ' + dateISO(d) + ' ' + deux(d.getHours()) + 'h' + deux(d.getMinutes()) + 'm' +
      deux(d.getSeconds()) + ' ' + court + '.json'
    );
  }

  // Construit l'objet conforme au contrat. Il ne recopie QUE les champs du contrat : le
  // compteur de tri interne (`seq`) ne fuite jamais dans le lot.
  function buildLot(notes, lotUuid, genereLe) {
    return {
      format: FORMAT_LOT,
      version: VERSION,
      lot: lotUuid,
      genere_le: genereLe,
      notes: (notes || []).map(function (n) {
        return {
          uuid: n.uuid,
          texte: n.texte,
          date: n.date,
          cible: n.cible || null,
          cible_nom: n.cible_nom || '',
          cree_le: n.cree_le || null,
        };
      }),
    };
  }

  function lotJson(lot) {
    return JSON.stringify(lot, null, 2);
  }

  // ---- Les référentiels (PC → téléphone) ----

  // Reconnaît SEUL lequel des deux fichiers il reçoit, à son en-tête : Julien n'a pas à
  // choisir un type avant d'ouvrir le fichier. Renvoie toujours un objet de forme stable.
  function parseReferentiel(texte) {
    var brut;
    try {
      brut = JSON.parse(texte);
    } catch (e) {
      return { ok: false, erreur: "Ce fichier n'est pas lisible (JSON invalide)." };
    }
    if (!brut || typeof brut !== 'object') {
      return { ok: false, erreur: "Ce fichier n'est pas un référentiel du Cockpit." };
    }
    var genre = brut.format === FORMAT_PROJETS ? 'projets'
      : brut.format === FORMAT_BACKLOGS ? 'backlogs'
        : null;
    if (!genre) {
      return {
        ok: false,
        erreur: "Ce fichier n'est pas un référentiel du Cockpit (projets.json ou backlogs.json).",
      };
    }
    if (brut.version !== VERSION) {
      return {
        ok: false,
        versionInconnue: true,
        erreur:
          'Ce fichier est en version ' + brut.version + ', que cette application ne comprend pas. ' +
          'Mets à jour l\'application avant de le charger.',
      };
    }
    var liste = Array.isArray(brut.projets) ? brut.projets : [];
    return {
      ok: true,
      genre: genre,
      genere_le: brut.genere_le || '',
      projets: liste,
      // Colonne RDV **globale** (backlogs uniquement) : tous les RDV de tous les projets
      // actifs, comme au Cockpit. Champ additif — un instantané plus ancien n'en a pas, et
      // l'écran retombe alors sur la colonne RDV propre à chaque projet.
      rdv: Array.isArray(brut.rdv) ? brut.rdv : [],
    };
  }

  // ---- Le corps d'une note ----

  // La première ligne sert de titre d'affichage dans les listes (D4). Le séparateur n'est
  // jamais un titre.
  function titreNote(texte) {
    var lignes = String(texte || '').split('\n');
    for (var i = 0; i < lignes.length; i++) {
      var l = lignes[i].trim();
      if (l !== '' && !estSeparateur(l)) return l.length > 70 ? l.slice(0, 70) + '…' : l;
    }
    return '(note vide)';
  }

  // Ce qui suit le titre, resserré, pour la carte de la file.
  function apercuNote(texte) {
    var lignes = String(texte || '')
      .split('\n')
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return l !== '' && !estSeparateur(l); });
    var suite = lignes.slice(1).join(' · ');
    return suite.length > 90 ? suite.slice(0, 90) + '…' : suite;
  }

  function estSeparateur(ligne) {
    return /^-{8,}$/.test(String(ligne).trim());
  }

  // Une note vide est refusée (§5.2) : ni texte, ni séparateurs seuls.
  function noteVide(texte) {
    return String(texte || '')
      .split('\n')
      .every(function (l) { return l.trim() === '' || estSeparateur(l); });
  }

  // Insère le séparateur à l'endroit du curseur, sur sa propre ligne, sans jamais coller
  // deux traits l'un à l'autre. Renvoie le nouveau texte et la position du curseur après.
  function insererSeparateur(texte, position) {
    texte = String(texte || '');
    if (typeof position !== 'number' || position < 0 || position > texte.length) {
      position = texte.length;
    }
    var avant = texte.slice(0, position);
    var apres = texte.slice(position);
    var prefixe = avant === '' || avant.slice(-1) === '\n' ? '' : '\n';
    var suffixe = apres.slice(0, 1) === '\n' || apres === '' ? '\n' : '\n';
    var insertion = prefixe + SEPARATEUR + suffixe;
    return { texte: avant + insertion + apres, curseur: (avant + insertion).length };
  }

  global.Core = {
    FORMAT_LOT: FORMAT_LOT,
    FORMAT_PROJETS: FORMAT_PROJETS,
    FORMAT_BACKLOGS: FORMAT_BACKLOGS,
    VERSION: VERSION,
    SEPARATEUR: SEPARATEUR,
    dateISO: dateISO,
    horodatage: horodatage,
    dateFr: dateFr,
    horodatageFr: horodatageFr,
    dateValide: dateValide,
    grilleMois: grilleMois,
    nomMois: nomMois,
    uuid: uuid,
    lotFilename: lotFilename,
    buildLot: buildLot,
    lotJson: lotJson,
    parseReferentiel: parseReferentiel,
    titreNote: titreNote,
    apercuNote: apercuNote,
    estSeparateur: estSeparateur,
    noteVide: noteVide,
    insererSeparateur: insererSeparateur,
  };
})(window);
