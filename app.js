// app.js — INTERFACE de l'application mobile de notes du Cockpit.
//
// Vanilla, sans framework : un objet d'état unique `S`, un `render()` qui réécrit l'écran,
// et une délégation d'événements posée une seule fois (aucun gestionnaire à rebrancher
// après chaque rendu). Toute confirmation passe par une **modale maison**, jamais par un
// dialogue du navigateur ; une confirmation posée par-dessus un autre calque passe devant.
//
// Quatre écrans : **Écrire** (note libre, ticket ou idée — SPEC notes typées §4.1), **File**
// (envoyer, recevoir les référentiels), **Backlogs** et **Idées** (consultations en lecture
// seule). Le bloc « Envoi vers le PC » est nettement séparé du bouton d'enregistrement : ce
// sont deux gestes de nature opposée — l'un remplit la file, l'autre la vide — et les coller
// a déjà coûté des erreurs de manipulation sur l'application de budget.
(function (global) {
  'use strict';

  var Core = global.Core;
  var Store = global.Store;

  var S = {
    ecran: 'note',
    // Genre de saisie (SPEC notes typées §4.1) : 'note' par défaut ; après l'enregistrement
    // d'un ticket ou d'une idée, on REVIENT à 'note' (D5) — le projet, lui, est conservé.
    genre: 'note',
    // La fiche du formulaire Ticket/Idée (Core.ficheVierge) ; sans objet pour une note.
    fiche: Core.ficheVierge(),
    texte: '',
    cible: null,
    cibleNom: '',
    date: Core.dateISO(),
    edition: null,
    notes: [],
    projets: [],
    projetsGenereLe: '',
    backlogs: [],
    backlogsGenereLe: '',
    // Colonne RDV GLOBALE : les RDV de tous les projets, montrés dans le Backlog de
    // chacun — miroir du Cockpit (SPEC 08 §6).
    backlogsRdv: [],
    backlogProjet: null,
    colonneOuverte: null,
    ticket: null,
    // Écran « Idées » (lecture seule, §4.5) — même patron que les backlogs.
    ideeProjet: null,
    categorieOuverte: null,
    idee: null,
    // `cible` du mini-calendrier : 'note' (date de saisie) ou 'fiche' (échéance / jour du
    // rendez-vous du formulaire Ticket).
    calendrier: null,
    confirmation: null,
    // Lot fabriqué d'avance, en attente du « Confirmer » (voir `preparerEnvoi`).
    lotPret: null,
    // Panneau d'accompagnement du dépôt : il RESTE à l'écran jusqu'à ce que Julien le
    // ferme. Un message fugace ne suffit pas — le transport est manuel, il faut le guider.
    depot: null,
    // Dernier lot fabriqué, conservé pour pouvoir le retélécharger sans rien renvoyer.
    dernierLot: null,
    // « Envoyées » est repliée par défaut : la liste ne cesse de grandir (rien n'est jamais
    // purgé) et deviendrait un mur. **Repli d'AFFICHAGE seulement** — aucune note n'est
    // supprimée, « Tout renvoyer » continue de porter tout l'historique.
    toutAfficherEnvoyees: false,
    // Sélection de notes à renvoyer : `null` = mode inactif, sinon une table uuid → true.
    // Renvoyer ne modifie RIEN (les notes sont déjà envoyées, le PC dédoublonne par UUID) :
    // c'est une opération sans confirmation, qui ne fait que produire un fichier.
    selection: null,
    // Version affichée, LUE du nom du cache du service worker (`cockpit-notes-vN`) : elle
    // est donc toujours exacte, sans constante à tenir à jour. Sans elle, impossible de
    // savoir depuis le téléphone si une mise à jour est bien arrivée — le service worker
    // pouvant resservir l'ancienne version sans le dire.
    version: null,
    // Message fugace. `ton` colore le fond : 'erreur' (rouge), 'succes' (vert), 'neutre'
    // (encre) — les couleurs de validation classiques (avenant A4).
    message: null,
    tonMessage: 'neutre',
    minuteurMessage: null,
    // Bandeau de succès de l'écran Écrire (avenant A3) : après un enregistrement, le
    // retour à une édition vierge se voit — effacé à la prochaine saisie ou tout seul.
    succes: null,
    minuteurSucces: null,
  };

  function racine() {
    return document.getElementById('app');
  }

  function ech(texte) {
    return String(texte == null ? '' : texte)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function signaler(texte, ton) {
    S.message = texte;
    S.tonMessage = ton === 'erreur' || ton === 'succes' ? ton : 'neutre';
    if (S.minuteurMessage) clearTimeout(S.minuteurMessage);
    S.minuteurMessage = setTimeout(function () {
      S.message = null;
      render();
    }, S.tonMessage === 'erreur' ? 4200 : 2600);
    render();
  }

  // Les couleurs de validation classiques (avenant A4) : rouge pour ce qui a échoué,
  // vert pour ce qui a abouti — le neutre reste aux informations.
  function signalerErreur(texte) {
    signaler(texte, 'erreur');
  }

  function signalerSucces(texte) {
    signaler(texte, 'succes');
  }

  // Bandeau de succès de l'écran Écrire (avenant A3) : plus durable que le message
  // fugace, à l'endroit exact où l'œil revient — le formulaire redevenu vierge.
  function poserSucces(texte) {
    S.succes = texte;
    if (S.minuteurSucces) clearTimeout(S.minuteurSucces);
    S.minuteurSucces = setTimeout(function () {
      S.succes = null;
      render();
    }, 6000);
  }

  // ---- Rendu -----------------------------------------------------------------

  function nbEnAttente() {
    return S.notes.filter(function (n) { return !n.envoyee; }).length;
  }

  function entete() {
    var attente = nbEnAttente();
    return (
      '<header class="entete">' +
      '<h1 class="marque">Notes</h1>' +
      '<span class="compteur' + (attente > 0 ? ' compteur-actif' : '') + '">' +
      (attente === 0 ? 'Tout est envoyé' : attente === 1 ? '1 note à envoyer' : attente + ' notes à envoyer') +
      '</span>' +
      (S.version ? '<span class="version">' + ech(S.version) + '</span>' : '') +
      '</header>'
    );
  }

  function onglets() {
    var items = [
      { cle: 'note', libelle: 'Écrire' },
      { cle: 'file', libelle: 'File' },
      { cle: 'backlogs', libelle: 'Backlogs' },
      { cle: 'idees', libelle: 'Idées' },
    ];
    return (
      '<nav class="onglets">' +
      items
        .map(function (o) {
          return (
            '<button type="button" class="onglet' + (S.ecran === o.cle ? ' onglet-actif' : '') +
            '" data-action="onglet" data-cible="' + o.cle + '">' + o.libelle + '</button>'
          );
        })
        .join('') +
      '</nav>'
    );
  }

  // -- Écran 1 : écrire — note libre, ticket ou idée (SPEC notes typées §4.1-§4.3) --

  // Le projet sélectionné, tel que l'instantané des backlogs le connaît (colonnes avec
  // leurs ids, catégories d'idées). `null` si l'instantané ne le connaît pas.
  function projetBacklog(cle) {
    return (
      S.backlogs.filter(function (p) {
        return p.cle === cle;
      })[0] || null
    );
  }

  // Pourquoi « Ticket » est grisé — `null` si possible (§4.6).
  function motifTicket() {
    if (!S.cible) return null; // le cas « sans projet » a son message commun (D1)
    if (Core.colonnesCiblables(projetBacklog(S.cible)).length === 0) {
      return 'Tickets indisponibles : cet instantané des backlogs date d\'avant les notes ' +
        'typées. Sur le PC : « Pousser maintenant », puis recharge backlogs.json.';
    }
    return null;
  }

  // Pourquoi « Idée » est grisée — `null` si possible (§4.6).
  function motifIdee() {
    if (!S.cible) return null;
    var categories = Core.categoriesDe(projetBacklog(S.cible));
    if (categories === null) {
      return 'Idées indisponibles : cet instantané des backlogs date d\'avant les notes ' +
        'typées. Sur le PC : « Pousser maintenant », puis recharge backlogs.json.';
    }
    if (categories.length === 0) {
      return 'Ce projet n\'a pas encore de catégorie : crée-la dans son Tableau à idées ' +
        'sur le PC, repousse, puis recharge backlogs.json.';
    }
    return null;
  }

  // Un genre devenu impossible (projet changé, référentiel rechargé) retombe sur la note
  // libre — jamais pendant une édition, qui porte déjà ses données.
  function assainirGenre() {
    if (S.edition !== null) return;
    if (S.genre === 'ticket' && (!S.cible || motifTicket() !== null)) S.genre = 'note';
    if (S.genre === 'idee' && (!S.cible || motifIdee() !== null)) S.genre = 'note';
  }

  function selecteurGenre() {
    var enEdition = S.edition !== null;
    var motifs = { note: null, ticket: motifTicket(), idee: motifIdee() };
    function segment(cle, libelle) {
      // En édition, rien n'est grisé : la note porte déjà ses données, et changer de
      // genre reste permis tant qu'elle n'est pas envoyée (§4.4).
      var grise = !enEdition && cle !== 'note' && (!S.cible || motifs[cle] !== null);
      return (
        '<button type="button" class="segment' + (S.genre === cle ? ' segment-actif' : '') +
        '"' + (grise ? ' disabled' : '') + ' data-action="genre" data-cle="' + cle + '">' +
        libelle + '</button>'
      );
    }
    var lignes = [];
    if (!enEdition) {
      if (!S.cible) {
        lignes.push('Sans projet choisi, seule la note libre part — choisis un projet ' +
          'plus bas pour un ticket ou une idée.');
      } else {
        if (motifs.ticket) lignes.push(motifs.ticket);
        if (motifs.idee && motifs.idee !== motifs.ticket) lignes.push(motifs.idee);
      }
    }
    return (
      '<section class="bloc bloc-segments">' +
      '<div class="segments">' +
      segment('note', 'Note') + segment('ticket', 'Ticket') + segment('idee', 'Idée') +
      '</div>' +
      lignes
        .map(function (l) {
          return '<p class="explication explication-segments">' + ech(l) + '</p>';
        })
        .join('') +
      '</section>'
    );
  }

  // Le corps d'une note LIBRE — inchangé.
  function blocSaisieNote(enEdition) {
    return (
      '<section class="bloc">' +
      '<h2 class="titre-bloc">' + (enEdition ? 'Modifier la note' : 'Nouvelle note') + '</h2>' +
      // 7 lignes : de quoi écrire largement, tout en laissant le choix du projet (et, au
      // premier lancement, le bouton d'import) atteignable sans faire défiler l'écran.
      // Le champ reste redimensionnable à la main (`resize: vertical`).
      '<textarea class="saisie" id="saisie" placeholder="Écris ta note…" rows="7">' + ech(S.texte) + '</textarea>' +
      '<div class="rangee-outils">' +
      '<button type="button" class="bouton bouton-doux" data-action="separateur">— Séparateur</button>' +
      '</div>' +
      '</section>'
    );
  }

  // Titre + description, communs aux deux fiches.
  function champsTitreDescription(quoi, enEdition) {
    return (
      '<section class="bloc">' +
      '<h2 class="titre-bloc">' +
      (enEdition ? 'Modifier ' + (quoi === 'ticket' ? 'le ticket' : "l'idée")
        : quoi === 'ticket' ? 'Nouveau ticket' : 'Nouvelle idée') +
      '</h2>' +
      '<input type="text" class="champ" data-champ="titre" placeholder="Titre" value="' +
      ech(S.fiche.titre) + '">' +
      '<textarea class="saisie saisie-fiche" data-champ="description" rows="4" ' +
      'placeholder="Description (facultative)">' + ech(S.fiche.description) + '</textarea>' +
      '</section>'
    );
  }

  // Les liens web, communs aux deux fiches (libellé + URL, ajout/retrait).
  function blocLiens() {
    return (
      '<section class="bloc">' +
      '<h2 class="titre-bloc">Liens web</h2>' +
      S.fiche.liens
        .map(function (l, i) {
          return (
            '<div class="rangee-lien">' +
            '<input type="text" class="champ champ-lien" data-champ="lien-libelle" data-index="' + i +
            '" placeholder="Libellé" value="' + ech(l.libelle) + '">' +
            '<input type="url" class="champ champ-lien" data-champ="lien-url" data-index="' + i +
            '" placeholder="https://…" value="' + ech(l.url) + '">' +
            '<button type="button" class="bouton bouton-danger bouton-retirer" ' +
            'data-action="fiche-retirer-lien" data-index="' + i + '" aria-label="Retirer ce lien">✕</button>' +
            '</div>'
          );
        })
        .join('') +
      '<button type="button" class="bouton bouton-doux" data-action="fiche-ajouter-lien">+ Ajouter un lien</button>' +
      '</section>'
    );
  }

  // Position d'arrivée : haut ou bas de colonne/catégorie, bas par défaut — comme le
  // formulaire du Cockpit.
  function blocPosition(libelle) {
    return (
      '<section class="bloc">' +
      '<h2 class="titre-bloc">' + libelle + '</h2>' +
      '<div class="segments segments-courts">' +
      ['bas', 'haut']
        .map(function (cle) {
          return (
            '<button type="button" class="segment' + (S.fiche.position === cle ? ' segment-actif' : '') +
            '" data-action="fiche-position" data-cle="' + cle + '">' +
            (cle === 'bas' ? 'En bas' : 'En haut') + '</button>'
          );
        })
        .join('') +
      '</div>' +
      '</section>'
    );
  }

  // La fiche Ticket (§4.2) : miroir du formulaire du Cockpit.
  function formulaireTicket(enEdition) {
    var colonnes = Core.colonnesCiblables(projetBacklog(S.cible));
    var pastillesColonnes = colonnes
      .map(function (c) {
        var active = !S.fiche.rdv && S.fiche.colonne_id === c.id;
        return (
          '<button type="button" class="pastille' + (active ? ' pastille-active' : '') +
          '" data-action="fiche-colonne" data-id="' + c.id + '" data-libelle="' + ech(c.libelle) +
          '" style="--teinte:' + ech(c.couleur || '#8A8F94') + '">' + ech(c.libelle) + '</button>'
        );
      })
      .join('');
    var pastilleRdv =
      '<button type="button" class="pastille pastille-rdv' + (S.fiche.rdv ? ' pastille-active' : '') +
      '" data-action="fiche-rdv">Rendez-vous</button>';
    // En édition sur un référentiel plus vieux que la note, les colonnes peuvent manquer :
    // la pré-sélection de la charge reste portée telle quelle, on le dit simplement.
    var sansColonnes = colonnes.length === 0 && !S.fiche.rdv
      ? '<p class="explication">Les colonnes de cet instantané ne sont pas ciblables — la ' +
        'pré-sélection enregistrée est conservée telle quelle.</p>'
      : '';

    var blocDate;
    if (S.fiche.rdv) {
      blocDate =
        '<section class="bloc">' +
        '<h2 class="titre-bloc">Rendez-vous — date et heure</h2>' +
        '<div class="rangee-outils">' +
        '<button type="button" class="bouton bouton-doux bouton-date" data-action="ouvrir-calendrier-fiche">' +
        (S.fiche.date_valeur ? Core.dateFr(S.fiche.date_valeur) : 'Choisir la date') + '</button>' +
        '<input type="text" class="champ champ-heure" data-champ="heure" inputmode="numeric" ' +
        'maxlength="5" placeholder="09:30" value="' + ech(S.fiche.heure) + '">' +
        '</div>' +
        '<p class="explication">Un rendez-vous vit dans la colonne RDV, avec date et heure.</p>' +
        '</section>';
    } else {
      blocDate =
        '<section class="bloc">' +
        '<h2 class="titre-bloc">Échéance (facultative)</h2>' +
        '<div class="rangee-outils">' +
        '<button type="button" class="bouton bouton-doux bouton-date" data-action="ouvrir-calendrier-fiche">' +
        (S.fiche.date_valeur ? Core.dateFr(S.fiche.date_valeur) : 'Aucune échéance') + '</button>' +
        (S.fiche.date_valeur
          ? '<button type="button" class="bouton bouton-doux" data-action="fiche-sans-echeance">Retirer</button>'
          : '') +
        '</div>' +
        '</section>';
    }

    return (
      champsTitreDescription('ticket', enEdition) +
      '<section class="bloc">' +
      '<h2 class="titre-bloc">Colonne</h2>' +
      // Grille STRICTE à deux colonnes (avenant A6) — alignée, rectangulaire, rangée.
      '<div class="pastilles pastilles-rangees">' + pastillesColonnes + pastilleRdv + '</div>' +
      sansColonnes +
      '</section>' +
      blocDate +
      '<section class="bloc">' +
      '<label class="choix-ligne"><input type="checkbox" data-action="fiche-rappel"' +
      (S.fiche.rappel_home ? ' checked' : '') + '> Rappel sur le Home</label>' +
      '</section>' +
      (S.fiche.rdv ? '' : blocPosition('Position dans la colonne')) +
      blocLiens()
    );
  }

  // La fiche Idée (§4.3) : miroir du formulaire du Tableau à idées.
  function formulaireIdee(enEdition) {
    var categories = Core.categoriesDe(projetBacklog(S.cible)) || [];
    var pastillesCategories = categories
      .map(function (c) {
        var active = S.fiche.categorie_id === c.id;
        return (
          '<button type="button" class="pastille' + (active ? ' pastille-active' : '') +
          '" data-action="fiche-categorie" data-id="' + c.id + '" data-libelle="' + ech(c.libelle) +
          '" style="--teinte:' + ech(c.couleur || '#8A8F94') + '">' + ech(c.libelle) + '</button>'
        );
      })
      .join('');
    var sansCategories = categories.length === 0
      ? '<p class="explication">Les catégories de cet instantané ne sont pas ciblables — la ' +
        'pré-sélection enregistrée est conservée telle quelle.</p>'
      : '';
    var maturites = [
      { cle: 'brut', libelle: 'Brut' },
      { cle: 'creuser', libelle: 'À creuser' },
      { cle: 'mure', libelle: 'Mûre' },
    ];

    return (
      champsTitreDescription('idee', enEdition) +
      '<section class="bloc">' +
      '<h2 class="titre-bloc">Catégorie</h2>' +
      '<div class="pastilles pastilles-rangees">' + pastillesCategories + '</div>' +
      sansCategories +
      '</section>' +
      '<section class="bloc">' +
      '<h2 class="titre-bloc">Maturité</h2>' +
      '<div class="segments">' +
      maturites
        .map(function (m) {
          return (
            '<button type="button" class="segment' + (S.fiche.maturite === m.cle ? ' segment-actif' : '') +
            '" data-action="fiche-maturite" data-cle="' + m.cle + '">' + m.libelle + '</button>'
          );
        })
        .join('') +
      '</div>' +
      '<label class="choix-ligne"><input type="checkbox" data-action="fiche-coeur"' +
      (S.fiche.coup_de_coeur ? ' checked' : '') + '> ★ Coup de cœur</label>' +
      '</section>' +
      blocPosition('Position dans la catégorie') +
      blocLiens()
    );
  }

  function ecranNote() {
    var enEdition = S.edition !== null;
    var pastilles = S.projets
      .map(function (p) {
        return (
          '<button type="button" class="pastille' + (S.cible === p.cle ? ' pastille-active' : '') +
          '" data-action="projet" data-cle="' + ech(p.cle) + '" data-nom="' + ech(p.nom) + '"' +
          ' style="--teinte:' + ech(p.couleur || '#8A8F94') + '">' + ech(p.nom) + '</button>'
        );
      })
      .join('');
    var sansProjet =
      '<button type="button" class="pastille pastille-sans' + (S.cible === null ? ' pastille-active' : '') +
      '" data-action="projet" data-cle="" data-nom="">Sans projet</button>';

    // Sans référentiel, le message explique ET propose l'import sur place (§5.2) : aller
    // le chercher au fond d'un autre onglet ne se devine pas. Il est rendu EN TÊTE de
    // l'écran, sans quoi il tombe sous la ligne de flottaison du téléphone au moment
    // précis où il est utile — au tout premier lancement. Il disparaît dès qu'un
    // référentiel est chargé, et l'écran reprend alors son ordre normal.
    // Écrire reste possible sans projet : on ne bloque jamais la prise de note.
    var avertissement = S.projets.length === 0
      ? '<div class="avertissement">' +
        '<p class="avertissement-texte">Aucun projet chargé : les notes partiront ' +
        '<strong>sans projet</strong>. Charge <code>projets.json</code> pour pouvoir les rattacher — ' +
        'écrire reste possible sans lui.</p>' +
        '<button type="button" class="bouton bouton-fort" data-action="importer-ref">' +
        'Charger projets.json</button>' +
        '</div>'
      : '';

    var corps =
      S.genre === 'ticket' ? formulaireTicket(enEdition)
        : S.genre === 'idee' ? formulaireIdee(enEdition)
          : blocSaisieNote(enEdition);
    var libelleEnregistrer = enEdition
      ? 'Enregistrer les modifications'
      : S.genre === 'ticket' ? 'Enregistrer le ticket'
        : S.genre === 'idee' ? 'Enregistrer l\'idée'
          : 'Enregistrer la note';

    return (
      (S.succes ? '<div class="bandeau-succes" role="status">✓ ' + ech(S.succes) + '</div>' : '') +
      (avertissement === '' ? '' : '<section class="bloc">' + avertissement + '</section>') +
      selecteurGenre() +
      corps +

      '<section class="bloc" id="bloc-projet">' +
      '<h2 class="titre-bloc">Projet</h2>' +
      '<div class="pastilles">' + sansProjet + pastilles + '</div>' +
      '</section>' +

      '<section class="bloc">' +
      '<h2 class="titre-bloc">Date</h2>' +
      '<button type="button" class="bouton bouton-doux bouton-date" data-action="ouvrir-calendrier">' +
      Core.dateFr(S.date) + '</button>' +
      '</section>' +

      '<section class="bloc bloc-action">' +
      '<button type="button" class="bouton bouton-fort" data-action="enregistrer">' +
      libelleEnregistrer + '</button>' +
      (enEdition
        ? '<button type="button" class="bouton bouton-doux" data-action="annuler-edition">Annuler</button>'
        : '') +
      '</section>'
    );
  }

  // -- Écran 2 : la file, l'envoi, les référentiels --
  function ecranFile() {
    var attente = S.notes.filter(function (n) { return !n.envoyee; });
    var envoyees = S.notes.filter(function (n) { return n.envoyee; });

    // `avecCase` : en mode sélection, la carte porte une case « Renvoyer celle-ci ».
    function carte(n, avecCase) {
      var cochee = S.selection && S.selection[n.uuid];
      return (
        '<article class="note' + (n.envoyee ? ' note-figee' : '') + (cochee ? ' note-choisie' : '') + '">' +
        '<div class="note-haut">' +
        '<span class="note-date">' + Core.dateFr(n.date) + '</span>' +
        (n.genre === 'ticket' ? '<span class="badge-genre">Ticket</span>'
          : n.genre === 'idee' ? '<span class="badge-genre badge-idee">Idée</span>' : '') +
        '<span class="note-cible">' + ech(n.cible_nom || 'Sans projet') + '</span>' +
        '</div>' +
        '<p class="note-titre">' + ech(Core.titreNote(n.texte)) + '</p>' +
        (Core.apercuNote(n.texte) ? '<p class="note-apercu">' + ech(Core.apercuNote(n.texte)) + '</p>' : '') +
        (avecCase
          ? '<label class="note-choix"><input type="checkbox" data-action="choisir" data-uuid="' +
            ech(n.uuid) + '"' + (cochee ? ' checked' : '') + '> Renvoyer celle-ci</label>'
          : n.envoyee
            ? '<p class="note-etat">Envoyée le ' + Core.horodatageFr(n.envoye_le) + ' — figée</p>'
            : '<div class="note-actions">' +
              '<button type="button" class="bouton bouton-doux" data-action="editer" data-uuid="' + ech(n.uuid) + '">Modifier</button>' +
              '<button type="button" class="bouton bouton-danger" data-action="supprimer" data-uuid="' + ech(n.uuid) + '">Supprimer</button>' +
              '</div>') +
        '</article>'
      );
    }

    return (
      // Bloc d'envoi, NETTEMENT séparé du bouton d'enregistrement (écran précédent).
      '<section class="bloc bloc-envoi">' +
      '<h2 class="titre-bloc">Envoi vers le PC</h2>' +
      '<p class="explication">Le fichier se télécharge sur le téléphone : dépose-le ensuite dans le ' +
      'dossier Google Drive du Cockpit.</p>' +
      '<button type="button" class="bouton bouton-fort" data-action="envoyer"' +
      (attente.length === 0 ? ' disabled' : '') + '>' +
      (attente.length === 0 ? 'Rien à envoyer' : 'Envoyer ' + attente.length + (attente.length === 1 ? ' note' : ' notes')) +
      '</button>' +
      // Les trois outils de renvoi vivent ENSEMBLE, ici : les chercher au fond d'une autre
      // section ne se devine pas (le renvoi sélectif y était, invisible, tout en bas).
      '<button type="button" class="bouton bouton-doux" data-action="selection-ouvrir"' +
      (S.notes.some(function (n) { return n.envoyee; }) ? '' : ' disabled') +
      '>Choisir des notes à renvoyer</button>' +
      '<button type="button" class="bouton bouton-doux" data-action="tout-renvoyer"' +
      (S.notes.length === 0 ? ' disabled' : '') + '>Tout renvoyer (réparation)</button>' +
      (S.dernierLot
        ? '<p class="indicateur dernier-lot">Dernier fichier : <span class="depot-fichier">' +
          ech(S.dernierLot.nom) + '</span></p>' +
          '<button type="button" class="bouton bouton-doux" data-action="retelecharger">' +
          'Retélécharger ce fichier</button>'
        : '') +
      '</section>' +

      // Les deux sens du transport se suivent : ce qui part, puis ce qui arrive. La file
      // (historique) vient APRÈS — sans quoi, à la première utilisation, l'import se
      // retrouve enterré sous deux listes vides, hors de l'écran.
      '<section class="bloc">' +
      '<h2 class="titre-bloc">Fichiers reçus du PC</h2>' +
      '<p class="indicateur">Projets : ' +
      (S.projetsGenereLe ? 'à jour du ' + Core.horodatageFr(S.projetsGenereLe) : '<strong>jamais reçus</strong>') + '</p>' +
      '<p class="indicateur">Backlogs : ' +
      (S.backlogsGenereLe ? 'à jour du ' + Core.horodatageFr(S.backlogsGenereLe) : '<strong>jamais reçus</strong>') + '</p>' +
      '<button type="button" class="bouton ' +
      (S.projets.length === 0 ? 'bouton-fort' : 'bouton-doux') +
      '" data-action="importer-ref">Charger un fichier du PC</button>' +
      '<p class="explication">Le fichier est reconnu tout seul : <code>projets.json</code> ou ' +
      '<code>backlogs.json</code>.</p>' +
      '</section>' +

      '<section class="bloc">' +
      '<h2 class="titre-bloc">À envoyer' + (attente.length ? ' · ' + attente.length : '') + '</h2>' +
      (attente.length === 0
        ? '<p class="explication">Rien en attente.</p>'
        // `carte(n, false)` EXPLICITE (avenant A7) : `map(carte)` passait l'index du
        // tableau comme drapeau, et la case « Renvoyer celle-ci » poussait sur des notes
        // jamais envoyées à partir de la deuxième.
        : attente.map(function (n) { return carte(n, false); }).join('')) +
      '</section>' +

      '<section class="bloc">' +
      '<h2 class="titre-bloc">Envoyées' + (envoyees.length ? ' · ' + envoyees.length : '') + '</h2>' +
      (envoyees.length === 0
        ? '<p class="explication">Aucune note envoyée pour l\'instant.</p>'
        : blocEnvoyees(envoyees, carte)) +
      '</section>'
    );
  }

  // Combien de notes envoyées sont montrées avant repli. Les autres sont TOUJOURS là —
  // seulement masquées : elles restent dans la base locale et dans « Tout renvoyer ».
  var ENVOYEES_VISIBLES = 20;

  // `carte` est passée en argument : elle est déclarée DANS `ecranFile`, donc invisible ici.
  function blocEnvoyees(envoyees, carte) {
    var enSelection = S.selection !== null;
    // En mode sélection, la liste est DÉPLIÉE : on ne coche bien que ce qu'on voit.
    var replie = !S.toutAfficherEnvoyees && !enSelection && envoyees.length > ENVOYEES_VISIBLES;
    // `listerNotes` trie du plus récent au plus ancien : la tranche montre bien les dernières.
    var montrees = replie ? envoyees.slice(0, ENVOYEES_VISIBLES) : envoyees;
    var nbChoisies = enSelection
      ? envoyees.filter(function (n) { return S.selection[n.uuid]; }).length
      : 0;

    var pied;
    if (enSelection) {
      pied =
        '<div class="barre-selection">' +
        '<button type="button" class="bouton bouton-fort" data-action="renvoyer-selection"' +
        (nbChoisies === 0 ? ' disabled' : '') + '>' +
        (nbChoisies === 0 ? 'Coche des notes' : 'Renvoyer ' + nbChoisies + (nbChoisies === 1 ? ' note' : ' notes')) +
        '</button>' +
        '<button type="button" class="bouton bouton-doux" data-action="selection-tout">' +
        (nbChoisies === envoyees.length ? 'Tout décocher' : 'Tout cocher (' + envoyees.length + ')') +
        '</button>' +
        '<button type="button" class="bouton bouton-doux" data-action="selection-fermer">Annuler</button>' +
        '</div>';
    } else if (envoyees.length > ENVOYEES_VISIBLES) {
      pied =
        '<button type="button" class="bouton bouton-doux" data-action="bascule-envoyees">' +
        (replie
          ? 'Tout afficher (' + envoyees.length + ')'
          : 'Ne montrer que les ' + ENVOYEES_VISIBLES + ' dernières') +
        '</button>';
    } else {
      pied = '';
    }

    return (
      (enSelection
        ? '<p class="explication">Coche les notes à renvoyer au PC. Elles ne seront ni modifiées ' +
          'ni dupliquées : le PC reconnaît celles qu\'il a déjà.</p>'
        : '') +
      (replie
        ? '<p class="explication">Les ' + ENVOYEES_VISIBLES + ' plus récentes. Les ' +
          (envoyees.length - ENVOYEES_VISIBLES) + ' autres sont conservées — rien n\'est jamais ' +
          'supprimé du téléphone.</p>'
        : '') +
      (!enSelection && envoyees.length > 0
        ? '<button type="button" class="bouton bouton-doux" data-action="selection-ouvrir">' +
          'Choisir des notes à renvoyer</button>'
        : '') +
      montrees
        .map(function (n) { return carte(n, enSelection); })
        .join('') +
      pied
    );
  }

  // -- Écran 3 : les backlogs, en lecture seule --
  function ecranBacklogs() {
    var bandeau =
      '<div class="bandeau-fraicheur">' +
      '<p class="bandeau-titre">Rafraîchis pour voir l\'état à jour</p>' +
      '<p class="bandeau-detail">' +
      (S.backlogsGenereLe
        ? 'dernier instantané du ' + Core.horodatageFr(S.backlogsGenereLe)
        : 'aucun instantané reçu') +
      '</p>' +
      '<button type="button" class="bouton bouton-fort" data-action="importer-ref">Rafraîchir</button>' +
      '</div>';

    if (S.backlogs.length === 0) {
      return (
        bandeau +
        '<section class="bloc">' +
        '<p class="explication">Aucun instantané des backlogs n\'a encore été reçu. Sur le PC, ' +
        'ouvre les Réglages du Cockpit, section « Notes du téléphone », et clique « Pousser ' +
        'maintenant » : le fichier <code>backlogs.json</code> apparaît dans le dossier Drive. ' +
        'Charge-le ici avec le bouton Rafraîchir.</p>' +
        '</section>'
      );
    }

    if (S.backlogProjet === null) {
      return (
        bandeau +
        '<section class="bloc">' +
        '<h2 class="titre-bloc">Projets</h2>' +
        S.backlogs
          .map(function (p) {
            var nb = (p.colonnes || []).reduce(function (t, c) { return t + (c.tickets || []).length; }, 0);
            return (
              '<button type="button" class="ligne-projet" data-action="backlog-projet" data-cle="' +
              ech(p.cle) + '" style="--teinte:' + ech(p.couleur || '#8A8F94') + '">' +
              '<span class="ligne-projet-nom">' + ech(p.nom) + '</span>' +
              '<span class="ligne-projet-compte">' + nb + '</span>' +
              '</button>'
            );
          })
          .join('') +
        '</section>'
      );
    }

    var projet = S.backlogs.filter(function (p) { return p.cle === S.backlogProjet; })[0];
    if (!projet) {
      S.backlogProjet = null;
      return ecranBacklogs();
    }
    return (
      bandeau +
      '<section class="bloc">' +
      '<button type="button" class="bouton bouton-doux" data-action="backlog-retour">← Tous les projets</button>' +
      '<h2 class="titre-bloc titre-projet" style="--teinte:' + ech(projet.couleur || '#8A8F94') + '">' +
      ech(projet.nom) + '</h2>' +
      (projet.colonnes || [])
        .map(function (colonne, index) {
          var ouverte = S.colonneOuverte === index;
          // **Colonne RDV : miroir GLOBAL.** Comme au Cockpit, elle montre les RDV de TOUS
          // les projets, pas seulement ceux du projet ouvert. On retombe sur la colonne
          // propre au projet si l'instantané est plus ancien que ce champ.
          var globale = colonne.systeme === true && S.backlogsRdv.length > 0;
          var tickets = globale ? S.backlogsRdv : colonne.tickets || [];
          return (
            '<div class="colonne">' +
            '<button type="button" class="colonne-entete" data-action="backlog-colonne" data-index="' + index + '"' +
            ' style="--teinte:' + ech(colonne.couleur || '#8A8F94') + '">' +
            '<span class="colonne-nom">' + ech(colonne.libelle) +
            (globale ? ' <span class="colonne-portee">tous projets</span>' : '') + '</span>' +
            '<span class="colonne-compte">' + tickets.length + '</span>' +
            '<span class="colonne-fleche">' + (ouverte ? '▾' : '▸') + '</span>' +
            '</button>' +
            (ouverte
              ? '<div class="colonne-tickets">' +
                (tickets.length === 0
                  ? '<p class="explication">Colonne vide.</p>'
                  : tickets
                      .map(function (t, i) {
                        var etranger = globale && t.projet && t.projet.cle !== projet.cle;
                        return (
                          '<button type="button" class="ticket' +
                          (etranger ? ' ticket-etranger' : '') +
                          (t.honore ? ' ticket-honore' : '') +
                          '" data-action="backlog-ticket"' +
                          ' data-colonne="' + index + '" data-index="' + i + '"' +
                          (globale ? ' data-global="1"' : '') +
                          (etranger ? ' style="--teinte:' + ech(t.projet.couleur || '#8A8F94') + '"' : '') +
                          '>' +
                          '<span class="ticket-titre">' + ech(t.titre) + '</span>' +
                          '<span class="ticket-bas">' +
                          (etranger
                            ? '<span class="ticket-projet">' + ech(t.projet.nom) + '</span>'
                            : '') +
                          (t.honore ? '<span class="ticket-fait">✓ fait</span>' : '') +
                          (t.prioritaire_home ? '<span class="marque-prioritaire">Prioritaire Home</span>' : '') +
                          (t.date_valeur ? '<span class="ticket-date">' + ech(dateTicket(t)) + '</span>' : '') +
                          '</span>' +
                          '</button>'
                        );
                      })
                      .join('')) +
                '</div>'
              : '') +
            '</div>'
          );
        })
        .join('') +
      '</section>'
    );
  }

  function dateTicket(t) {
    if (!t.date_valeur) return '';
    var jour = Core.dateFr(t.date_valeur.slice(0, 10));
    var heure = t.date_valeur.length >= 16 ? ' à ' + t.date_valeur.slice(11, 16) : '';
    return (t.date_nature === 'rdv' ? 'RDV ' : '') + jour + heure;
  }

  function libelleMaturite(m) {
    return m === 'creuser' ? 'à creuser' : m === 'mure' ? 'mûre' : 'brut';
  }

  // -- Écran 4 : le Tableau à idées, en lecture seule (SPEC notes typées §4.5) --
  // Même patron que les backlogs : projets → catégories → cartes, même instantané
  // (`backlogs.json`), même date, même avertissement de fraîcheur (D16 de la spec
  // d'origine), même bouton Rafraîchir.
  function ecranIdees() {
    var bandeau =
      '<div class="bandeau-fraicheur">' +
      '<p class="bandeau-titre">Rafraîchis pour voir l\'état à jour</p>' +
      '<p class="bandeau-detail">' +
      (S.backlogsGenereLe
        ? 'dernier instantané du ' + Core.horodatageFr(S.backlogsGenereLe)
        : 'aucun instantané reçu') +
      '</p>' +
      '<button type="button" class="bouton bouton-fort" data-action="importer-ref">Rafraîchir</button>' +
      '</div>';

    if (S.backlogs.length === 0) {
      return (
        bandeau +
        '<section class="bloc">' +
        '<p class="explication">Aucun instantané n\'a encore été reçu. Sur le PC, ouvre les ' +
        'Réglages du Cockpit, section « Notes du téléphone », et clique « Pousser ' +
        'maintenant » : le fichier <code>backlogs.json</code> apparaît dans le dossier Drive. ' +
        'Charge-le ici avec le bouton Rafraîchir.</p>' +
        '</section>'
      );
    }

    // Instantané d'AVANT la tranche : les idées n'y sont pas (§4.6).
    var enrichi = S.backlogs.some(function (p) { return Array.isArray(p.categories); });
    if (!enrichi) {
      return (
        bandeau +
        '<section class="bloc">' +
        '<p class="explication">Cet instantané date d\'avant les idées. Sur le PC : ' +
        '« Pousser maintenant », puis recharge <code>backlogs.json</code> ici.</p>' +
        '</section>'
      );
    }

    if (S.ideeProjet === null) {
      return (
        bandeau +
        '<section class="bloc">' +
        '<h2 class="titre-bloc">Projets</h2>' +
        S.backlogs
          .map(function (p) {
            var categories = Core.categoriesDe(p) || [];
            var nb = categories.reduce(function (t, c) { return t + (c.idees || []).length; }, 0);
            return (
              '<button type="button" class="ligne-projet" data-action="idees-projet" data-cle="' +
              ech(p.cle) + '" style="--teinte:' + ech(p.couleur || '#8A8F94') + '">' +
              '<span class="ligne-projet-nom">' + ech(p.nom) + '</span>' +
              '<span class="ligne-projet-compte">' + nb + '</span>' +
              '</button>'
            );
          })
          .join('') +
        '</section>'
      );
    }

    var projet = S.backlogs.filter(function (p) { return p.cle === S.ideeProjet; })[0];
    if (!projet) {
      S.ideeProjet = null;
      return ecranIdees();
    }
    var categories = Core.categoriesDe(projet) || [];
    return (
      bandeau +
      '<section class="bloc">' +
      '<button type="button" class="bouton bouton-doux" data-action="idees-retour">← Tous les projets</button>' +
      '<h2 class="titre-bloc titre-projet" style="--teinte:' + ech(projet.couleur || '#8A8F94') + '">' +
      ech(projet.nom) + '</h2>' +
      (categories.length === 0
        ? '<p class="explication">Ce projet n\'a pas encore de catégorie d\'idées.</p>'
        : categories
            .map(function (categorie, index) {
              var ouverte = S.categorieOuverte === index;
              var idees = categorie.idees || [];
              return (
                '<div class="colonne">' +
                '<button type="button" class="colonne-entete" data-action="idees-categorie" data-index="' + index + '"' +
                ' style="--teinte:' + ech(categorie.couleur || '#8A8F94') + '">' +
                '<span class="colonne-nom">' + ech(categorie.libelle) +
                (categorie.famille ? ' <span class="colonne-portee">' + ech(categorie.famille) + '</span>' : '') +
                '</span>' +
                '<span class="colonne-compte">' + idees.length + '</span>' +
                '<span class="colonne-fleche">' + (ouverte ? '▾' : '▸') + '</span>' +
                '</button>' +
                (ouverte
                  ? '<div class="colonne-tickets">' +
                    (idees.length === 0
                      ? '<p class="explication">Catégorie vide.</p>'
                      : idees
                          .map(function (idee, i) {
                            return (
                              '<button type="button" class="ticket" data-action="idees-carte"' +
                              ' data-categorie="' + index + '" data-index="' + i + '">' +
                              '<span class="ticket-titre">' +
                              (idee.coup_de_coeur ? '<span class="idee-coeur">★</span> ' : '') +
                              ech(idee.titre) + '</span>' +
                              '<span class="ticket-bas">' +
                              '<span class="idee-maturite idee-maturite-' + ech(idee.maturite || 'brut') + '">' +
                              libelleMaturite(idee.maturite) + '</span>' +
                              '</span>' +
                              '</button>'
                            );
                          })
                          .join('')) +
                    '</div>'
                  : '') +
                '</div>'
              );
            })
            .join('')) +
      '</section>'
    );
  }

  // -- Calques : calendrier, confirmation, détail d'un ticket, message --
  function calques() {
    var sortie = '';

    if (S.calendrier) {
      var cases = Core.grilleMois(S.calendrier.annee, S.calendrier.mois);
      // Le calendrier sert deux champs : la date de saisie de la note, ou l'échéance /
      // le jour du rendez-vous de la fiche Ticket (SPEC notes typées §4.2).
      var choisie = S.calendrier.cible === 'fiche' ? S.fiche.date_valeur : S.date;
      sortie +=
        '<div class="calque" data-action="cal-fermer">' +
        '<div class="feuille" data-stop="1">' +
        '<div class="cal-entete">' +
        '<button type="button" class="cal-fleche" data-action="cal-mois" data-delta="-1">‹</button>' +
        '<span class="cal-titre">' + Core.nomMois(S.calendrier.mois) + ' ' + S.calendrier.annee + '</span>' +
        '<button type="button" class="cal-fleche" data-action="cal-mois" data-delta="1">›</button>' +
        '</div>' +
        '<div class="cal-jours">' +
        ['L', 'M', 'M', 'J', 'V', 'S', 'D'].map(function (j) { return '<span class="cal-jour-nom">' + j + '</span>'; }).join('') +
        cases
          .map(function (c) {
            return (
              '<button type="button" class="cal-case' + (c.horsMois ? ' cal-hors' : '') +
              (c.iso === choisie ? ' cal-choisie' : '') + '" data-action="cal-jour" data-iso="' + c.iso + '">' +
              c.jour + '</button>'
            );
          })
          .join('') +
        '</div>' +
        '<button type="button" class="bouton bouton-doux" data-action="cal-fermer">Fermer</button>' +
        '</div></div>';
    }

    if (S.ticket) {
      sortie +=
        '<div class="calque" data-action="fermer-ticket">' +
        '<div class="feuille" data-stop="1">' +
        '<p class="ticket-colonne">' + ech(S.ticket.colonne) +
        (S.ticket.projet ? ' · ' + ech(S.ticket.projet.nom) : '') + '</p>' +
        '<h3 class="ticket-detail-titre">' + ech(S.ticket.titre) + '</h3>' +
        (S.ticket.honore ? '<p class="ticket-fait">✓ déjà fait</p>' : '') +
        (S.ticket.date_valeur ? '<p class="ticket-detail-date">' + ech(dateTicket(S.ticket)) + '</p>' : '') +
        (S.ticket.prioritaire_home ? '<p class="marque-prioritaire">Prioritaire Home</p>' : '') +
        (S.ticket.description
          ? '<p class="ticket-detail-description">' + ech(S.ticket.description) + '</p>'
          : '<p class="explication">Pas de description.</p>') +
        '<p class="explication">Lecture seule : le téléphone ne modifie jamais un backlog.</p>' +
        '<button type="button" class="bouton bouton-doux" data-action="fermer-ticket">Fermer</button>' +
        '</div></div>';
    }

    // Détail d'une idée (§4.5) — même feuille que le détail d'un ticket, lecture seule.
    if (S.idee) {
      sortie +=
        '<div class="calque" data-action="fermer-idee">' +
        '<div class="feuille" data-stop="1">' +
        '<p class="ticket-colonne">' + ech(S.idee.categorie) +
        (S.idee.famille ? ' · ' + ech(S.idee.famille) : '') + '</p>' +
        '<h3 class="ticket-detail-titre">' +
        (S.idee.coup_de_coeur ? '<span class="idee-coeur">★</span> ' : '') +
        ech(S.idee.titre) + '</h3>' +
        '<p class="idee-maturite idee-maturite-' + ech(S.idee.maturite || 'brut') + '">' +
        'Maturité : ' + libelleMaturite(S.idee.maturite) + '</p>' +
        (S.idee.description
          ? '<p class="ticket-detail-description">' + ech(S.idee.description) + '</p>'
          : '<p class="explication">Pas de description.</p>') +
        '<p class="explication">Lecture seule : le téléphone ne modifie jamais le Tableau à idées.</p>' +
        '<button type="button" class="bouton bouton-doux" data-action="fermer-idee">Fermer</button>' +
        '</div></div>';
    }

    // Accompagnement du dépôt (§5.4 : « affiche le rappel de le déposer dans le dossier
    // Drive »). Le transport est MANUEL : un message fugace ne suffit pas, ce panneau
    // reste jusqu'à ce que Julien le ferme, et il rappelle le nom exact du fichier.
    if (S.depot) {
      sortie +=
        '<div class="calque">' +
        '<div class="feuille" data-stop="1">' +
        '<h3 class="feuille-titre">' +
        S.depot.nb + (S.depot.nb === 1 ? ' note envoyée' : ' notes envoyées') +
        '</h3>' +
        '<p class="explication">Le fichier est dans tes <strong>Téléchargements</strong> :</p>' +
        '<p class="depot-fichier">' + ech(S.depot.nom) + '</p>' +
        '<ol class="depot-etapes">' +
        '<li>Ouvre l\'application <strong>Google Drive</strong>.</li>' +
        '<li>Va dans le <strong>dossier de synchronisation du Cockpit</strong>.</li>' +
        '<li>Bouton <strong>+</strong>, puis <strong>Importer</strong>.</li>' +
        '<li>Choisis ce fichier dans tes <strong>Téléchargements</strong>.</li>' +
        '<li>Sur le PC, en bas de l\'Accueil : <strong>Synchroniser</strong>, puis ' +
        '<strong>Tout importer</strong>.</li>' +
        '</ol>' +
        '<button type="button" class="bouton bouton-fort" data-action="depot-fait">C\'est déposé</button>' +
        '<button type="button" class="bouton bouton-doux" data-action="retelecharger">Retélécharger le fichier</button>' +
        '</div></div>';
    }

    // La confirmation est ajoutée EN DERNIER : elle passe donc devant tout autre calque.
    if (S.confirmation) {
      sortie +=
        '<div class="calque calque-devant">' +
        '<div class="feuille" data-stop="1">' +
        '<h3 class="feuille-titre">' + ech(S.confirmation.titre) + '</h3>' +
        '<p class="explication">' + ech(S.confirmation.texte) + '</p>' +
        '<button type="button" class="bouton bouton-fort" data-action="confirmer">' +
        ech(S.confirmation.libelle) + '</button>' +
        '<button type="button" class="bouton bouton-doux" data-action="annuler-confirmation">Annuler</button>' +
        '</div></div>';
    }

    if (S.message) {
      sortie += '<div class="message message-' + S.tonMessage + '">' + ech(S.message) + '</div>';
    }
    return sortie;
  }

  // Bandeau du projet courant (avenant A1) : collé sous les onglets, sur TOUS les écrans —
  // on sait toujours pour qui on écrit. Un appui ramène au choix du projet.
  function bandeauProjet() {
    var teinte = null;
    if (S.cible) {
      var projet = S.projets.filter(function (p) { return p.cle === S.cible; })[0];
      teinte = (projet && projet.couleur) || '#8A8F94';
    }
    return (
      '<button type="button" class="bandeau-projet' + (S.cible ? '' : ' bandeau-projet-sans') +
      '" data-action="aller-projet"' +
      (teinte ? ' style="--teinte:' + ech(teinte) + '"' : '') + '>' +
      '<span class="bandeau-projet-libelle">Projet</span>' +
      (S.cible
        ? '<span class="bandeau-projet-point" aria-hidden="true"></span><span class="bandeau-projet-nom">' + ech(S.cibleNom) + '</span>'
        : '<span class="bandeau-projet-nom">Sans projet</span>') +
      '</button>'
    );
  }

  function render() {
    var corps =
      S.ecran === 'note' ? ecranNote()
        : S.ecran === 'file' ? ecranFile()
          : S.ecran === 'idees' ? ecranIdees()
            : ecranBacklogs();
    // La position de défilement survit au re-rendu (avenant A2) : sans cela, la fermeture
    // du clavier ou un contenu un instant plus court faisait remonter la page au premier
    // appui sur « Enregistrer » ou « + Ajouter un lien ». Les remontées volontaires
    // (changement d'onglet) appellent scrollTo APRÈS render, elles gardent le dernier mot.
    var defilement = window.scrollY;
    racine().innerHTML =
      entete() +
      '<div class="colle">' + onglets() + bandeauProjet() + '</div>' +
      '<main class="contenu">' + corps + '</main>' + calques();
    window.scrollTo(0, defilement);
  }

  // ---- Actions ---------------------------------------------------------------

  function champSaisie() {
    return document.getElementById('saisie');
  }

  function lireSaisie() {
    var champ = champSaisie();
    if (champ) S.texte = champ.value;
  }

  function enregistrer() {
    lireSaisie();
    if (S.genre === 'ticket' || S.genre === 'idee') {
      enregistrerTypee();
      return;
    }
    if (Core.noteVide(S.texte)) {
      signalerErreur('Note vide : écris quelque chose avant d\'enregistrer.');
      return;
    }
    if (!Core.dateValide(S.date)) {
      signalerErreur('Date invalide.');
      return;
    }
    Store.demanderPersistance();
    if (S.edition) {
      Store.modifierNote(S.edition, {
        texte: S.texte,
        date: S.date,
        cible: S.cible,
        cible_nom: S.cibleNom,
        // Une note typée re-enregistrée en note libre le redevient VRAIMENT (§4.4).
        genre: 'note',
        charge: null,
      })
        .then(function () {
          S.edition = null;
          remiseAZero();
          poserSucces('Note modifiée — elle est dans la File.');
          return charger();
        })
        .catch(function (e) { signalerErreur(String(e.message || e)); });
      return;
    }
    Store.prochaineSeq()
      .then(function (seq) {
        return Store.ajouterNote({
          uuid: Core.uuid(),
          texte: S.texte,
          date: S.date,
          cible: S.cible,
          cible_nom: S.cibleNom,
          cree_le: Core.horodatage(),
          seq: seq,
        });
      })
      .then(function () {
        remiseAZero();
        poserSucces('Note enregistrée — dans la File, prête à envoyer.');
        demanderNotification();
        return charger();
      })
      .catch(function (e) { signalerErreur(String(e.message || e)); });
  }

  // Enregistre un ticket ou une idée (SPEC notes typées §4.2-§4.3) : validation aux
  // invariants du Cockpit, charge conforme au contrat, texte APLATI (D13). Un ticket ou
  // une idée exige un projet (D1) — le garde-fou est revérifié ici, pas seulement grisé.
  function enregistrerTypee() {
    if (!S.cible) {
      signalerErreur('Choisis un projet : un ' + (S.genre === 'ticket' ? 'ticket' : 'idée') +
        ' vise toujours un projet.');
      return;
    }
    var erreur = S.genre === 'ticket'
      ? Core.validerFicheTicket(S.fiche)
      : Core.validerFicheIdee(S.fiche);
    if (erreur) {
      signalerErreur(erreur);
      return;
    }
    if (!Core.dateValide(S.date)) {
      signalerErreur('Date invalide.');
      return;
    }
    var genre = S.genre;
    var charge = genre === 'ticket' ? Core.chargeTicket(S.fiche) : Core.chargeIdee(S.fiche);
    var texte = Core.texteDe(S.fiche);
    var fait = genre === 'ticket' ? 'Ticket' : 'Idée';
    Store.demanderPersistance();
    if (S.edition) {
      Store.modifierNote(S.edition, {
        texte: texte,
        date: S.date,
        cible: S.cible,
        cible_nom: S.cibleNom,
        genre: genre,
        charge: charge,
      })
        .then(function () {
          S.edition = null;
          remiseAZero();
          poserSucces(fait + (genre === 'idee' ? ' modifiée' : ' modifié') + ' — dans la File.');
          return charger();
        })
        .catch(function (e) { signalerErreur(String(e.message || e)); });
      return;
    }
    Store.prochaineSeq()
      .then(function (seq) {
        return Store.ajouterNote({
          uuid: Core.uuid(),
          texte: texte,
          date: S.date,
          cible: S.cible,
          cible_nom: S.cibleNom,
          cree_le: Core.horodatage(),
          seq: seq,
          genre: genre,
          charge: charge,
        });
      })
      .then(function () {
        remiseAZero();
        poserSucces(
          fait + (genre === 'idee' ? ' enregistrée' : ' enregistré') +
          ' — dans la File, prêt' + (genre === 'idee' ? 'e' : '') + ' à envoyer.',
        );
        demanderNotification();
        return charger();
      })
      .catch(function (e) { signalerErreur(String(e.message || e)); });
  }

  // Après un enregistrement : le texte et la fiche repartent à vide, la date à aujourd'hui,
  // le sélecteur REVIENT à « Note » (D5) — et le PROJET est conservé (on note souvent
  // plusieurs choses de suite sur le même sujet).
  function remiseAZero() {
    S.texte = '';
    S.date = Core.dateISO();
    S.genre = 'note';
    S.fiche = Core.ficheVierge();
  }

  // Notification locale « X notes à envoyer » (avenant A8). Sans serveur — doctrine : le
  // téléphone ne parle à personne —, elle ne peut PAS naître application fermée : elle se
  // pose et se met à jour quand l'application est OUVERTE, et une fois posée elle RESTE
  // dans la barre du téléphone jusqu'à ce que la file soit vidée. Silencieuse, une seule
  // (même `tag`), fermée d'elle-même à l'envoi.
  function mettreAJourNotificationEnvoi() {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) return;
    if (Notification.permission !== 'granted') return;
    navigator.serviceWorker
      .getRegistration()
      .then(function (enregistrement) {
        if (!enregistrement || typeof enregistrement.showNotification !== 'function') return;
        var nb = nbEnAttente();
        if (nb === 0) {
          enregistrement.getNotifications({ tag: 'cockpit-notes-a-envoyer' }).then(function (posees) {
            posees.forEach(function (n) { n.close(); });
          });
          return;
        }
        enregistrement.showNotification('Notes Cockpit', {
          body: nb === 1
            ? "1 note attend d'être envoyée au PC."
            : nb + " notes attendent d'être envoyées au PC.",
          tag: 'cockpit-notes-a-envoyer',
          icon: './icon.svg',
          badge: './icon.svg',
          silent: true,
        });
      })
      .catch(function () {});
  }

  // La permission se demande sur un GESTE — le premier enregistrement —, jamais à
  // l'ouverture. Refusée : plus jamais redemandée (le navigateur s'en charge), et tout
  // le reste fonctionne sans elle.
  function demanderNotification() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
      Notification.requestPermission().then(mettreAJourNotificationEnvoi).catch(function () {});
    }
  }

  // Renvoie `true` si le téléchargement a pu être déclenché. **À appeler SYNCHRONEMENT
  // dans le geste de l'utilisateur** : Android Chrome bloque, sans un mot, un
  // téléchargement lancé depuis une suite asynchrone (le geste n'est plus « actif »).
  function telecharger(nom, contenu) {
    try {
      var blob = new Blob([contenu], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var lien = document.createElement('a');
      lien.href = url;
      lien.download = nom;
      lien.rel = 'noopener';
      document.body.appendChild(lien);
      lien.click();
      lien.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Fabrique le lot **avant** d'ouvrir la confirmation. Au moment du « Confirmer », il ne
  // reste plus qu'à télécharger — synchroniquement, dans le geste. C'est ce qui manquait :
  // le lot se construisait après deux lectures d'IndexedDB, et le téléchargement partait
  // trop tard pour que le navigateur l'autorise encore.
  function preparerEnvoi(portee) {
    (portee === 'tout' ? Store.tout() : Store.enAttente())
      .then(function (notes) {
        if (notes.length === 0) {
          signaler('Rien à envoyer.');
          return;
        }
        var maintenant = new Date();
        var lotUuid = Core.uuid();
        var lot = Core.buildLot(notes, lotUuid, Core.horodatage(maintenant));
        S.lotPret = {
          nom: Core.lotFilename(lotUuid, maintenant),
          json: Core.lotJson(lot),
          uuid: lotUuid,
          uuids: notes.map(function (n) { return n.uuid; }),
          envoye_le: Core.horodatage(maintenant),
          nb: notes.length,
        };
        S.confirmation = {
          titre: portee === 'tout' ? 'Tout renvoyer ?' : 'Envoyer vers le PC ?',
          texte:
            portee === 'tout'
              ? 'Toutes les notes, envoyées comprises (' + notes.length + '), repartiront dans un ' +
                "seul fichier. C'est l'outil de réparation après une restauration de sauvegarde du " +
                'PC : le PC ne créera jamais de doublon.'
              : notes.length + (notes.length === 1 ? ' note va être mise' : ' notes vont être mises') +
                ' dans un fichier à déposer dans le dossier Google Drive. Une fois envoyées, elles ' +
                'seront figées.',
          libelle: portee === 'tout' ? 'Tout renvoyer' : 'Envoyer',
          action: envoyerMaintenant,
        };
        render();
      })
      .catch(function (e) { signaler(String(e.message || e)); });
  }

  // Le geste : télécharger d'abord, marquer ensuite. **On ne marque JAMAIS une note comme
  // envoyée si le fichier n'est pas parti** — sinon elle serait figée sans exister nulle part.
  function envoyerMaintenant() {
    var pret = S.lotPret;
    S.lotPret = null;
    if (!pret) return;
    if (!telecharger(pret.nom, pret.json)) {
      signalerErreur("Le téléchargement n'a pas démarré. Rien n'a été marqué comme envoyé — réessaie.");
      return;
    }
    S.dernierLot = { nom: pret.nom, json: pret.json, envoye_le: pret.envoye_le, nb: pret.nb };
    Store.enregistrerDernierLot(S.dernierLot).catch(function () {});
    Store.marquerEnvoyees(pret.uuids, pret.uuid, pret.envoye_le)
      .then(charger)
      .then(function () {
        S.depot = { nom: pret.nom, nb: pret.nb };
        render();
      })
      .catch(function (e) { signalerErreur(String(e.message || e)); });
  }

  function chargerFichierReferentiel(fichier) {
    var lecteur = new FileReader();
    lecteur.onload = function () {
      var texte = String(lecteur.result);
      var resultat = Core.parseReferentiel(texte);
      if (!resultat.ok) {
        signalerErreur(resultat.erreur);
        return;
      }
      var nom = resultat.genre === 'projets' ? 'Projets' : 'Backlogs';
      var actuel = resultat.genre === 'projets' ? S.projetsGenereLe : S.backlogsGenereLe;

      var appliquer = function () {
        Store.enregistrerReferentiel(resultat.genre, texte)
          .then(charger)
          .then(function () {
            signalerSucces(nom + ' mis à jour — instantané du ' + Core.horodatageFr(resultat.genere_le) + '.');
          })
          .catch(function (e) { signalerErreur(String(e.message || e)); });
      };

      // **Garde-fou du transport.** Google Drive sert parfois, sur le téléphone, une copie
      // en CACHE du fichier : on rechargeait alors un instantané plus ancien que celui déjà
      // en place, silencieusement, et l'écran semblait « ne pas se mettre à jour ». Les
      // horodatages `AAAA-MM-JJ HH:MM:SS` se comparent directement comme des chaînes.
      if (actuel && resultat.genere_le < actuel) {
        S.confirmation = {
          titre: 'Ce fichier est plus ANCIEN',
          texte:
            'Le fichier choisi date du ' + Core.horodatageFr(resultat.genere_le) +
            ', alors que tu as déjà chargé celui du ' + Core.horodatageFr(actuel) + '. ' +
            "Google Drive t'a probablement donné une copie en cache : ouvre-le dans " +
            "l'application Drive, télécharge-le, puis reprends-le dans Téléchargements.",
          libelle: 'Charger quand même',
          action: appliquer,
        };
        render();
        return;
      }
      if (actuel && resultat.genere_le === actuel) {
        signaler(
          nom + ' : ce fichier est IDENTIQUE à celui déjà chargé (' +
          Core.horodatageFr(actuel) + '). Drive t\'a redonné la même copie — rien n\'a changé.',
        );
        return;
      }
      appliquer();
    };
    lecteur.onerror = function () { signalerErreur('Lecture du fichier impossible.'); };
    lecteur.readAsText(fichier);
  }

  // ---- Chargement de l'état ---------------------------------------------------

  function charger() {
    return Promise.all([
      Store.listerNotes(),
      Store.lireReferentiel('projets'),
      Store.lireReferentiel('backlogs'),
      Store.lireDernierLot(),
    ]).then(function (r) {
      S.notes = r[0];
      if (r[3]) S.dernierLot = r[3];
      var projets = r[1] ? Core.parseReferentiel(r[1]) : null;
      if (projets && projets.ok) {
        S.projets = projets.projets;
        S.projetsGenereLe = projets.genere_le;
      }
      var backlogs = r[2] ? Core.parseReferentiel(r[2]) : null;
      if (backlogs && backlogs.ok) {
        S.backlogs = backlogs.projets;
        S.backlogsGenereLe = backlogs.genere_le;
        S.backlogsRdv = backlogs.rdv;
      }
      // Une cible qui a disparu du référentiel repasse « Sans projet » : le téléphone ne
      // propose jamais une cible qu'il ne connaît plus.
      if (S.cible && !S.projets.some(function (p) { return p.cle === S.cible; })) {
        S.cible = null;
        S.cibleNom = '';
      }
      // Un genre devenu impossible (référentiel rechargé) retombe sur la note libre.
      assainirGenre();
      render();
      // La notification « X à envoyer » suit l'état réel de la file (avenant A8).
      mettreAJourNotificationEnvoi();
    });
  }

  // ---- Délégation d'événements (posée une seule fois) -------------------------

  function surClic(evenement) {
    var el = evenement.target.closest('[data-action]');
    if (!el) return;
    // Un clic DANS la feuille ne ferme pas le calque qui la porte (seul le fond ferme).
    if (el.classList.contains('calque') && evenement.target.closest('.feuille')) return;
    var action = el.dataset.action;

    // Le bandeau de succès s'efface au premier geste qui suit (avenant A3) — il a dit ce
    // qu'il avait à dire.
    if (S.succes && action !== 'aller-projet') {
      S.succes = null;
    }

    if (action === 'onglet') {
      lireSaisie();
      S.ecran = el.dataset.cible;
      render();
      window.scrollTo(0, 0);
    } else if (action === 'aller-projet') {
      // Le bandeau collant ramène au choix du projet (avenant A1).
      lireSaisie();
      S.ecran = 'note';
      render();
      var blocProjet = document.getElementById('bloc-projet');
      if (blocProjet) blocProjet.scrollIntoView({ block: 'center' });
    } else if (action === 'separateur') {
      var champ = champSaisie();
      if (!champ) return;
      var resultat = Core.insererSeparateur(champ.value, champ.selectionStart);
      champ.value = resultat.texte;
      S.texte = resultat.texte;
      champ.focus();
      champ.setSelectionRange(resultat.curseur, resultat.curseur);
    } else if (action === 'projet') {
      lireSaisie();
      S.cible = el.dataset.cle || null;
      S.cibleNom = el.dataset.nom || '';
      // Les cibles de la fiche appartiennent au projet : en changer remet colonne et
      // catégorie à choisir (titre, description, liens et options sont conservés).
      S.fiche.colonne_id = null;
      S.fiche.colonne_libelle = '';
      S.fiche.categorie_id = null;
      S.fiche.categorie_libelle = '';
      assainirGenre();
      render();
    } else if (action === 'genre') {
      lireSaisie();
      S.genre = el.dataset.cle;
      render();
    } else if (action === 'ouvrir-calendrier') {
      lireSaisie();
      var base = Core.dateValide(S.date) ? S.date : Core.dateISO();
      S.calendrier = { annee: Number(base.slice(0, 4)), mois: Number(base.slice(5, 7)) - 1, cible: 'note' };
      render();
    } else if (action === 'ouvrir-calendrier-fiche') {
      var baseFiche = Core.dateValide(S.fiche.date_valeur) ? S.fiche.date_valeur : Core.dateISO();
      S.calendrier = {
        annee: Number(baseFiche.slice(0, 4)),
        mois: Number(baseFiche.slice(5, 7)) - 1,
        cible: 'fiche',
      };
      render();
    } else if (action === 'cal-mois') {
      var delta = Number(el.dataset.delta);
      var d = new Date(S.calendrier.annee, S.calendrier.mois + delta, 1);
      S.calendrier = { annee: d.getFullYear(), mois: d.getMonth(), cible: S.calendrier.cible };
      render();
    } else if (action === 'cal-jour') {
      if (S.calendrier && S.calendrier.cible === 'fiche') {
        S.fiche.date_valeur = el.dataset.iso;
      } else {
        S.date = el.dataset.iso;
      }
      S.calendrier = null;
      render();
    } else if (action === 'cal-fermer') {
      S.calendrier = null;
      render();
    } else if (action === 'fiche-colonne') {
      S.fiche.rdv = false;
      S.fiche.colonne_id = Number(el.dataset.id);
      S.fiche.colonne_libelle = el.dataset.libelle || '';
      // L'heure n'a de sens que pour un rendez-vous ; l'échéance éventuelle reste.
      S.fiche.heure = '';
      render();
    } else if (action === 'fiche-rdv') {
      S.fiche.rdv = true;
      S.fiche.colonne_id = null;
      S.fiche.colonne_libelle = '';
      render();
    } else if (action === 'fiche-sans-echeance') {
      S.fiche.date_valeur = '';
      render();
    } else if (action === 'fiche-rappel') {
      S.fiche.rappel_home = el.checked === true;
      render();
    } else if (action === 'fiche-position') {
      S.fiche.position = el.dataset.cle === 'haut' ? 'haut' : 'bas';
      render();
    } else if (action === 'fiche-categorie') {
      S.fiche.categorie_id = Number(el.dataset.id);
      S.fiche.categorie_libelle = el.dataset.libelle || '';
      render();
    } else if (action === 'fiche-maturite') {
      S.fiche.maturite = el.dataset.cle;
      render();
    } else if (action === 'fiche-coeur') {
      S.fiche.coup_de_coeur = el.checked === true;
      render();
    } else if (action === 'fiche-ajouter-lien') {
      S.fiche.liens.push({ libelle: '', url: '' });
      render();
    } else if (action === 'fiche-retirer-lien') {
      S.fiche.liens.splice(Number(el.dataset.index), 1);
      render();
    } else if (action === 'enregistrer') {
      enregistrer();
    } else if (action === 'annuler-edition') {
      S.edition = null;
      remiseAZero();
      render();
    } else if (action === 'editer') {
      var note = S.notes.filter(function (n) { return n.uuid === el.dataset.uuid; })[0];
      if (!note || note.envoyee) {
        signalerErreur('Cette note a été envoyée : elle est figée.');
        return;
      }
      S.edition = note.uuid;
      S.texte = note.texte;
      S.date = note.date;
      S.cible = note.cible;
      S.cibleNom = note.cible_nom || '';
      // Une note typée rouvre SON formulaire, charge pré-remplie (§4.4).
      if (note.genre === 'ticket' || note.genre === 'idee') {
        S.genre = note.genre;
        S.fiche = Core.ficheDepuisCharge(note.genre, note.charge);
      } else {
        S.genre = 'note';
        S.fiche = Core.ficheVierge();
      }
      S.ecran = 'note';
      render();
      window.scrollTo(0, 0);
    } else if (action === 'supprimer') {
      var uuid = el.dataset.uuid;
      S.confirmation = {
        titre: 'Supprimer cette note ?',
        texte: "Elle n'a pas encore été envoyée : elle disparaîtra définitivement du téléphone.",
        libelle: 'Supprimer',
        action: function () {
          Store.supprimerNote(uuid)
            .then(charger)
            .then(function () { signalerSucces('Note supprimée.'); })
            .catch(function (e) { signalerErreur(String(e.message || e)); });
        },
      };
      render();
    } else if (action === 'envoyer') {
      preparerEnvoi('attente');
    } else if (action === 'tout-renvoyer') {
      preparerEnvoi('tout');
    } else if (action === 'retelecharger') {
      // Le fichier s'est perdu dans les Téléchargements, ou le navigateur l'a bloqué :
      // on le refabrique À L'IDENTIQUE. Rien n'est renvoyé, rien n'est marqué.
      if (!S.dernierLot) {
        signaler('Aucun lot à retélécharger.');
      } else if (telecharger(S.dernierLot.nom, S.dernierLot.json)) {
        signalerSucces('Fichier retéléchargé : ' + S.dernierLot.nom);
      } else {
        signalerErreur("Le téléchargement n'a pas démarré.");
      }
    } else if (action === 'depot-fait') {
      S.depot = null;
      render();
    } else if (action === 'bascule-envoyees') {
      S.toutAfficherEnvoyees = !S.toutAfficherEnvoyees;
      render();
    } else if (action === 'selection-ouvrir') {
      S.selection = {};
      S.ecran = 'file';
      render();
      // Les cases sont dans la liste « Envoyées », plus bas : on y emmène Julien, sinon le
      // bouton semble n'avoir rien fait.
      var liste = document.querySelector('.note-choix');
      if (liste) liste.scrollIntoView({ block: 'center' });
    } else if (action === 'selection-fermer') {
      S.selection = null;
      render();
    } else if (action === 'choisir') {
      var u = el.dataset.uuid;
      if (S.selection[u]) delete S.selection[u];
      else S.selection[u] = true;
      render();
    } else if (action === 'selection-tout') {
      var envoyees = S.notes.filter(function (n) { return n.envoyee; });
      var toutesCochees = envoyees.every(function (n) { return S.selection[n.uuid]; });
      S.selection = {};
      if (!toutesCochees) {
        envoyees.forEach(function (n) { S.selection[n.uuid] = true; });
      }
      render();
    } else if (action === 'renvoyer-selection') {
      // Tout est déjà en mémoire : le lot se construit et se télécharge SYNCHRONIQUEMENT,
      // dans le geste. Aucune écriture : ces notes sont déjà envoyées, on ne fait que
      // refabriquer un fichier pour le PC, qui dédoublonne par UUID.
      var choisies = S.notes
        .filter(function (n) { return n.envoyee && S.selection && S.selection[n.uuid]; })
        .sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
      if (choisies.length === 0) {
        signalerErreur('Coche au moins une note.');
        return;
      }
      var quand = new Date();
      var idLot = Core.uuid();
      var nomLot = Core.lotFilename(idLot, quand);
      var jsonLot = Core.lotJson(Core.buildLot(choisies, idLot, Core.horodatage(quand)));
      if (!telecharger(nomLot, jsonLot)) {
        signalerErreur("Le téléchargement n'a pas démarré. Réessaie.");
        return;
      }
      S.dernierLot = { nom: nomLot, json: jsonLot, envoye_le: Core.horodatage(quand), nb: choisies.length };
      Store.enregistrerDernierLot(S.dernierLot).catch(function () {});
      S.selection = null;
      S.depot = { nom: nomLot, nb: choisies.length };
      render();
    } else if (action === 'importer-ref') {
      document.getElementById('fichier-ref').click();
    } else if (action === 'confirmer') {
      var suite = S.confirmation ? S.confirmation.action : null;
      S.confirmation = null;
      render();
      if (suite) suite();
    } else if (action === 'annuler-confirmation') {
      S.confirmation = null;
      S.lotPret = null; // un lot préparé mais non confirmé ne doit rien laisser derrière lui
      render();
    } else if (action === 'backlog-projet') {
      S.backlogProjet = el.dataset.cle;
      S.colonneOuverte = 0;
      render();
      window.scrollTo(0, 0);
    } else if (action === 'backlog-retour') {
      S.backlogProjet = null;
      S.colonneOuverte = null;
      render();
    } else if (action === 'backlog-colonne') {
      var index = Number(el.dataset.index);
      S.colonneOuverte = S.colonneOuverte === index ? null : index;
      render();
    } else if (action === 'backlog-ticket') {
      var projet = S.backlogs.filter(function (p) { return p.cle === S.backlogProjet; })[0];
      if (!projet) return;
      var colonne = projet.colonnes[Number(el.dataset.colonne)];
      // La colonne RDV globale ne puise pas dans le projet ouvert mais dans la liste
      // commune : l'index s'y rapporte.
      var source = el.dataset.global ? S.backlogsRdv : colonne.tickets;
      var ticket = source[Number(el.dataset.index)];
      if (!ticket) return;
      S.ticket = Object.assign({}, ticket, { colonne: colonne.libelle });
      render();
    } else if (action === 'fermer-ticket') {
      S.ticket = null;
      render();
    } else if (action === 'idees-projet') {
      S.ideeProjet = el.dataset.cle;
      S.categorieOuverte = 0;
      render();
      window.scrollTo(0, 0);
    } else if (action === 'idees-retour') {
      S.ideeProjet = null;
      S.categorieOuverte = null;
      render();
    } else if (action === 'idees-categorie') {
      var rang = Number(el.dataset.index);
      S.categorieOuverte = S.categorieOuverte === rang ? null : rang;
      render();
    } else if (action === 'idees-carte') {
      var porteur = S.backlogs.filter(function (p) { return p.cle === S.ideeProjet; })[0];
      var categories = porteur ? Core.categoriesDe(porteur) || [] : [];
      var categorie = categories[Number(el.dataset.categorie)];
      var idee = categorie && (categorie.idees || [])[Number(el.dataset.index)];
      if (!idee) return;
      S.idee = Object.assign({}, idee, {
        categorie: categorie.libelle,
        famille: categorie.famille || null,
      });
      render();
    } else if (action === 'fermer-idee') {
      S.idee = null;
      render();
    }
  }

  function demarrer() {
    // Un rendu qui lève laisse l'écran PRÉCÉDENT en place, sans un mot : sur un téléphone,
    // sans console, cela se voit comme « je clique et il ne se passe rien ». On rend donc
    // toute erreur non rattrapée VISIBLE — c'est le seul canal de diagnostic ici.
    window.addEventListener('error', function (e) {
      var detail = e && e.message ? e.message : 'erreur inconnue';
      signalerErreur('Anomalie de l\'application : ' + detail);
    });
    window.addEventListener('unhandledrejection', function (e) {
      var r = e && e.reason;
      signalerErreur('Anomalie de l\'application : ' + ((r && r.message) || String(r)));
    });
    racine().addEventListener('click', surClic);
    racine().addEventListener('input', function (e) {
      var champ = e.target;
      if (!champ) return;
      // Reprendre la saisie efface le bandeau de succès (sans re-rendu : il partira au
      // prochain, le champ garde son focus).
      if (S.succes) S.succes = null;
      if (champ.id === 'saisie') {
        S.texte = champ.value;
        return;
      }
      // Champs de la fiche Ticket/Idée (data-champ) : l'état suit la frappe, SANS re-rendu
      // — re-rendre à chaque touche ferait perdre le focus, comme pour la saisie libre.
      var nom = champ.dataset && champ.dataset.champ;
      if (!nom) return;
      if (nom === 'lien-libelle' || nom === 'lien-url') {
        var lien = S.fiche.liens[Number(champ.dataset.index)];
        if (lien) lien[nom === 'lien-url' ? 'url' : 'libelle'] = champ.value;
      } else {
        S.fiche[nom] = champ.value;
      }
    });
    document.getElementById('fichier-ref').addEventListener('change', function (e) {
      var fichier = e.target.files && e.target.files[0];
      if (fichier) chargerFichierReferentiel(fichier);
      e.target.value = ''; // recharger deux fois le même fichier doit remarcher
    });
    render();
    charger().catch(function (e) {
      signalerErreur('Stockage local indisponible : ' + String(e.message || e));
    });
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').then(lireVersion).catch(function () {});
      // Le cache n'existe pas encore au moment où `register` résout : on relit un peu
      // plus tard, et à chaque prise de contrôle par un nouveau service worker.
      navigator.serviceWorker.addEventListener('controllerchange', lireVersion);
      setTimeout(lireVersion, 1500);
    }
    lireVersion();
  }

  // Version réellement servie, déduite du nom du cache du service worker.
  function lireVersion() {
    if (!global.caches) return Promise.resolve();
    return caches
      .keys()
      .then(function (cles) {
        var trouve = cles.filter(function (k) { return k.indexOf('cockpit-notes-v') === 0; })[0];
        var v = trouve ? trouve.replace('cockpit-notes-', '') : null;
        if (v && v !== S.version) {
          S.version = v;
          render();
        }
      })
      .catch(function () {});
  }

  global.CockpitNotes = { demarrer: demarrer, _etat: S };
  document.addEventListener('DOMContentLoaded', demarrer);
})(window);
