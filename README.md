# `mobile/` — l'application de notes du téléphone

PWA de saisie de notes rattachées aux projets du Cockpit. Elle vit **dans ce dépôt** et se
publie par **GitHub Pages**. Elle ne parle à personne : aucun réseau, aucune API, aucun
compte. Le pont avec le PC est **un dossier**, pas un protocole.

---

## Comment ça marche, en trois lignes

1. Tu écris des notes sur le téléphone, hors-ligne. Chacune porte un UUID et se range dans
   une file locale (IndexedDB).
2. « Envoyer » fabrique **un fichier de lot** que le téléphone télécharge. Tu le déposes
   toi-même dans le dossier Google Drive du Cockpit.
3. Sur le PC, « Google Drive pour ordinateur » monte ce dossier en dossier local. Le
   Cockpit le lit, te montre ce qui va entrer, et l'importe sur ton clic.

Dans l'autre sens, le Cockpit écrit deux fichiers dans le même dossier — `projets.json`
(les projets à proposer) et `backlogs.json` (l'instantané des backlogs) — que tu charges
sur le téléphone avec le sélecteur de fichier.

---

## Publier sur GitHub Pages

**La PWA est publiée depuis un dépôt public SÉPARÉ**, qui ne contient que ces fichiers
(décision du 29-07-2026, qui remplace le D3 de la spec — celui-ci prévoyait de rendre public
le dépôt Cockpit entier). Motif : rendre le dépôt Cockpit public y publierait aussi les
specs, `CLAUDE.md`, `CLAUDE_WEB.md`, les documents de référence et des chemins personnels.
**Le dépôt Cockpit reste donc local et privé.**

La **source de vérité reste `mobile/`** dans le dépôt Cockpit ; le dépôt public en est une
copie, tenue à jour par [`publier.ps1`](publier.ps1).

Une seule fois :

1. Créer sur GitHub un dépôt **public** vide, par exemple `cockpit-notes-mobile` — **sans**
   README, .gitignore ni licence (le dossier local en a déjà un).
2. Le rattacher au dossier local déjà préparé et pousser :
   ```
   git -C "…\refonte\claude code\cockpit-notes-mobile" remote add origin https://github.com/<compte>/cockpit-notes-mobile.git
   git -C "…\refonte\claude code\cockpit-notes-mobile" push -u origin main
   ```
3. Dépôt → **Settings** → **Pages** → **Source** : « Deploy from a branch », **Branch** :
   `main`, dossier `/ (root)`. Enregistrer.
4. L'application est servie à `https://<compte>.github.io/cockpit-notes-mobile/`
   (compter une minute pour la première mise en ligne).

Ensuite, publier une modification :

```
powershell -ExecutionPolicy Bypass -File mobile\publier.ps1
```

Il recopie les fichiers, **refuse de publier si la version du cache n'a pas changé** (voir
ci-dessous), commet, et affiche la commande de `push` — qu'il ne lance jamais lui-même.

Rien à construire : pas de bundler, pas de npm, pas de transpilation — ce sont les fichiers
eux-mêmes qui sont servis.

### ⚠ À chaque publication : incrémenter la version du cache

Dans [`sw.js`](sw.js), en tête :

```js
var CACHE = 'cockpit-notes-v1';   //  ← v2, v3, …
```

Sans ça, le service worker re-sert sa copie et la mise à jour **n'arrive jamais** sur le
téléphone. C'est le piège de développement le plus coûteux de ce genre d'application.

Pour forcer une mise à jour sur un téléphone récalcitrant : désinstaller la PWA, vider les
données du site dans Chrome, recharger. **Les notes survivent** (le service worker ne
touche jamais IndexedDB), mais autant envoyer sa file avant, par prudence.

### Installer sur le téléphone

Ouvrir l'adresse dans Chrome Android → menu → « Ajouter à l'écran d'accueil ». Elle
s'ouvre alors en plein écran et fonctionne **entièrement hors-ligne**.

---

## Tester en local

Depuis la racine du dépôt :

```bash
npx vite mobile --port 5174 --strictPort
```

- l'application : <http://localhost:5174/>
- les tests de la logique pure : <http://localhost:5174/tests.html>

---

## Les fichiers

| Fichier | Rôle |
|---|---|
| `core.js` | **Logique pure** : dates, UUID, contrat de fichiers, lecture des référentiels. Sans état, sans DOM, sans stockage — c'est ce qui la rend testable seule. |
| `store.js` | **Stockage** IndexedDB. Rien n'est jamais purgé ; une note envoyée est figée, et le garde-fou est ici, pas dans l'interface. |
| `app.js` | **Interface** : un état unique, un rendu complet, une délégation d'événements. |
| `sw.js` | Service worker hors-ligne. **Ne touche jamais IndexedDB.** |
| `tests.html` | Harnais de tests de `core.js` (ouvrir la page : le bilan est en haut). |
| `index.html`, `styles.css`, `manifest.webmanifest`, `icon*.svg` | Coquille, thème tactile, installabilité. |

---

## Le contrat de fichiers (figé, version 1)

C'est le pivot : tant qu'il est respecté, chaque côté peut être réécrit entièrement.

**Lot — téléphone → PC.** Nom : `lot AAAA-MM-JJ HHhMMmSS <6 hex>.json` (l'ordre
alphabétique des noms est l'ordre chronologique).

```json
{
  "format": "cockpit-notes-lot",
  "version": 1,
  "lot": "<uuid du lot>",
  "genere_le": "AAAA-MM-JJ HH:MM:SS",
  "notes": [
    {
      "uuid": "<uuid de la note>",
      "texte": "corps de la note, séparateurs compris",
      "date": "AAAA-MM-JJ",
      "cible": "proj:3",
      "cible_nom": "Musique",
      "cree_le": "AAAA-MM-JJ HH:MM:SS"
    }
  ]
}
```

`cible` vaut `null` pour une note sans projet. Un lot peut recontenir des notes déjà
envoyées : le PC dédoublonne par UUID.

**Référentiels — PC → téléphone.** `projets.json` (`format: "cockpit-projets"`) et
`backlogs.json` (`format: "cockpit-backlogs"`), version 1, réécrits à chaque génération.

Règles communes : JSON UTF-8 indenté, **champs inconnus ignorés**, **version non comprise
refusée proprement** — jamais ingérée à moitié.
