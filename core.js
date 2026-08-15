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

  // Une note typée (SPEC notes typées §3.1) : elle porte un `genre` et une `charge`.
  function noteTypee(n) {
    return !!n && (n.genre === 'ticket' || n.genre === 'idee');
  }

  // Construit l'objet conforme au contrat. Il ne recopie QUE les champs du contrat : le
  // compteur de tri interne (`seq`) ne fuite jamais dans le lot.
  //
  // **Version 2 dès qu'une note est typée, 1 sinon** (§3.1) : un Cockpit pas encore mis à
  // jour refuse un lot typé avec son message de version au lieu d'aplatir un ticket en
  // note libre — et les lots tout-libres restent lisibles partout pendant la fenêtre où
  // téléphone (mis à jour tout seul par Pages) et PC (par installateur) divergent.
  function buildLot(notes, lotUuid, genereLe) {
    notes = notes || [];
    return {
      format: FORMAT_LOT,
      version: notes.some(noteTypee) ? 2 : VERSION,
      lot: lotUuid,
      genere_le: genereLe,
      notes: notes.map(function (n) {
        var sortie = {
          uuid: n.uuid,
          texte: n.texte,
          date: n.date,
          cible: n.cible || null,
          cible_nom: n.cible_nom || '',
          cree_le: n.cree_le || null,
        };
        if (noteTypee(n)) {
          sortie.genre = n.genre;
          sortie.charge = n.charge || null;
        }
        return sortie;
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

  // ---- Notes typées : la fiche (SPEC notes typées §4.2-§4.3) ----
  //
  // La « fiche » est l'état du formulaire Ticket ou Idée sur le téléphone. Sa validation
  // reprend LES INVARIANTS DU COCKPIT (un rendez-vous exige date et heure, un titre ne
  // peut pas être vide…) : ce qui serait refusé à l'injection est refusé dès la saisie.
  // La cohérence FINE (la colonne existe-t-elle encore ?) reste au PC : le choix du
  // téléphone n'est qu'une pré-sélection (D3).

  function ficheVierge() {
    return {
      titre: '',
      description: '',
      // Ticket : une colonne du projet OU un rendez-vous (jamais les deux).
      colonne_id: null,
      colonne_libelle: '',
      rdv: false,
      date_valeur: '', // AAAA-MM-JJ — échéance (facultative) ou jour du rendez-vous
      heure: '', // HH:MM — rendez-vous seulement
      rappel_home: false,
      position: 'bas',
      liens: [],
      // Idée.
      categorie_id: null,
      categorie_libelle: '',
      maturite: 'brut',
      coup_de_coeur: false,
    };
  }

  // Replie une heure tapée à la main sur la forme 'HH:MM' du contrat, ou rend '' si elle
  // n'a aucun sens (audit du 07-08-2026). Le pavé numérique d'un téléphone n'offre pas
  // toujours de « : » : exiger la forme stricte rendait le rendez-vous insaisissable.
  // Sont acceptés : « 9:30 », « 0930 », « 9h30 », « 9 h 30 », « 930 », « 9 » (→ 09:00).
  function heureNormalisee(brut) {
    var chiffres = String(brut == null ? '' : brut).replace(/\D/g, '');
    if (chiffres.length === 0 || chiffres.length > 4) return '';
    var heures;
    var minutes;
    if (chiffres.length <= 2) {
      heures = Number(chiffres);
      minutes = 0;
    } else {
      // 3 chiffres : « 930 » = 9 h 30. 4 chiffres : « 0930 ».
      heures = Number(chiffres.slice(0, chiffres.length - 2));
      minutes = Number(chiffres.slice(-2));
    }
    if (heures > 23 || minutes > 59) return '';
    return deux(heures) + ':' + deux(minutes);
  }

  // 'HH:MM' réel — saisie d'heure maison (jamais le sélecteur système), même esprit que
  // le mini-calendrier. Tolérante à la FORME depuis l'audit : c'est `heureNormalisee` qui
  // dit si l'heure a un sens, et la charge JSON reçoit toujours 'HH:MM'.
  function heureValide(h) {
    return heureNormalisee(h) !== '';
  }

  // Les liens nettoyés : une URL vide est un lien qui n'existe pas (comme au Cockpit).
  function liensPropres(liens) {
    return (liens || [])
      .map(function (l) {
        return {
          libelle: String((l && l.libelle) || '').trim(),
          url: String((l && l.url) || '').trim(),
        };
      })
      .filter(function (l) {
        return l.url !== '';
      });
  }

  // `null` = fiche valide, sinon le message de refus — les mots du Cockpit.
  function validerFicheTicket(f) {
    if (!String(f.titre || '').trim()) return 'Le titre du ticket ne peut pas être vide.';
    if (f.rdv === true) {
      if (!dateValide(f.date_valeur || '') || !heureValide(f.heure || '')) {
        return 'Un rendez-vous exige une date et une heure.';
      }
      return null;
    }
    if (typeof f.colonne_id !== 'number') return 'Choisis une colonne, ou « Rendez-vous ».';
    if (f.date_valeur && !dateValide(f.date_valeur)) return 'Échéance invalide.';
    return null;
  }

  function validerFicheIdee(f) {
    if (!String(f.titre || '').trim()) return "Le titre de l'idée ne peut pas être vide.";
    if (typeof f.categorie_id !== 'number') return 'Choisis une catégorie.';
    return null;
  }

  // La charge d'un ticket, conforme au contrat (§3.1). À appeler sur une fiche VALIDE.
  function chargeTicket(f) {
    var rdv = f.rdv === true;
    return {
      titre: String(f.titre || '').trim(),
      description: String(f.description || '').trim(),
      colonne_id: rdv ? null : f.colonne_id,
      colonne_libelle: rdv ? '' : String(f.colonne_libelle || ''),
      date_nature: rdv ? 'rdv' : f.date_valeur ? 'echeance' : null,
      // L'heure est REPLIÉE sur 'HH:MM' ici : le contrat ne voit jamais « 9h30 ».
      date_valeur: rdv ? f.date_valeur + ' ' + heureNormalisee(f.heure) : f.date_valeur || null,
      rappel_home: f.rappel_home === true,
      position: f.position === 'haut' ? 'haut' : 'bas',
      liens: liensPropres(f.liens),
    };
  }

  function chargeIdee(f) {
    return {
      titre: String(f.titre || '').trim(),
      description: String(f.description || '').trim(),
      categorie_id: f.categorie_id,
      categorie_libelle: String(f.categorie_libelle || ''),
      maturite: f.maturite === 'creuser' || f.maturite === 'mure' ? f.maturite : 'brut',
      coup_de_coeur: f.coup_de_coeur === true,
      position: f.position === 'haut' ? 'haut' : 'bas',
      liens: liensPropres(f.liens),
    };
  }

  // L'inverse : rouvrir le BON formulaire d'une note typée de la file (§4.4), charge
  // pré-remplie. Tolérante — une charge bancale rend une fiche vierge, jamais une erreur.
  function ficheDepuisCharge(genre, charge) {
    var f = ficheVierge();
    if (!charge || typeof charge !== 'object') return f;
    f.titre = String(charge.titre || '');
    f.description = String(charge.description || '');
    f.position = charge.position === 'haut' ? 'haut' : 'bas';
    f.liens = liensPropres(charge.liens).map(function (l) {
      return { libelle: l.libelle, url: l.url };
    });
    if (genre === 'ticket') {
      f.rappel_home = charge.rappel_home === true;
      if (charge.date_nature === 'rdv') {
        f.rdv = true;
        var valeur = String(charge.date_valeur || '');
        f.date_valeur = valeur.slice(0, 10);
        f.heure = valeur.length >= 16 ? valeur.slice(11, 16) : '';
      } else {
        f.colonne_id = typeof charge.colonne_id === 'number' ? charge.colonne_id : null;
        f.colonne_libelle = String(charge.colonne_libelle || '');
        if (charge.date_nature === 'echeance') f.date_valeur = String(charge.date_valeur || '');
      }
    } else {
      f.categorie_id = typeof charge.categorie_id === 'number' ? charge.categorie_id : null;
      f.categorie_libelle = String(charge.categorie_libelle || '');
      f.maturite =
        charge.maturite === 'creuser' || charge.maturite === 'mure' ? charge.maturite : 'brut';
      f.coup_de_coeur = charge.coup_de_coeur === true;
    }
    return f;
  }

  // Le texte APLATI d'une note typée (D13) : titre, description, puis les liens un par
  // ligne. C'est la charge utile universelle — cartes, Copier, miroir disque et recherche
  // du Cockpit vivent dessus, et rien n'est perdu même si la charge se perdait.
  function texteDe(f) {
    var lignes = [String(f.titre || '').trim()];
    var description = String(f.description || '').trim();
    if (description !== '') {
      lignes.push('');
      lignes.push(description);
    }
    var liens = liensPropres(f.liens);
    if (liens.length > 0) {
      lignes.push('');
      liens.forEach(function (l) {
        lignes.push(l.libelle !== '' ? l.libelle + ' — ' + l.url : l.url);
      });
    }
    return lignes.join('\n');
  }

  // ---- Notes typées : ce que le référentiel permet (§4.6) ----

  // Colonnes qu'un ticket peut viser : celles du projet, pseudo-colonne RDV exclue. Un
  // `backlogs.json` d'AVANT la tranche n'a pas d'ids de colonnes → liste vide, et c'est le
  // signal « repousse les référentiels depuis le PC » (D10).
  function colonnesCiblables(projetBacklog) {
    if (!projetBacklog || !Array.isArray(projetBacklog.colonnes)) return [];
    return projetBacklog.colonnes.filter(function (c) {
      return !!c && c.systeme !== true && typeof c.id === 'number';
    });
  }

  // Catégories d'idées d'un projet : `null` = référentiel d'avant la tranche (repousser),
  // `[]` = projet sans catégorie (les créer sur le PC), sinon la liste, idées comprises.
  function categoriesDe(projetBacklog) {
    if (!projetBacklog || !Array.isArray(projetBacklog.categories)) return null;
    return projetBacklog.categories;
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

  // ---- Texte riche des descriptions venues du PC (15-08-2026) ----
  //
  // Depuis le 15-08-2026, le Cockpit écrit dans la description d'un ticket ou d'une idée
  // des puces à SIX niveaux, du gras, de l'italique et du surlignage rouge — toujours en
  // TEXTE BRUT, avec des marqueurs de deux caractères (voir `src/pages/projet/texteRiche.ts`).
  //
  // Le téléphone les RELIT pour les afficher, et ne les écrit jamais : sa saisie reste du
  // texte simple, séparateur compris. Sans cette lecture, un backlog consulté sur le
  // téléphone montrerait « **gras** » tel quel.
  //
  // ⚠️ Mêmes marqueurs des deux côtés. Les faire diverger, c'est afficher faux ici.
  var PUCES_RICHES = ['• ', '  ◦ ', '    ▪ ', '      • ', '        ◦ ', '          ▪ '];
  var MARQUEURS_RICHES = [['==', 'mark'], ['**', 'strong'], ['__', 'em']];

  function echapperHtml(texte) {
    return String(texte)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function niveauPuceRiche(ligne) {
    for (var n = PUCES_RICHES.length - 1; n >= 0; n--) {
      if (ligne.indexOf(PUCES_RICHES[n]) === 0) return n;
    }
    return -1;
  }

  // Le contenu d'une ligne : les marqueurs deviennent des balises, le reste est échappé.
  // Un marqueur sans fermeture reste du texte — rien ne disparaît jamais.
  function htmlContenuRiche(contenu) {
    var sortie = '';
    var i = 0;
    while (i < contenu.length) {
      var trouve = null;
      for (var k = 0; k < MARQUEURS_RICHES.length; k++) {
        var marqueur = MARQUEURS_RICHES[k][0];
        if (contenu.slice(i, i + 2) === marqueur && contenu.indexOf(marqueur, i + 2) !== -1) {
          trouve = MARQUEURS_RICHES[k];
          break;
        }
      }
      if (trouve) {
        var fin = contenu.indexOf(trouve[0], i + 2);
        sortie +=
          '<' + trouve[1] + '>' + htmlContenuRiche(contenu.slice(i + 2, fin)) + '</' + trouve[1] + '>';
        i = fin + 2;
      } else {
        sortie += echapperHtml(contenu.charAt(i));
        i += 1;
      }
    }
    return sortie;
  }

  /** Une description du PC, rendue en HTML sûr (tout est échappé sauf nos propres balises). */
  function htmlTexteRiche(texte) {
    var lignes = String(texte == null ? '' : texte).split('\n');
    var sortie = '';
    var profondeur = 0;
    var fermerJusqua = function (cible) {
      while (profondeur > cible) {
        sortie += '</ul>';
        profondeur -= 1;
      }
    };
    for (var i = 0; i < lignes.length; i++) {
      var ligne = lignes[i];
      if (estSeparateur(ligne)) {
        fermerJusqua(0);
        sortie += '<hr class="tr-trait">';
        continue;
      }
      var niveau = niveauPuceRiche(ligne);
      if (niveau === -1) {
        fermerJusqua(0);
        sortie += '<p class="tr-p">' + htmlContenuRiche(ligne) + '</p>';
        continue;
      }
      fermerJusqua(niveau + 1);
      while (profondeur < niveau + 1) {
        sortie += '<ul class="tr-liste">';
        profondeur += 1;
      }
      sortie += '<li class="tr-item">' + htmlContenuRiche(ligne.slice(PUCES_RICHES[niveau].length)) + '</li>';
    }
    fermerJusqua(0);
    return sortie;
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
    noteTypee: noteTypee,
    ficheVierge: ficheVierge,
    heureValide: heureValide,
    heureNormalisee: heureNormalisee,
    liensPropres: liensPropres,
    validerFicheTicket: validerFicheTicket,
    validerFicheIdee: validerFicheIdee,
    chargeTicket: chargeTicket,
    chargeIdee: chargeIdee,
    ficheDepuisCharge: ficheDepuisCharge,
    texteDe: texteDe,
    colonnesCiblables: colonnesCiblables,
    categoriesDe: categoriesDe,
    titreNote: titreNote,
    apercuNote: apercuNote,
    estSeparateur: estSeparateur,
    noteVide: noteVide,
    insererSeparateur: insererSeparateur,
    htmlTexteRiche: htmlTexteRiche,
  };
})(window);
