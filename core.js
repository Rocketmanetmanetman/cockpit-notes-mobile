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

  // Les lignes qui « disent quelque chose » : ni vides, ni un trait, ni une puce toute
  // seule — et **débarrassées de leurs marqueurs de style** (15-08-2026, quand la note est
  // devenue riche elle aussi) : un titre de liste qui afficherait « **gras** » serait laid
  // et faux. La puce, elle, reste : elle se lit très bien.
  function lignesParlantes(texte) {
    return texteNuRiche(texte)
      .split('\n')
      .map(function (l) { return l.trim(); })
      .filter(function (l) {
        if (l === '' || l === '—' || estSeparateur(l)) return false;
        // « • » seul, « ◦ » seul… : une puce sans texte ne dit rien.
        return GLYPHES_RICHES.indexOf(l) === -1;
      });
  }

  // La première ligne sert de titre d'affichage dans les listes (D4). Le séparateur n'est
  // jamais un titre.
  function titreNote(texte) {
    var lignes = lignesParlantes(texte);
    if (!lignes.length) return '(note vide)';
    var l = lignes[0];
    return l.length > 70 ? l.slice(0, 70) + '…' : l;
  }

  // Ce qui suit le titre, resserré, pour la carte de la file.
  function apercuNote(texte) {
    var suite = lignesParlantes(texte).slice(1).join(' · ');
    return suite.length > 90 ? suite.slice(0, 90) + '…' : suite;
  }

  function estSeparateur(ligne) {
    return /^-{8,}$/.test(String(ligne).trim());
  }

  // Une note vide est refusée (§5.2) : ni texte, ni séparateurs seuls — ni, depuis que la
  // note accepte les puces, une liste de puces toutes vides.
  function noteVide(texte) {
    return lignesParlantes(texte).length === 0;
  }

  // ---- Texte riche des descriptions (15-08-2026, complété le même jour) ----
  //
  // Le Cockpit écrit dans la description d'un ticket ou d'une idée des puces à SIX niveaux,
  // du gras, de l'italique, du surlignage rouge et des traits de séparation — toujours en
  // TEXTE BRUT, avec des marqueurs de deux caractères. Le téléphone les LISAIT depuis ce
  // matin ; il les ÉCRIT désormais aussi (demande de Julien : « n'est-ce pas possible de
  // créer un ticket sur le téléphone avec les puces, le gras, l'italique ? »).
  //
  // ⚠️ **C'est un PORTAGE de `src/pages/projet/texteRiche.ts`, pas une variante.** Mêmes
  // marqueurs, mêmes règles, mêmes noms de fonctions à un suffixe près. Les faire diverger,
  // c'est écrire d'un côté ce que l'autre ne saura pas relire. Il n'y a pas de moyen de
  // partager le code : la PWA est du JavaScript nu, sans build ni dépendance, et c'est
  // exactement ce qui la rend increvable. Le prix est cette copie, tenue par les tests des
  // deux côtés (`banc_texte_riche.cjs` ici, `mobile/tests.html` là).
  //
  // ⚠️ La SAISIE LIBRE (l'écran « Note ») reste du texte simple, séparateur compris : elle
  // finit dans un fichier sur le disque, que Julien lit tel quel.

  var PUCES_RICHES = ['• ', '  ◦ ', '    ▪ ', '      • ', '        ◦ ', '          ▪ '];
  var NIVEAUX_RICHES = PUCES_RICHES.length;
  var GLYPHES_RICHES = ['\u2022', '\u25e6', '\u25aa'];
  // Ordre d'imbrication à l'écriture : du plus extérieur au plus intérieur.
  var STYLES_RICHES = ['surligne', 'gras', 'italique'];
  var MARQUEURS_RICHES = { surligne: '==', gras: '**', italique: '__' };
  var BALISES_RICHES = { surligne: 'mark', gras: 'strong', italique: 'em' };
  // Ce qui fait un mot, quand on applique un style sans rien avoir sélectionné.
  var LETTRE_RICHE = /[\p{L}\p{N}'’-]/u;

  function echapperHtml(texte) {
    return String(texte)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function niveauPuceRiche(ligne) {
    for (var n = NIVEAUX_RICHES - 1; n >= 0; n--) {
      if (ligne.indexOf(PUCES_RICHES[n]) === 0) return n;
    }
    return -1;
  }

  function marqueVide() {
    return { gras: false, italique: false, surligne: false };
  }

  function memeMarque(a, b) {
    return a.gras === b.gras && a.italique === b.italique && a.surligne === b.surligne;
  }

  function copierMarque(m) {
    return { gras: m.gras, italique: m.italique, surligne: m.surligne };
  }

  /** Contenu balisé → caractères nus et le style de chacun. */
  function deplierRiche(contenu) {
    contenu = String(contenu == null ? '' : contenu);
    var plat = '';
    var marques = [];
    var ouverts = [];
    var i = 0;
    while (i < contenu.length) {
      var deux = contenu.slice(i, i + 2);
      var style = null;
      for (var k = 0; k < STYLES_RICHES.length; k++) {
        if (MARQUEURS_RICHES[STYLES_RICHES[k]] === deux) { style = STYLES_RICHES[k]; break; }
      }
      if (style !== null) {
        if (ouverts.length && ouverts[ouverts.length - 1] === style) {
          ouverts.pop();
          i += 2;
          continue;
        }
        if (ouverts.indexOf(style) === -1 && contenu.indexOf(MARQUEURS_RICHES[style], i + 2) !== -1) {
          ouverts.push(style);
          i += 2;
          continue;
        }
        // Marqueur qui ne ferme rien et n'ouvre rien : il vaut pour lui-même.
      }
      plat += contenu.charAt(i);
      marques.push({
        gras: ouverts.indexOf('gras') !== -1,
        italique: ouverts.indexOf('italique') !== -1,
        surligne: ouverts.indexOf('surligne') !== -1,
      });
      i += 1;
    }
    return { plat: plat, marques: marques };
  }

  /** Caractères nus et leur style → contenu balisé, imbrication toujours canonique. */
  function replierRiche(plat, marques) {
    var sortie = '';
    var ouverts = [];
    for (var i = 0; i < plat.length; i++) {
      var marque = marques[i] || marqueVide();
      var cible = STYLES_RICHES.filter(function (s) { return marque[s]; });
      var commun = 0;
      while (commun < ouverts.length && commun < cible.length && ouverts[commun] === cible[commun]) {
        commun += 1;
      }
      while (ouverts.length > commun) sortie += MARQUEURS_RICHES[ouverts.pop()];
      for (var k = commun; k < cible.length; k++) {
        ouverts.push(cible[k]);
        sortie += MARQUEURS_RICHES[cible[k]];
      }
      sortie += plat.charAt(i);
    }
    while (ouverts.length) sortie += MARQUEURS_RICHES[ouverts.pop()];
    return sortie;
  }

  /** Découpe des caractères marqués en morceaux de style homogène. */
  function morceauxRiches(plat, marques) {
    var sortie = [];
    for (var i = 0; i < plat.length; i++) {
      var marque = marques[i] || marqueVide();
      var dernier = sortie[sortie.length - 1];
      if (dernier && memeMarque(dernier, marque)) dernier.texte += plat.charAt(i);
      else {
        var morceau = copierMarque(marque);
        morceau.texte = plat.charAt(i);
        sortie.push(morceau);
      }
    }
    return sortie;
  }

  /** Texte stocké → modèle. Un texte vide donne UNE ligne vide, jamais zéro. */
  function lireModeleRiche(texte) {
    return String(texte == null ? '' : texte).split('\n').map(function (ligne) {
      if (estSeparateur(ligne)) return { type: 'trait' };
      var niveau = niveauPuceRiche(ligne);
      var contenu = niveau === -1 ? ligne : ligne.slice(PUCES_RICHES[niveau].length);
      var deplie = deplierRiche(contenu);
      return { type: 'texte', niveau: niveau, plat: deplie.plat, marques: deplie.marques };
    });
  }

  /** Modèle → texte stocké. */
  function ecrireModeleRiche(lignes) {
    return lignes
      .map(function (l) {
        if (l.type === 'trait') return SEPARATEUR;
        return (l.niveau === -1 ? '' : PUCES_RICHES[l.niveau]) + replierRiche(l.plat, l.marques);
      })
      .join('\n');
  }

  /** Le texte débarrassé de ses marqueurs de style (pour un EXTRAIT). */
  function texteNuRiche(texte) {
    return lireModeleRiche(texte)
      .map(function (l) {
        if (l.type === 'trait') return '—';
        return (l.niveau === -1 ? '' : PUCES_RICHES[l.niveau]) + l.plat;
      })
      .join('\n');
  }

  /**
   * Une description rendue en HTML sûr : tout est échappé, seules nos propres balises sont
   * ouvertes. Construit SUR LE MODÈLE — un seul analyseur, qui ne peut pas diverger de
   * celui qui écrit.
   */
  function htmlTexteRiche(texte) {
    var lignes = lireModeleRiche(texte);
    var sortie = '';
    var profondeur = 0;
    function fermerJusqua(cible) {
      while (profondeur > cible) { sortie += '</ul>'; profondeur -= 1; }
    }
    for (var i = 0; i < lignes.length; i++) {
      var ligne = lignes[i];
      if (ligne.type === 'trait') {
        fermerJusqua(0);
        sortie += '<hr class="tr-trait">';
        continue;
      }
      var parts = morceauxRiches(ligne.plat, ligne.marques);
      var dedans = '';
      if (parts.length === 0) {
        // Un bloc sans texte n'est ni visible ni atteignable au doigt : il lui faut un
        // `<br>`. Vrai en lecture comme en édition — un seul chemin, donc pas de piège.
        dedans = '<br>';
      } else {
        for (var k = 0; k < parts.length; k++) {
          var part = parts[k];
          var morceau = echapperHtml(part.texte);
          // Du plus intérieur au plus extérieur : l'ordre est celui de STYLES_RICHES.
          if (part.italique) morceau = '<em>' + morceau + '</em>';
          if (part.gras) morceau = '<strong>' + morceau + '</strong>';
          if (part.surligne) morceau = '<mark>' + morceau + '</mark>';
          dedans += morceau;
        }
      }
      if (ligne.niveau === -1) {
        fermerJusqua(0);
        sortie += '<p class="tr-p">' + dedans + '</p>';
        continue;
      }
      var vise = Math.min(ligne.niveau, NIVEAUX_RICHES - 1) + 1;
      fermerJusqua(vise);
      while (profondeur < vise) { sortie += '<ul class="tr-liste">'; profondeur += 1; }
      sortie += '<li class="tr-item">' + dedans + '</li>';
    }
    fermerJusqua(0);
    return sortie;
  }

  // ---- Les gestes, sur le modèle (fonctions pures) ----
  //
  // Une position se dit `{ ligne, plat }` : le rang de la ligne, et le rang du caractère
  // DANS LE TEXTE NU de cette ligne. Jamais un décalage de chaîne — couper une ligne au
  // milieu d'un gras déplace les marqueurs, et un décalage de chaîne tomberait à côté.
  // Un « état » est `{ lignes, debut, fin }`.

  function copierLigneRiche(l) {
    if (l.type === 'trait') return { type: 'trait' };
    return { type: 'texte', niveau: l.niveau, plat: l.plat, marques: l.marques.map(copierMarque) };
  }

  function copierLignesRiches(lignes) {
    return lignes.map(copierLigneRiche);
  }

  function longueurRiche(l) {
    return l.type === 'trait' ? 0 : l.plat.length;
  }

  function ligneVideRiche(niveau) {
    return { type: 'texte', niveau: niveau, plat: '', marques: [] };
  }

  function bornerRiche(lignes, position) {
    var ligne = Math.max(0, Math.min(lignes.length - 1, position.ligne));
    return { ligne: ligne, plat: Math.max(0, Math.min(longueurRiche(lignes[ligne]), position.plat)) };
  }

  function memePositionRiche(a, b) {
    return a.ligne === b.ligne && a.plat === b.plat;
  }

  function ordonnerRiche(a, b) {
    var apresA = b.ligne < a.ligne || (b.ligne === a.ligne && b.plat < a.plat);
    return apresA ? [b, a] : [a, b];
  }

  /** Efface la sélection et renvoie les lignes + le point de jonction. */
  function retirerPlageRiche(lignes, debut, fin) {
    if (memePositionRiche(debut, fin)) return { lignes: copierLignesRiches(lignes), point: debut };
    var avant = copierLignesRiches(lignes.slice(0, debut.ligne));
    var apres = copierLignesRiches(lignes.slice(fin.ligne + 1));
    var premiere = lignes[debut.ligne];
    var derniere = lignes[fin.ligne];
    // Le trait ne se coupe pas : touché par la sélection, il disparaît entièrement.
    var tetePlat = premiere.type === 'trait' ? '' : premiere.plat.slice(0, debut.plat);
    var teteMarques = premiere.type === 'trait' ? [] : premiere.marques.slice(0, debut.plat).map(copierMarque);
    var queuePlat = derniere.type === 'trait' ? '' : derniere.plat.slice(fin.plat);
    var queueMarques = derniere.type === 'trait' ? [] : derniere.marques.slice(fin.plat).map(copierMarque);
    var niveau = premiere.type === 'trait'
      ? (derniere.type === 'trait' ? -1 : derniere.niveau)
      : premiere.niveau;
    var fusion = {
      type: 'texte',
      niveau: niveau,
      plat: tetePlat + queuePlat,
      marques: teteMarques.concat(queueMarques),
    };
    return {
      lignes: avant.concat([fusion], apres),
      point: { ligne: debut.ligne, plat: tetePlat.length },
    };
  }

  function marqueHeriteeRiche(ligne, plat) {
    if (ligne.type === 'trait') return marqueVide();
    var voisin = ligne.marques[plat - 1] || ligne.marques[plat] || marqueVide();
    return copierMarque(voisin);
  }

  /** Insertion de texte ordinaire (collage). Les sauts deviennent des lignes ordinaires. */
  function insererRiche(lignes, debut, fin, texte) {
    var base = retirerPlageRiche(lignes, debut, fin);
    var point = base.point;
    var cible = base.lignes[point.ligne];
    if (cible.type === 'trait') return { lignes: base.lignes, debut: point, fin: point };
    var marque = marqueHeriteeRiche(cible, point.plat);
    var bouts = String(texte).replace(/\r\n?/g, '\n').split('\n');
    var teteP = cible.plat.slice(0, point.plat);
    var teteM = cible.marques.slice(0, point.plat);
    var queueP = cible.plat.slice(point.plat);
    var queueM = cible.marques.slice(point.plat);
    function marquesDe(mot) {
      var sortie = [];
      for (var i = 0; i < mot.length; i++) sortie.push(copierMarque(marque));
      return sortie;
    }
    if (bouts.length === 1) {
      base.lignes[point.ligne] = {
        type: 'texte',
        niveau: cible.niveau,
        plat: teteP + bouts[0] + queueP,
        marques: teteM.concat(marquesDe(bouts[0]), queueM),
      };
      var arrivee = { ligne: point.ligne, plat: teteP.length + bouts[0].length };
      return { lignes: base.lignes, debut: arrivee, fin: arrivee };
    }
    var neuves = bouts.map(function (bout, rang) {
      var dernier = rang === bouts.length - 1;
      return {
        type: 'texte',
        // La première ligne garde sa puce ; les suivantes naissent ordinaires — un texte
        // collé ne s'invente pas une liste.
        niveau: rang === 0 ? cible.niveau : -1,
        plat: (rang === 0 ? teteP : '') + bout + (dernier ? queueP : ''),
        marques: (rang === 0 ? teteM : []).concat(marquesDe(bout), dernier ? queueM : []),
      };
    });
    var suite = base.lignes.slice(0, point.ligne).concat(neuves, base.lignes.slice(point.ligne + 1));
    var arriveeM = {
      ligne: point.ligne + bouts.length - 1,
      plat: bouts[bouts.length - 1].length,
    };
    return { lignes: suite, debut: arriveeM, fin: arriveeM };
  }

  /**
   * Entrée. Sur une puce garnie, la ligne suivante naît au même niveau ; sur une puce VIDE,
   * on SORT de la liste d'un cran au lieu d'empiler une puce de plus.
   */
  function entreeRiche(lignes, debut, fin, enchainer) {
    if (enchainer === undefined) enchainer = true;
    var base = retirerPlageRiche(lignes, debut, fin);
    var point = base.point;
    var cible = base.lignes[point.ligne];
    if (cible.type !== 'trait' && enchainer && cible.niveau >= 0 && cible.plat.trim() === '') {
      base.lignes[point.ligne] = ligneVideRiche(cible.niveau - 1);
      var sortie = { ligne: point.ligne, plat: 0 };
      return { lignes: base.lignes, debut: sortie, fin: sortie };
    }
    var estTrait = cible.type === 'trait';
    var niveauSuite = estTrait || !enchainer ? -1 : cible.niveau;
    var haut = estTrait
      ? { type: 'trait' }
      : {
        type: 'texte',
        niveau: cible.niveau,
        plat: cible.plat.slice(0, point.plat),
        marques: cible.marques.slice(0, point.plat),
      };
    var bas = {
      type: 'texte',
      niveau: niveauSuite,
      plat: estTrait ? '' : cible.plat.slice(point.plat),
      marques: estTrait ? [] : cible.marques.slice(point.plat),
    };
    var suite = base.lignes.slice(0, point.ligne).concat([haut, bas], base.lignes.slice(point.ligne + 1));
    var arrivee = { ligne: point.ligne + 1, plat: 0 };
    return { lignes: suite, debut: arrivee, fin: arrivee };
  }

  /**
   * Un cran de plus (`sens = 1`) ou de moins (`sens = -1`) sur les puces touchées.
   * `null` = aucune ne peut bouger (ligne ordinaire, ou bord de la liste).
   */
  function decalerRiche(lignes, debut, fin, sens) {
    var base = copierLignesRiches(lignes);
    var bouge = false;
    for (var i = debut.ligne; i <= fin.ligne; i++) {
      var ligne = base[i];
      if (!ligne || ligne.type === 'trait' || ligne.niveau === -1) continue;
      var vise = ligne.niveau + sens;
      if (vise < 0 || vise >= NIVEAUX_RICHES) continue;
      ligne.niveau = vise;
      bouge = true;
    }
    return bouge ? { lignes: base, debut: debut, fin: fin } : null;
  }

  /** Bascule la puce de niveau 0 sur toutes les lignes touchées. */
  function basculerPuceRiche(lignes, debut, fin) {
    var base = copierLignesRiches(lignes);
    var touchees = [];
    for (var i = debut.ligne; i <= fin.ligne; i++) {
      if (base[i] && base[i].type === 'texte') touchees.push(i);
    }
    if (!touchees.length) return { lignes: base, debut: debut, fin: fin };
    var toutesAPuce = touchees.every(function (i) { return base[i].niveau >= 0; });
    touchees.forEach(function (i) {
      base[i].niveau = toutesAPuce ? -1 : (base[i].niveau >= 0 ? base[i].niveau : 0);
    });
    return { lignes: base, debut: debut, fin: fin };
  }

  /** Trait de séparation, sur sa propre ligne — jamais deux traits collés l'un à l'autre. */
  function insererTraitRiche(lignes, debut, fin) {
    var base = retirerPlageRiche(lignes, debut, fin);
    var point = base.point;
    var cible = base.lignes[point.ligne];
    if (cible.type === 'texte' && cible.plat === '') {
      // Ligne vide : elle DEVIENT le trait, et une ligne neuve s'ouvre dessous.
      var suite = base.lignes.slice(0, point.ligne)
        .concat([{ type: 'trait' }, ligneVideRiche(-1)], base.lignes.slice(point.ligne + 1));
      var a1 = { ligne: point.ligne + 1, plat: 0 };
      return { lignes: suite, debut: a1, fin: a1 };
    }
    if (point.plat === 0) {
      // En tête de ligne : le trait se pose au-dessus, sans ouvrir de ligne vide.
      var suite2 = base.lignes.slice(0, point.ligne)
        .concat([{ type: 'trait' }], base.lignes.slice(point.ligne));
      var a2 = { ligne: point.ligne + 1, plat: 0 };
      return { lignes: suite2, debut: a2, fin: a2 };
    }
    // Sinon on coupe la ligne en deux et le trait se glisse entre les deux moitiés.
    var coupee = entreeRiche(base.lignes, point, point, false);
    var rang = coupee.debut.ligne;
    var suite3 = coupee.lignes.slice(0, rang).concat([{ type: 'trait' }], coupee.lignes.slice(rang));
    var a3 = { ligne: rang + 1, plat: 0 };
    return { lignes: suite3, debut: a3, fin: a3 };
  }

  function motAutourRiche(plat, position) {
    var gauche = position;
    var droite = position;
    while (gauche > 0 && LETTRE_RICHE.test(plat.charAt(gauche - 1))) gauche -= 1;
    while (droite < plat.length && LETTRE_RICHE.test(plat.charAt(droite))) droite += 1;
    return [gauche, droite];
  }

  /**
   * Gras / italique / surlignage. Sélection vide → le style s'applique au MOT sous le
   * curseur. Tout ce qui est sélectionné le porte déjà → on le retire ; sinon on l'ajoute.
   */
  function basculerStyleRiche(lignes, debut, fin, style) {
    var d = debut;
    var f = fin;
    if (memePositionRiche(d, f)) {
      var ligneD = lignes[d.ligne];
      if (!ligneD || ligneD.type !== 'texte') return { lignes: lignes, debut: debut, fin: fin };
      var bornes = motAutourRiche(ligneD.plat, d.plat);
      if (bornes[0] === bornes[1]) return { lignes: lignes, debut: debut, fin: fin };
      d = { ligne: d.ligne, plat: bornes[0] };
      f = { ligne: d.ligne, plat: bornes[1] };
    }
    var base = copierLignesRiches(lignes);
    function tranche(i) {
      var ligne = base[i];
      return [i === d.ligne ? d.plat : 0, i === f.ligne ? f.plat : longueurRiche(ligne)];
    }
    var toutStyle = true;
    var auMoinsUn = false;
    for (var i = d.ligne; i <= f.ligne; i++) {
      var ligne = base[i];
      if (!ligne || ligne.type !== 'texte') continue;
      var t = tranche(i);
      for (var k = t[0]; k < t[1]; k++) {
        auMoinsUn = true;
        if (!ligne.marques[k][style]) toutStyle = false;
      }
    }
    if (!auMoinsUn) return { lignes: lignes, debut: debut, fin: fin };
    var valeur = !toutStyle;
    for (var j = d.ligne; j <= f.ligne; j++) {
      var l2 = base[j];
      if (!l2 || l2.type !== 'texte') continue;
      var t2 = tranche(j);
      for (var m = t2[0]; m < t2[1]; m++) l2.marques[m][style] = valeur;
    }
    return { lignes: base, debut: d, fin: f };
  }

  /** Le style est-il porté par TOUTE la sélection ? (état enfoncé des boutons). */
  function styleActifRiche(lignes, debut, fin, style) {
    var bornes = ordonnerRiche(debut, fin);
    var d = bornes[0];
    var f = bornes[1];
    if (memePositionRiche(d, f)) {
      var ligne = lignes[d.ligne];
      if (!ligne || ligne.type !== 'texte') return false;
      var voisin = ligne.marques[d.plat - 1] || ligne.marques[d.plat];
      return !!(voisin && voisin[style]);
    }
    var auMoinsUn = false;
    for (var i = d.ligne; i <= f.ligne; i++) {
      var l = lignes[i];
      if (!l || l.type !== 'texte') continue;
      var de = i === d.ligne ? d.plat : 0;
      var a = i === f.ligne ? f.plat : l.plat.length;
      for (var k = de; k < a; k++) {
        auMoinsUn = true;
        if (!l.marques[k][style]) return false;
      }
    }
    return auMoinsUn;
  }

  /**
   * Retour arrière en TÊTE de ligne. Deux cas seulement, ceux qu'un navigateur ferait mal :
   * une puce recule d'un niveau (puis perd sa puce), et un trait se supprime d'un coup.
   * `null` partout ailleurs — le retour arrière ordinaire reste celui du navigateur.
   */
  function retourArriereRiche(lignes, debut, fin) {
    if (!memePositionRiche(debut, fin) || debut.plat !== 0) return null;
    var base = copierLignesRiches(lignes);
    var cible = base[debut.ligne];
    if (cible && cible.type === 'texte' && cible.niveau >= 0) {
      cible.niveau -= 1;
      return { lignes: base, debut: debut, fin: debut };
    }
    var precedente = base[debut.ligne - 1];
    if (precedente && precedente.type === 'trait') {
      base.splice(debut.ligne - 1, 1);
      var arrivee = { ligne: debut.ligne - 1, plat: 0 };
      return { lignes: base, debut: arrivee, fin: arrivee };
    }
    return null;
  }

  // ============================================================================
  // COURSES (SPEC du 18-08-2026) — logique pure du 5ᵉ onglet.
  //
  // Le téléphone est **bête et hors ligne** : il lit `courses.json`, coche au pouce, et
  // fabrique deux fichiers que Julien dépose lui-même dans le dossier Drive. Il n'écrit
  // jamais rien directement dans le Cockpit, et n'appelle personne.
  //
  // ⚠️ Les trois formats ci-dessous sont le **miroir exact** de `courses/contrats.rs`. Le
  // Rust reste l'autorité : il refuse une version qu'il ne connaît pas, et ignore un champ
  // qu'il ne comprend pas. Ce fichier tient la même règle dans l'autre sens.
  // ============================================================================

  var FORMAT_COURSES = 'cockpit-courses';
  var FORMAT_COCHES = 'cockpit-courses-coches';
  var FORMAT_EPHEMERE = 'cockpit-courses-ephemere';

  // Les trois enseignes qui partent au drive — **miroir de `contrats::volet_de`**. Tout le
  // reste s'achète sur place, y compris Écomiam (règle littérale de la spec §7).
  var ENSEIGNES_DRIVE = { super_u: 1, picard: 1, en_ligne: 1 };

  function voletDe(enseigne) {
    return ENSEIGNES_DRIVE[String(enseigne || '').trim()] ? 'drive_en_ligne' : 'sur_place';
  }

  // L'ordre des enseignes à l'écran : celui des courses de Julien, pas l'alphabet.
  var ORDRE_ENSEIGNES = [
    'super_u', 'picard', 'biocoop', 'boucher', 'boulangerie', 'marche', 'en_ligne', 'ecomiam', 'autre',
  ];

  var LIBELLES_ENSEIGNE = {
    super_u: 'Super U', picard: 'Picard', biocoop: 'Biocoop', boucher: 'Boucher',
    boulangerie: 'Boulangerie', marche: 'Marché', en_ligne: 'En ligne', ecomiam: 'Ecomiam',
    autre: 'Autre', '': 'Sans enseigne',
  };

  function libelleEnseigne(cle) {
    return LIBELLES_ENSEIGNE[cle] || cle;
  }

  // ---- Lecture de `courses.json` (§8.1) ----
  //
  // Même doctrine que `parseReferentiel` : format inconnu et version inconnue sont refusés
  // par une phrase que Julien peut lire, jamais par une demi-lecture.
  function parseCourses(texte) {
    var brut;
    try {
      brut = JSON.parse(texte);
    } catch (e) {
      return { ok: false, erreur: "Ce fichier n'est pas lisible (JSON invalide)." };
    }
    if (!brut || typeof brut !== 'object' || brut.format !== FORMAT_COURSES) {
      return { ok: false, erreur: "Ce fichier n'est pas le référentiel des courses (courses.json)." };
    }
    if (brut.version !== VERSION) {
      return {
        ok: false,
        versionInconnue: true,
        erreur:
          'Ce fichier est en version ' + brut.version + ', que cette application ne comprend pas. ' +
          "Mets à jour l'application avant de le charger.",
      };
    }
    return {
      ok: true,
      genere_le: brut.genere_le || '',
      themes: Array.isArray(brut.themes) ? brut.themes : [],
      articles: Array.isArray(brut.articles) ? brut.articles : [],
      omega3: brut.omega3 && typeof brut.omega3 === 'object' ? brut.omega3 : null,
      // Champ additif : un instantané plus ancien n'en a pas, et l'écran le dit.
      ephemere: brut.ephemere && typeof brut.ephemere === 'object' ? brut.ephemere : null,
    };
  }

  // ---- Le regroupement à deux niveaux, enseigne → thème (§6) ----
  //
  // Miroir de `grouper` côté PC. Les deux écrans doivent montrer le MÊME rangement : c'est
  // ce qui fait qu'on retrouve un article au même endroit sur les deux appareils.
  function grouperCourses(articles, themes) {
    var rangTheme = {};
    themes.forEach(function (t, i) { rangTheme[t.libelle] = t.ordre || i + 1; });

    var parEnseigne = {};
    articles.forEach(function (a) {
      var cle = String(a.enseigne_principale || '');
      if (!parEnseigne[cle]) parEnseigne[cle] = {};
      var theme = String(a.theme || '');
      if (!parEnseigne[cle][theme]) parEnseigne[cle][theme] = [];
      parEnseigne[cle][theme].push(a);
    });

    return Object.keys(parEnseigne)
      .map(function (cle) {
        var blocs = Object.keys(parEnseigne[cle])
          .map(function (theme) {
            var liste = parEnseigne[cle][theme].slice().sort(function (a, b) {
              return (a.ordre || 0) - (b.ordre || 0);
            });
            return { theme: theme, ordre: rangTheme[theme] || 9999, articles: liste };
          })
          .sort(function (a, b) { return a.ordre - b.ordre; });
        var total = 0;
        blocs.forEach(function (b) { total += b.articles.length; });
        return {
          cle: cle,
          libelle: libelleEnseigne(cle),
          volet: voletDe(cle),
          themes: blocs,
          total: total,
        };
      })
      .sort(function (a, b) {
        var ra = ORDRE_ENSEIGNES.indexOf(a.cle);
        var rb = ORDRE_ENSEIGNES.indexOf(b.cle);
        return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
      });
  }

  // Repli de casse et d'accents — « video » trouve « vidéo ». Même règle que sur le PC.
  function replierTexte(texte) {
    return String(texte || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase();
  }

  // Le filtre de l'écran : liste source, recherche (nom, remarque, notes), cochés seulement,
  // thème et enseigne. Plusieurs mots = ET.
  function filtrerCourses(articles, filtres) {
    var f = filtres || {};
    var mots = replierTexte(f.requete || '').split(/\s+/).filter(Boolean);
    return articles.filter(function (a) {
      if (f.source === 'repas_rapides' && !a.repas_rapide) return false;
      if (f.cochesSeulement && !a.coche) return false;
      if (f.theme && a.theme !== f.theme) return false;
      if (f.enseigne && String(a.enseigne_principale || '') !== f.enseigne) return false;
      if (mots.length === 0) return true;
      var champs = replierTexte(a.nom) + ' ' + replierTexte(a.remarque) + ' ' + replierTexte(a.notes);
      return mots.every(function (mot) { return champs.indexOf(mot) !== -1; });
    });
  }

  // ---- Ce que le téléphone FABRIQUE ----

  // `coches courses AAAA-MM-JJ HHhMMmSS xxxxxx.json` — même nommeur que le lot de notes,
  // seul le préfixe change. L'ordre alphabétique reste l'ordre chronologique.
  function nomFichierCourses(prefixe, uuidFichier, d) {
    d = d || new Date();
    var court = String(uuidFichier || '').replace(/[^0-9a-f]/gi, '').slice(0, 6).toLowerCase();
    while (court.length < 6) court += '0';
    return (
      prefixe + ' ' + dateISO(d) + ' ' + deux(d.getHours()) + 'h' + deux(d.getMinutes()) + 'm' +
      deux(d.getSeconds()) + ' ' + court + '.json'
    );
  }

  function cochesFilename(uuidLot, d) {
    return nomFichierCourses('coches courses', uuidLot, d);
  }

  function ephemereFilename(uuidDoc, d) {
    return nomFichierCourses('liste ephemere', uuidDoc, d);
  }

  /**
   * Le lot de coches (§8.2). **Additif seulement : un lot ne décoche JAMAIS.**
   *
   * `coches` est la carte locale { article_uuid: { quantite, commentaire } } — seules les
   * coches POSÉES sur le téléphone y figurent. Une coche retirée ici disparaît simplement
   * de la carte : elle ne devient pas un ordre de décochage, parce que décocher est un
   * geste du PC.
   */
  function buildLotCoches(coches, uuidLot, genereLe) {
    var lignes = Object.keys(coches || {}).map(function (uuidArticle) {
      var c = coches[uuidArticle] || {};
      return {
        article_uuid: uuidArticle,
        quantite: String(c.quantite || ''),
        commentaire: String(c.commentaire || ''),
      };
    });
    return {
      format: FORMAT_COCHES,
      version: VERSION,
      uuid: uuidLot,
      genere_le: genereLe,
      coches: lignes,
    };
  }

  /**
   * Une liste éphémère fabriquée par le téléphone (§8.3), à partir du référentiel importé
   * et des coches locales — **leur UNION** : ce que le PC avait déjà coché et ce que Julien
   * vient de cocher ici partent ensemble.
   *
   * `origine` vaut `telephone` : c'est ce champ, et lui seul, qui dira au PC de la
   * normaliser. Jamais l'endroit où le fichier se trouve.
   */
  function buildEphemereTelephone(articles, coches, source, uuidDoc, genereLe) {
    var volets = { sur_place: [], drive_en_ligne: [] };
    (articles || []).forEach(function (a) {
      var locale = (coches || {})[a.uuid];
      if (!a.coche && !locale) return;
      if (source === 'repas_rapides' && !a.repas_rapide) return;
      var ligne = {
        article_uuid: a.uuid,
        nom: a.nom,
        theme: a.theme || '',
        enseigne_principale: a.enseigne_principale || '',
        enseigne_detail: a.enseigne_detail || '',
        // La quantité du téléphone prend le pas si elle est renseignée — même règle que la
        // fusion des coches côté PC.
        quantite: (locale && locale.quantite) || a.quantite || '',
        commentaire: (locale && locale.commentaire) || a.commentaire || '',
        prix: a.prix || {},
        remarque: a.remarque || '',
        achat: a.achat || '',
      };
      volets[voletDe(a.enseigne_principale)].push(ligne);
    });
    var parLieu = function (x, y) {
      var a = (x.enseigne_principale || '') + ' ' + (x.theme || '') + ' ' + x.nom;
      var b = (y.enseigne_principale || '') + ' ' + (y.theme || '') + ' ' + y.nom;
      return a < b ? -1 : a > b ? 1 : 0;
    };
    volets.sur_place.sort(parLieu);
    volets.drive_en_ligne.sort(parLieu);
    return {
      format: FORMAT_EPHEMERE,
      version: VERSION,
      uuid: uuidDoc,
      genere_le: genereLe,
      origine: 'telephone',
      source: source === 'repas_rapides' ? 'repas_rapides' : 'complete',
      remplace_uuid: '',
      volets: volets,
    };
  }

  function documentJson(doc) {
    return JSON.stringify(doc, null, 2);
  }


  global.Core = {
    FORMAT_LOT: FORMAT_LOT,
    FORMAT_PROJETS: FORMAT_PROJETS,
    FORMAT_BACKLOGS: FORMAT_BACKLOGS,
    FORMAT_COURSES: FORMAT_COURSES,
    FORMAT_COCHES: FORMAT_COCHES,
    FORMAT_EPHEMERE: FORMAT_EPHEMERE,
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
    lignesParlantes: lignesParlantes,
    htmlTexteRiche: htmlTexteRiche,
    texteNuRiche: texteNuRiche,
    lireModeleRiche: lireModeleRiche,
    ecrireModeleRiche: ecrireModeleRiche,
    deplierRiche: deplierRiche,
    replierRiche: replierRiche,
    morceauxRiches: morceauxRiches,
    niveauPuceRiche: niveauPuceRiche,
    PUCES_RICHES: PUCES_RICHES,
    NIVEAUX_RICHES: NIVEAUX_RICHES,
    bornerRiche: bornerRiche,
    ordonnerRiche: ordonnerRiche,
    insererRiche: insererRiche,
    entreeRiche: entreeRiche,
    decalerRiche: decalerRiche,
    basculerPuceRiche: basculerPuceRiche,
    insererTraitRiche: insererTraitRiche,
    basculerStyleRiche: basculerStyleRiche,
    styleActifRiche: styleActifRiche,
    retourArriereRiche: retourArriereRiche,
    // Courses (18-08-2026) — 5ᵉ onglet.
    parseCourses: parseCourses,
    voletDe: voletDe,
    libelleEnseigne: libelleEnseigne,
    grouperCourses: grouperCourses,
    filtrerCourses: filtrerCourses,
    replierTexte: replierTexte,
    cochesFilename: cochesFilename,
    ephemereFilename: ephemereFilename,
    buildLotCoches: buildLotCoches,
    buildEphemereTelephone: buildEphemereTelephone,
    documentJson: documentJson,
    ORDRE_ENSEIGNES: ORDRE_ENSEIGNES,
  };
})(window);
