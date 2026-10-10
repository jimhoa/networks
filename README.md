# Studio — planification LinkedIn

Application personnelle de rédaction manuelle et programmation de posts texte pour profil et pages entreprise. Aucun texte généré par IA. Node.js 24+, SQLite intégré, aucune dépendance npm.

## Développement

Dans `/workspace/networks`, lancer `npm test`, puis `npm start`. Le serveur écoute localement sur le port 3000. Sans mot de passe, cliquer sur « Ouvrir mon espace » pour utiliser les brouillons locaux. Les données sont conservées dans `.data/planner.sqlite` (ignoré par Git). Un seul processus serveur doit utiliser cette base.

## Activer LinkedIn

Copier `.env.example` vers `.env` et remplir les valeurs localement, sans les committer. Générer TOKEN_ENCRYPTION_KEY avec `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Conserver cette clé : changer la clé rend les anciens jetons illisibles.

Créer une application LinkedIn et obtenir les produits et autorisations nécessaires. Déclarer exactement `${APP_URL}/auth/callback` comme redirect URI. Profil : `openid profile w_member_social`. Pages : ajouter `r_organization_admin w_organization_social` dans LINKEDIN_SCOPES, sous réserve des accès accordés par LinkedIn. Choisir une version Marketing API actuellement prise en charge pour LINKEDIN_VERSION (YYYYMM), vérifier les règles du produit dans la documentation officielle LinkedIn. Les tests avec mocks ne prouvent pas la disponibilité de ces permissions pour votre application.

Configurer APP_PASSWORD avant exposition réseau. Pour un hébergement permanent : NODE_ENV=production, APP_URL HTTPS, reverse proxy TLS et supervision du processus. Le worker vérifie les posts dus toutes les 15 secondes. Les processus ne survivent pas à un snapshot cloud ; relancer `npm start`. Une machine arrêtée ne publie pas à l’heure ; les posts en attente seront envoyés au redémarrage. Éviter d’utiliser cet environnement de développement comme hébergement permanent.

Connexion OAuth via « Comptes LinkedIn », puis import des pages dont vous êtes administrateur. Aucune saisie manuelle d’URN pour contourner les permissions. Le code importe uniquement la première liste complète d’ACL et bloque si pagination détectée ; pagination avancée à implémenter pour les comptes possédant de nombreuses pages.

## Limites de cette première version

Posts texte et liens uniquement. Pas de pièces jointes, collaboration, modification de posts programmés ou rafraîchissement automatique de jetons. Reconnexion requise après expiration ; reconnecter puis réimporter les pages. L’application stocke les jetons chiffrés et ne relance jamais automatiquement un envoi ambigu. Vérifier LinkedIn avant une nouvelle publication en cas d’état « À vérifier ». Une API officielle réduit les risques liés aux automatisations de navigateur, sans garantir l’absence de restrictions LinkedIn.

Avant mise en production publique, effectuer un audit de sécurité et une validation réelle avec votre application LinkedIn. Ne pas exposer cette version directement à Internet sans ces étapes. Les identifiants, consentements et publications réelles n’ont pas été testés pendant le développement.
