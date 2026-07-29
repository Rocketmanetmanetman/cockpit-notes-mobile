// app.js — INTERFACE de l'application mobile de notes du Cockpit.
//
// Vanilla, sans framework : un objet d'état unique `S`, un `render()` qui réécrit l'écran,
// et une délégation d'événements posée une seule fois (aucun gestionnaire à rebrancher
// après chaque rendu). Toute confirmation passe par une **modale maison**, jamais par un
// dialogue du navigateur ; une confirmation posée par-dessus un autre calque passe devant.
//
// Trois écrans : **Note** (écrire), **File** (envoyer, recevoir les référentiels) et
// **Backlogs** (consultation en lecture seule). Le bloc « Envoi vers le PC » est nettement
// séparé du bouton d'enregistrement : ce sont deux gestes de nature opposée — l'un remplit
// la file, l'autre la vide — et les coller a déjà coûté des erreurs de manipulation sur
// l'application de budget.
(function (global) {
  'use strict';

  var Core = global.Core;
  var Store = global.Store;

  var S = {
    ecran: 'note',
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
    backlogProjet: null,
    colonneOuverte: null,
    ticket: null,
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
    message: null,
    minuteurMessage: null,
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

  function signaler(texte) {
    S.message = texte;
    if (S.minuteurMessage) clearTimeout(S.minuteurMessage);
    S.minuteurMessage = setTimeout(function () {
      S.message = null;
      render();
    }, 2600);
    render();
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
      '</header>'
    );
  }

  function onglets() {
    var items = [
      { cle: 'note', libelle: 'Écrire' },
      { cle: 'file', libelle: 'File' },
      { cle: 'backlogs', libelle: 'Backlogs' },
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

  // -- Écran 1 : écrire une note --
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

    return (
      (avertissement === '' ? '' : '<section class="bloc">' + avertissement + '</section>') +

      '<section class="bloc">' +
      '<h2 class="titre-bloc">' + (enEdition ? 'Modifier la note' : 'Nouvelle note') + '</h2>' +
      // 7 lignes : de quoi écrire largement, tout en laissant le choix du projet (et, au
      // premier lancement, le bouton d'import) atteignable sans faire défiler l'écran.
      // Le champ reste redimensionnable à la main (`resize: vertical`).
      '<textarea class="saisie" id="saisie" placeholder="Écris ta note…" rows="7">' + ech(S.texte) + '</textarea>' +
      '<div class="rangee-outils">' +
      '<button type="button" class="bouton bouton-doux" data-action="separateur">— Séparateur</button>' +
      '</div>' +
      '</section>' +

      '<section class="bloc">' +
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
      (enEdition ? 'Enregistrer les modifications' : 'Enregistrer la note') + '</button>' +
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
        : attente.map(carte).join('')) +
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
          var tickets = colonne.tickets || [];
          return (
            '<div class="colonne">' +
            '<button type="button" class="colonne-entete" data-action="backlog-colonne" data-index="' + index + '"' +
            ' style="--teinte:' + ech(colonne.couleur || '#8A8F94') + '">' +
            '<span class="colonne-nom">' + ech(colonne.libelle) + '</span>' +
            '<span class="colonne-compte">' + tickets.length + '</span>' +
            '<span class="colonne-fleche">' + (ouverte ? '▾' : '▸') + '</span>' +
            '</button>' +
            (ouverte
              ? '<div class="colonne-tickets">' +
                (tickets.length === 0
                  ? '<p class="explication">Colonne vide.</p>'
                  : tickets
                      .map(function (t, i) {
                        return (
                          '<button type="button" class="ticket" data-action="backlog-ticket"' +
                          ' data-colonne="' + index + '" data-index="' + i + '">' +
                          '<span class="ticket-titre">' + ech(t.titre) + '</span>' +
                          '<span class="ticket-bas">' +
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

  // -- Calques : calendrier, confirmation, détail d'un ticket, message --
  function calques() {
    var sortie = '';

    if (S.calendrier) {
      var cases = Core.grilleMois(S.calendrier.annee, S.calendrier.mois);
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
              (c.iso === S.date ? ' cal-choisie' : '') + '" data-action="cal-jour" data-iso="' + c.iso + '">' +
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
        '<p class="ticket-colonne">' + ech(S.ticket.colonne) + '</p>' +
        '<h3 class="ticket-detail-titre">' + ech(S.ticket.titre) + '</h3>' +
        (S.ticket.date_valeur ? '<p class="ticket-detail-date">' + ech(dateTicket(S.ticket)) + '</p>' : '') +
        (S.ticket.prioritaire_home ? '<p class="marque-prioritaire">Prioritaire Home</p>' : '') +
        (S.ticket.description
          ? '<p class="ticket-detail-description">' + ech(S.ticket.description) + '</p>'
          : '<p class="explication">Pas de description.</p>') +
        '<p class="explication">Lecture seule : le téléphone ne modifie jamais un backlog.</p>' +
        '<button type="button" class="bouton bouton-doux" data-action="fermer-ticket">Fermer</button>' +
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
      sortie += '<div class="message">' + ech(S.message) + '</div>';
    }
    return sortie;
  }

  function render() {
    var corps =
      S.ecran === 'note' ? ecranNote() : S.ecran === 'file' ? ecranFile() : ecranBacklogs();
    racine().innerHTML = entete() + onglets() + '<main class="contenu">' + corps + '</main>' + calques();
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
    if (Core.noteVide(S.texte)) {
      signaler('Note vide : écris quelque chose avant d\'enregistrer.');
      return;
    }
    if (!Core.dateValide(S.date)) {
      signaler('Date invalide.');
      return;
    }
    Store.demanderPersistance();
    if (S.edition) {
      Store.modifierNote(S.edition, {
        texte: S.texte,
        date: S.date,
        cible: S.cible,
        cible_nom: S.cibleNom,
      })
        .then(function () {
          S.edition = null;
          remiseAZero();
          return charger();
        })
        .then(function () { signaler('Note modifiée.'); })
        .catch(function (e) { signaler(String(e.message || e)); });
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
        return charger();
      })
      .then(function () { signaler('Note enregistrée.'); })
      .catch(function (e) { signaler(String(e.message || e)); });
  }

  // Après un enregistrement : le texte repart à vide, la date à aujourd'hui, et le PROJET
  // est conservé (on note souvent plusieurs choses de suite sur le même sujet).
  function remiseAZero() {
    S.texte = '';
    S.date = Core.dateISO();
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
      signaler("Le téléchargement n'a pas démarré. Rien n'a été marqué comme envoyé — réessaie.");
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
      .catch(function (e) { signaler(String(e.message || e)); });
  }

  function chargerFichierReferentiel(fichier) {
    var lecteur = new FileReader();
    lecteur.onload = function () {
      var resultat = Core.parseReferentiel(String(lecteur.result));
      if (!resultat.ok) {
        signaler(resultat.erreur);
        return;
      }
      Store.enregistrerReferentiel(resultat.genre, String(lecteur.result))
        .then(charger)
        .then(function () {
          signaler(
            (resultat.genre === 'projets' ? 'Projets' : 'Backlogs') +
            ' mis à jour (' + Core.horodatageFr(resultat.genere_le) + ').',
          );
        })
        .catch(function (e) { signaler(String(e.message || e)); });
    };
    lecteur.onerror = function () { signaler('Lecture du fichier impossible.'); };
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
      }
      // Une cible qui a disparu du référentiel repasse « Sans projet » : le téléphone ne
      // propose jamais une cible qu'il ne connaît plus.
      if (S.cible && !S.projets.some(function (p) { return p.cle === S.cible; })) {
        S.cible = null;
        S.cibleNom = '';
      }
      render();
    });
  }

  // ---- Délégation d'événements (posée une seule fois) -------------------------

  function surClic(evenement) {
    var el = evenement.target.closest('[data-action]');
    if (!el) return;
    // Un clic DANS la feuille ne ferme pas le calque qui la porte (seul le fond ferme).
    if (el.classList.contains('calque') && evenement.target.closest('.feuille')) return;
    var action = el.dataset.action;

    if (action === 'onglet') {
      lireSaisie();
      S.ecran = el.dataset.cible;
      render();
      window.scrollTo(0, 0);
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
      render();
    } else if (action === 'ouvrir-calendrier') {
      lireSaisie();
      var base = Core.dateValide(S.date) ? S.date : Core.dateISO();
      S.calendrier = { annee: Number(base.slice(0, 4)), mois: Number(base.slice(5, 7)) - 1 };
      render();
    } else if (action === 'cal-mois') {
      var delta = Number(el.dataset.delta);
      var d = new Date(S.calendrier.annee, S.calendrier.mois + delta, 1);
      S.calendrier = { annee: d.getFullYear(), mois: d.getMonth() };
      render();
    } else if (action === 'cal-jour') {
      S.date = el.dataset.iso;
      S.calendrier = null;
      render();
    } else if (action === 'cal-fermer') {
      S.calendrier = null;
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
        signaler('Cette note a été envoyée : elle est figée.');
        return;
      }
      S.edition = note.uuid;
      S.texte = note.texte;
      S.date = note.date;
      S.cible = note.cible;
      S.cibleNom = note.cible_nom || '';
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
            .then(function () { signaler('Note supprimée.'); })
            .catch(function (e) { signaler(String(e.message || e)); });
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
        signaler('Fichier retéléchargé : ' + S.dernierLot.nom);
      } else {
        signaler("Le téléchargement n'a pas démarré.");
      }
    } else if (action === 'depot-fait') {
      S.depot = null;
      render();
    } else if (action === 'bascule-envoyees') {
      S.toutAfficherEnvoyees = !S.toutAfficherEnvoyees;
      render();
    } else if (action === 'selection-ouvrir') {
      S.selection = {};
      render();
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
        signaler('Coche au moins une note.');
        return;
      }
      var quand = new Date();
      var idLot = Core.uuid();
      var nomLot = Core.lotFilename(idLot, quand);
      var jsonLot = Core.lotJson(Core.buildLot(choisies, idLot, Core.horodatage(quand)));
      if (!telecharger(nomLot, jsonLot)) {
        signaler("Le téléchargement n'a pas démarré. Réessaie.");
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
      var ticket = colonne.tickets[Number(el.dataset.index)];
      S.ticket = Object.assign({}, ticket, { colonne: colonne.libelle });
      render();
    } else if (action === 'fermer-ticket') {
      S.ticket = null;
      render();
    }
  }

  function demarrer() {
    // Un rendu qui lève laisse l'écran PRÉCÉDENT en place, sans un mot : sur un téléphone,
    // sans console, cela se voit comme « je clique et il ne se passe rien ». On rend donc
    // toute erreur non rattrapée VISIBLE — c'est le seul canal de diagnostic ici.
    window.addEventListener('error', function (e) {
      var detail = e && e.message ? e.message : 'erreur inconnue';
      signaler('Anomalie de l\'application : ' + detail);
    });
    window.addEventListener('unhandledrejection', function (e) {
      var r = e && e.reason;
      signaler('Anomalie de l\'application : ' + ((r && r.message) || String(r)));
    });
    racine().addEventListener('click', surClic);
    racine().addEventListener('input', function (e) {
      if (e.target && e.target.id === 'saisie') S.texte = e.target.value;
    });
    document.getElementById('fichier-ref').addEventListener('change', function (e) {
      var fichier = e.target.files && e.target.files[0];
      if (fichier) chargerFichierReferentiel(fichier);
      e.target.value = ''; // recharger deux fois le même fichier doit remarcher
    });
    render();
    charger().catch(function (e) {
      signaler('Stockage local indisponible : ' + String(e.message || e));
    });
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(function () {});
    }
  }

  global.CockpitNotes = { demarrer: demarrer, _etat: S };
  document.addEventListener('DOMContentLoaded', demarrer);
})(window);
