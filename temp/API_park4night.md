# API park4night — Reverse Engineering (v7.1.60 / build 375)

> Documentation reconstituée à partir du décompilé de `fr.tramb.park4night` 7.1.60 (XAPK APKPure).
> Couche réseau : **Kotlin Multiplatform** (`com.park4night.p4nsharedlayers`) + **Ktor Client** + `kotlinx.serialization`.
> ⚠️ Usage strictement à but d'interopérabilité / documentation. Respectez les CGU de park4night.

---

## 1. Vue d'ensemble technique

| Élément | Valeur |
|---|---|
| Package Android | `fr.tramb.park4night` |
| Version | 7.1.60 (versionCode 375), min SDK 24, target SDK 35 |
| Module réseau | `com.park4night.p4nsharedlayers` (KMP shared, `sharedLayers 0.4.31`) |
| Client HTTP | **Ktor** `HttpClient` (moteur JVM/OkHttp), coroutines |
| Sérialisation | `kotlinx.serialization` JSON — `isLenient=true`, `ignoreUnknownKeys=true` |
| DI | Koin |
| **User-Agent** | `shared - 0.4.31` |
| Logging | `LogLevel.BODY` (les requêtes/réponses sont loguées en clair côté client) |
| Domaine principal | `park4night.com` |
| Analytics/erreurs | Sentry (DSN présent dans `park4nightApp`) |

### Construction des URLs (`makeUrl`)

```
https://{sousDomaine}{domaine}/{prefixe}/{url_endpoint}
```

- `{domaine}` = `park4night.com`
- `{sousDomaine}` (préfixe) selon l'endpoint — voir §2
- `{prefixe}` dépend du **type d'API** de l'endpoint :

| ApiType | Préfixe chemin | Exemple |
|---|---|---|
| `LEGACY` (défaut) | `/services/V4.1/` | `…/services/V4.1/lieuGetOneLieux.php` |
| `V2` | `/api/` | `…/api/user/subscription` |
| `CUSTOM` | `/services/` | `…/services/offline/V3/map/config.json` |

### Sous-domaines (`SubDomain`)

| Enum | Préfixe hôte | Résolution |
|---|---|---|
| `DEFAULT`, `WRITE`, `LOGIN`, `P4N` | *(vide)* → `park4night.com` | fixe |
| `PUB` | `pub.` → `pub.park4night.com` | fixe (publicités, menu) |
| `PLUS` | `plus.` → `plus.park4night.com` | abonné Premium |
| `GUEST` | `guest.` → `guest.park4night.com` | utilisateur invité |
| `REQUEST` | **dynamique** | `plus.` si abonné · `guest.` si `context_user == "guest"` · sinon vide |

> La plupart des endpoints « lecture » utilisent `REQUEST` : l'hôte dépend donc de l'état d'abonnement.
> Pour un compte gratuit connecté → `park4night.com`. Pour un invité → `guest.park4night.com`.

---

## 2. Authentification & Sécurité

**Il n'y a AUCune signature de requête (pas de HMAC, pas de token Bearer, pas d'AES).**
L'authentification repose entièrement sur des **paramètres de query string**, transmis sur **toutes** les requêtes via `UrlContext.fullContext()`.

### 2.1 Le « contexte » ajouté à chaque requête

Chaque URL se termine par `?{params endpoint}&{fullContext}`. `fullContext()` produit :

```
context_user={pseudo}
&context_os=ANDROID
&context_lang={langueApp}          ex: fr
&langue_locale={locale}            ex: fr_FR
&context_latitude={lat}
&context_longitude={lon}
&context_version={versionApp}      ex: 7.1.60
&isMonthPremium={true|false}
&isYearPremium={true|false}
&context_id_user={idUtilisateur}
&os=ANDROID
[&context_vehicule={vehicule}]     si renseigné
[&motdepasse={hashSHA256}]         si connecté
```

### 2.2 Le mot de passe = SHA-256

Le mot de passe n'est **jamais** envoyé en clair : il est haché **SHA-256** puis encodé en **hexadécimal minuscule** (`fr.tramb.park4night.tools.h.getHash`). C'est ce hash qui circule dans `motdepasse=`.

```js
// équivalent JS (Postman: CryptoJS intégré)
motdepasse = CryptoJS.SHA256("monMotDePasse").toString();  // 64 hex chars
```

### 2.3 Login

Le login est un simple `GET userGet.php` avec `uuid` (pseudo) + `motdepasse` (hash) :

```
GET https://park4night.com/services/V4.1/userGet.php?uuid={pseudo}&motdepasse={sha256}&{fullContext}
→ UserResponse (results: UserDto)
```

`LoginUseCase.execute(pseudo, getHash(motDePasse))` → stocke l'utilisateur en session.

### 2.4 Invité

Persona par défaut : `context_user=guest`, `context_id_user=guest` (aucun `motdepasse`). Les requêtes en tant qu'invité passent par `guest.park4night.com`.

### 2.5 Endpoints « token »

`getToken.php` / `checkToken.php` renvoient/valident un `TokenResponse{token}` (utilisé pour certains flux internes : suppression de compte via `privacyDelete.php?hash=`, etc.). Le token **n'est pas** un Bearer d'API : le socle d'auth reste `context_user` + `motdepasse`.

### 2.6 Clés tierces exposées (en clair dans le binaire)

| Clé | Emplacement | Usage |
|---|---|---|
| `AIzaSyC8jy0bA6j5EQjnnMonW34VQgkCjBP7RSU` | `Itinerary.java` | Google Maps Directions API |
| MapTiler `style.json` | `OfflineDownloadService` | fonds de carte hors-ligne |
| Sentry DSN | `park4nightApp` | reporting crash |

---

## 3. Encodage des corps de requête (POST)

Deux formats seulement :

1. **`multipart/form-data`** (cas majoritaire des POST) avec **un seul champ** :
   - champ **`json`** = objet JSON sérialisé (string), pour la plupart des POST ;
   - champ **`file`** = octets JPEG (`Content-Type: image/jpg`, `filename="file.jpg"`) pour l'upload photo.
2. **`application/json`** — uniquement pour les endpoints **V2** (`/api/…`), ex. `password/forgot`.

Les paramètres « métier » (id, uuid, note…) restent souvent en **query string** même sur les POST.

---

## 4. Endpoints

> Base par défaut : `https://park4night.com`. Colonne « Hôte » = préfixe de sous-domaine appliqué.
> Tous les endpoints reçoivent en plus le bloc `fullContext` (§2.1). `Réponse` = type §5.

### 4.1 Lieux (places)

| # | Méthode | Chemin | Hôte | Params clés | Réponse |
|---|---|---|---|---|---|
| 1 | GET | `/services/V4.1/lieuGetOneLieux.php` | REQUEST | `id`, `appli=park4night` | `PlaceResponse` |
| 2 | GET | `/services/V4.1/lieuxGetAroundMe.php` | REQUEST | `latitude`, `longitude` | `PlaceResponse` |
| 3 | GET | `/services/V4.1/lieuxGetFilter.php` | REQUEST | `latitude`,`longitude`,`hauteur_limite`,`types`,`activites`,`services`,`note`,`all_year`,`online_booking` | `PlaceResponse` |
| 4 | POST | `/services/V4.1/lieuxGettrack.php` | REQUEST | query: `polygon` + filtres (idem #3) | `PlaceResponse` |
| 5 | GET | `/services/V4.1/lieuGetCommUser.php` | REQUEST | `user_id`, `uuid` | `PlaceResponse` |
| 6 | GET | `/services/V4.1/lieuGetUser.php` | REQUEST | `uuid`, `visites=true` | `PlaceResponse` |
| 7 | GET | `/services/V4.1/lieuGetMapCustom.php` | REQUEST | `map` | `PlaceCustomResponse` |
| 8 | GET | `/services/V4.1/lieuPatchFolder.php` | WRITE | `folder_id` | `PlaceResponse` |
| 9 | GET | `/services/V4.1/lieuGetInfos.php` | REQUEST | `id_lieu` | `PlaceInfoResponse` |
| 10 | POST | `/services/V4.1/geocoding.php` | REQUEST | `q` (recherche) | `GeocodingResponse` |

**#3 `lieuxGetFilter.php` — détail des filtres :**
- `hauteur_limite` : hauteur max véhicule (m), ex `3.0`
- `types` : codes `PlaceType` joints par `-`, ex `C-ACC_P-ACC_G` (voir §6)
- `activites` : codes activités joints par `-`, ex `baignade-rando`
- `services` : codes services joints par `-`, ex `electricite-wifi`
- `note` : filtre note minimale ∈ `{4.75, 4, 3}`
- `all_year` / `online_booking` : `1` si actif (absent sinon)

### 4.2 Actions sur les lieux

| # | Méthode | Chemin | Hôte | Corps / Params | Réponse |
|---|---|---|---|---|---|
| 11 | POST | `/services/V4.1/lieuPut.php` | WRITE | multipart `json` = `PlaceDto` | `AddPlaceResponse` |
| 12 | POST | `/services/V4.1/lieuPutCheckStep.php` | REQUEST | query `step` + multipart `json` = `PlaceDto` | `NothingResponse` |
| 13 | GET | `/services/V4.1/lieuDelete.php` | WRITE | `id` (placeId) | `NothingResponse` |
| 14 | POST | `/services/V4.1/lieuSignal.php` | WRITE | multipart `json` = `{id, uuid, type, description}` | `NothingResponse` |
| 15 | POST | `/services/V4.1/visitePut.php` | WRITE | multipart `json` = `{id_lieu, visite}` | `NothingResponse` |

### 4.3 Photos

| # | Méthode | Chemin | Hôte | Corps / Params | Réponse |
|---|---|---|---|---|---|
| 16 | GET | `/services/V4.1/lieuGetPhotos.php` | REQUEST | `pn_lieu_id` | `PhotosResponse` |
| 17 | POST | `/services/V4.1/photoPut.php` | WRITE | query `pn_lieu_id` + multipart `file` (image/jpg) | `NothingResponse` |
| 18 | GET | `/services/V4.1/photoDelete.php` | WRITE | `id` (photoId) | `NothingResponse` |

### 4.4 Avis (reviews / commentaires)

| # | Méthode | Chemin | Hôte | Corps / Params | Réponse |
|---|---|---|---|---|---|
| 19 | GET | `/services/V4.1/commGet.php` | REQUEST | `lieu_id`, `appli=park4night` | `ReviewsResponse` |
| 20 | GET | `/services/V4.1/commGet.php` | REQUEST | `user_id`, `appli=park4night` | `ReviewsResponse` |
| 21 | POST | `/services/V4.1/commPut.php` | WRITE | multipart `json` = `ReviewDto` | `NothingResponse` |
| 22 | POST | `/services/V4.1/commDelete.php` | WRITE | multipart `json` = `ReviewDto` | `NothingResponse` |
| 23 | GET | `/services/V4.1/commGetTrad.php` | REQUEST | `id_comm` | `TranslateReviewResponse` |

### 4.5 Utilisateur & compte

| # | Méthode | Chemin | Hôte | Corps / Params | Réponse |
|---|---|---|---|---|---|
| 24 | GET | `/services/V4.1/userGet.php` | LOGIN | `uuid`, `motdepasse` (**login**) | `UserResponse` |
| 25 | POST | `/services/V4.1/userPut.php` | LOGIN | query `uuid`, `motdepasse`, `newsletter` (**inscription**) | `UserResponse` |
| 26 | GET | `/services/V4.1/userPatch.php` | WRITE | `uuid`, `nv_mail`, `nv_motdepasse`, `type_vehicule`, `url_facebook`, `url_instagram`, `url_twitter`, `url_youtube`, `url_web` | `UserResponse` |
| 27 | GET | `/services/V4.1/userGetPublic.php` | REQUEST | `id_user` | `UserProfileResponse` |
| 28 | GET | `/services/V4.1/privacyDelete.php` | WRITE | `hash` (suppression compte RGPD) | `NothingResponse` |
| 29 | GET | `/services/V4.1/privacyGet.php` | REQUEST | — | `PrivacyDto` |
| 30 | GET | `/services/V4.1/getToken.php` | REQUEST | — | `TokenResponse` |
| 31 | GET | `/services/V4.1/checkToken.php` | REQUEST | — | `NothingResponse` |
| 32 | POST | `/services/V4.1/activationGet.php` | DEFAULT | — (renvoi mail d'activation) | `String` |
| 33 | POST | `/api/password/forgot` | DEFAULT (V2) | JSON `{ "email": "…" }` | `NothingResponse` |
| 34 | GET | `/services/V4.1/codePut.php` | WRITE | `code_activation` (voucher) | `NothingResponse` |

### 4.6 Favoris (dossiers)

| # | Méthode | Chemin | Hôte | Corps | Réponse |
|---|---|---|---|---|---|
| 35 | POST | `/services/V4.1/folderPut.php` | WRITE | multipart `json` | `FavoriteFolderResponse` |
| 36 | POST | `/services/V4.1/folderPatch.php` | WRITE | multipart `json` | `FavoriteFolderResponse` |
| 37 | POST | `/services/V4.1/folderDelete.php` | WRITE | multipart `json` | `FavoriteFolderResponse` |
| 38 | POST | `/services/V4.1/lieuPatchFolder.php` | WRITE | multipart `json` (synchro dossiers) | `FavoriteFolderResponse` |

### 4.7 Abonnement (Premium / Pro)

| # | Méthode | Chemin | Hôte | Corps / Params | Réponse |
|---|---|---|---|---|---|
| 39 | GET | `/services/V4.1/proGet.php` | REQUEST | — | `CheckSubscriptionResponse` |
| 40 | GET | `/api/user/subscription/last` | REQUEST (V2) | — | `SubscriptionDto` |
| 41 | DELETE | `/api/user/subscription` | REQUEST (V2) | (annulation) | `SubscriptionDto` |
| 42 | POST | `/api/android/purchase/p4nplus` | WRITE (V2) | query `id_device` + corps = token d'achat (string) | `NothingResponse` |

> #42 : l'endpoint choisi dépend de la plateforme (`android/purchase/p4nplus` ou `apple/purchase/p4nplus`).

### 4.8bis ⭐ Mode hors-ligne — export complet d'une zone en 1 téléchargement

Le mode hors-ligne permet de récupérer **toute la base de lieux d'une région/pays** sans pagination.

**Étape 1 — lister les zones** (`getOfflineConfig`) :
```
POST https://park4night.com/services/offline/V3/map/config.json?{context}
→ { ios_gps:[…], app_config:{…}, zones: ZoneDto[] }
```
`ZoneDto` = `{ id, nom, accuracy, N, E, S, W, Size }` — `id` textuel (ex. `weast_europe`), bounding box géographique.
**24 zones** couvrent le monde : `base_map`, `weast_europe`, `north_europe`, `south_europe`, `east_europe`,
`south_east_europe`, `espagne_portugal`, `espagne_portugal_maroc`, `reunion_mauritius`, `United_kingdom_Eire`,
`island`, `new_zeland`, `australie`, `alaska`, `canada`, `quebec`, `usa`, `center_america`,
`north_southamerica`, `south_southamerica`, `russie_mongolie`, `weast_africa`, `south_africa`, `south_east_europ_plus`.

**Étape 2 — obtenir l'URL du zip** (`getMapConfig`) :
```
POST https://park4night.com/services/offline/V3/bdd/index.php?map={zoneId}&{context}
→ { "status":"OK", "name":"weast_europe.zip", "size":463…, "url":"https://cdn7.park4night.com/offline/V3/bdd/fichier/weast_europe.zip" }
```
> L'URL suit le motif direct : `https://cdn7.park4night.com/offline/V3/bdd/fichier/{zoneId}.zip`.

**Étape 3 — télécharger & décompresser** le `.zip` (aucune auth requise) :
- `lieux1.json`, `lieux2.json`… → `{ status, lieux: PlaceDto[] }` (mêmes champs que §5)
- `commentaires1.json`… → `{ status, commentaires: ReviewDto[] }`

Exemple mesuré : `island.zip` = 1,5 Mo → **964 lieux + 9 227 avis**. Tailles indicatives : Europe de l'Ouest ≈ 460 Mo,
Europe du Sud ≈ 750 Mo, `base_map` ≈ 810 Mo, UK+Irlande ≈ 44 Mo, Espagne+Portugal ≈ 150 Mo.

C'est **la** méthode pour un export massif : 1 requête (config) + 1 téléchargement par zone, vs. pagination 50 par 50 de `lieuxGetAroundMe`.

### 4.8 Configuration & divers

| # | Méthode | Chemin | Hôte | Params | Réponse |
|---|---|---|---|---|---|
| 43 | GET | `/services/V4.1/pubService.php` | **PUB** | `mode` | `AdResponse` |
| 44 | GET | `/services/menu_dynamique/V1/config_menu.php` | **PUB** (CUSTOM) | — | `MenuResponse` |
| 45 | POST | `/services/offline/V3/map/config.json` | P4N (CUSTOM) | — | `OfflineConfigResponse` |
| 46 | POST | `/services/offline/V3/bdd/index.php` | P4N (CUSTOM) | `map` | `MapConfigDto` |
| 47 | POST | `/services/V4.1/log.php` | DEFAULT | multipart `json` = `{message, version, stack}` | `NothingResponse` |
| 48 | POST | `/services/V4.1/warning.php` | DEFAULT | multipart `json` = `{subject, message, version, stack}` | `NothingResponse` |

---

## 5. Modèles de données (réponses)

Toutes les réponses de type « liste » sont enveloppées : `{ "status": "...", "<clé>": [...] }`. `kotlinx.serialization` ignore les champs inconnus.

### Enveloppes

```typescript
interface PlaceResponse        { status: string; lieux: PlaceDto[]; }
interface PlaceCustomResponse  { status: string; lieux: PlaceDto[]; options?: { center: string }; }
interface PlaceInfoResponse    { status: string; list_btn_action: ButtonActionDto[]; popup?: PlacePopup[]; pub_np?: AdDto; }
interface ReviewsResponse      { status: string; commentaires: ReviewDto[]; }
interface PhotosResponse       { status: string; p4n_photos: PhotoDto[]; }
interface UserResponse         { status: string; results: UserDto; }
interface UserProfileResponse  { status: string; results: UserProfileDto; }
interface GeocodingResponse    { status: string; results: GeoPlace[]; }
interface FavoriteFolderResponse { status: string; folders: FavoriteFolderDto[]; }
interface AdResponse           { statut: string; ads: AdDto[]; }
interface MenuResponse         { statut: string; menu: MenuLinksDto[]; popup_launch_app?: PlacePopup[]; custom_places?: CustomPlaceInfo[]; }
interface AddPlaceResponse     { status: string; id: string; }              // id = placeId créé
interface CheckSubscriptionResponse { status: string; isPub: boolean; isPubDetail: boolean; isPro: boolean; id_device: string; p4n_mensuel_subscription: boolean; p4n_annual_subscription: boolean; date_fin: string; }
interface TranslateReviewResponse   { status: string; translation: string; langue: string; }
interface TokenResponse        { token: string; }
interface NothingResponse      { status: string; }
interface OfflineConfigResponse{ ios_gps: IosGpsDto[]; app_config: AppFeaturesDto; zones: ZoneDto[]; }
```

### `PlaceDto` (lieu — 69 champs)

```typescript
interface PlaceDto {
  id: string;
  latitude: string;            // "lat" côté Kotlin, clé JSON = latitude
  longitude: string;
  titre?: string;              // title
  name?: string;
  description_fr?: string;
  description_en?: string;
  description_de?: string;
  description_es?: string;
  description_it?: string;
  description_nl?: string;
  date_creation?: string;
  reseaux?: string;
  date_fermeture?: string;     // openingHours
  borne?: string;              // terminal (borne services)
  prix_stationnement?: string; // parkingPrice
  prix_services?: string;      // servicesPrice
  nb_places?: string;          // parkingSpotCount
  hauteur_limite?: string;     // entranceHeightLimit
  route?: string;              // street
  ville?: string;              // city
  code_postal?: string;        // zipcode
  pays?: string;               // country
  pays_iso?: string;           // countryIso
  publique: string;            // isPublic ("0"/"1")
  nature_protect: string;      // isNatureProtect (zone protégée)
  contact_visible?: string;    // hasContactsInfoVisible
  top_liste: string;           // isOnTopOfTheList
  site_internet?: string;      // website
  video?: string;
  tel: string;                 // phone
  mail: string;
  note_moyenne?: string;       // averageRating
  nb_commentaires?: string;    // reviewCount
  nb_visites?: string;         // visiteCount
  nb_photos?: string;          // photoCount
  validation_admin?: string;   // isValidatedByAdmin
  // équipements / services (généralement "0"/"1") :
  caravaneige?: string; animaux?: string; point_eau?: string; eau_noire?: string;
  eau_usee?: string; wc_public?: string; poubelle?: string; douche?: string;
  boulangerie?: string; electricite?: string; wifi?: string; piscine?: string;
  laverie?: string; gaz?: string; gpl?: string; donnees_mobile?: string; lavage?: string;
  // activités :
  visites?: string; windsurf?: string; vtt?: string; rando?: string; escalade?: string;
  eaux_vives?: string; peche?: string; peche_pied?: string; moto?: string;
  online_booking?: boolean;
  point_de_vue?: string; baignade?: string; jeux_enfants?: string;
  code?: string;               // type — code PlaceType (voir §6)
  utilisateur_creation?: string; // creatorUsername
  user_id?: string;            // creatorId
  user_vehicule?: string;      // creatorVehicle
  photos?: PhotoDto[];
  comments_available?: string; // isReviewsActive
}
```

### Autres DTO

```typescript
interface PhotoDto {           // clé enveloppe: p4n_photos
  id: string;
  revision?: string;
  numero?: string;             // count
  p4n_user_id?: string;        // authorId
  link_large?: string;         // link
  link_thumb?: string;         // linkThumbnail
}

interface ReviewDto {          // clé enveloppe: commentaires
  id?: string;
  pn_lieu_id?: string;         // placeId
  note?: string;               // rating (0..5)
  commentaire?: string;        // reviewText
  user_id?: string;
  uuid?: string;               // pseudo auteur
  user_vehicule?: string;
  type_vehicule?: string;
  date_creation?: string;
  url_web?: string; url_facebook?: string; url_instagram?: string;
  url_twitter?: string; url_youtube?: string;
  code?: string;               // placeType
  pays_iso?: string;
  title?: string;              // placeTitle
}

interface UserDto {            // clé enveloppe: results
  id: string;
  uuid: string;                // pseudo
  motdepasse?: string;         // hash SHA-256
  statut?: string;
  date_modification?: string;
  derniere_utilisation?: string;
  date_creation?: string;
  partenaires?: string;
  newsletter?: number;
  signale?: string;
  nb_creation?: string;
  nb_commentaire?: string;
  nb_visite?: string;
  type_vehicule?: string;
  langue_id?: string;
  locale?: string;
  langue_locale?: string;
  pays_locale?: string;
  abo_annuel_date_fin?: string;    // fin abonnement annuel
  abo_mensuel_date_fin?: string;   // fin abonnement mensuel
  url_facebook?: string; url_instagram?: string; url_twitter?: string;
  url_web?: string; url_whatsapp?: string; url_youtube?: string;
  external_id?: string;
}

interface UserProfileDto {     // profil public (results)
  id: string; uuid: string; statut?: string;
  date_modification?: string; derniere_utilisation?: string; date_creation?: string;
  nb_creation?: string; nb_commentaire?: string; type_vehicule?: string;
  abo_annuel_date_fin?: string; abo_mensuel_date_fin?: string;
  url_facebook?: string; url_instagram?: string; url_twitter?: string;
  url_web?: string; url_whatsapp?: string; url_youtube?: string;
}

interface AdDto {              // publicité
  id: string;
  url?: string;                // imageUrl
  type?: string;
  redirect?: string;           // link
  height?: number; width?: number; position?: number;
  click?: string;              // clickCountLink
}

interface ButtonActionDto {
  id?: string; text?: string; label?: string; redirect?: string;
  text_color?: string; subtitle?: string; bg_color?: string; border_color?: string;
  popup_title?: string; subtitle_right?: string; subtitle_color?: string;
  picto?: string; sub_btn_action?: ButtonActionDto[];
}

interface FavoriteFolderDto {
  id: string; size_max?: number; name?: string;
  id_lieux?: string;           // ids des lieux (placesIds)
}

interface GeoPlace { lat: number; lng: number; name: string; }

interface SubscriptionDto {
  id: number; plan?: string; amountCents?: number; currency?: string;
  autoRenew: boolean; provider?: string; providerSubscriptionID?: string;
  startDate?: string; endDate?: string; lastPaymentDate?: string;
}

interface PrivacyDto  { version?: string; text?: string; legacy?: string; privacy?: string; }
interface MapConfigDto{ name: string; url: string; }
interface MenuLinksDto{ id: string; pro?: string; nom?: string; sousTitre?: string; lien?: string; redirect?: string; icone?: string; iconeSelected?: string; target?: string; }
interface PlacePopup  { text: string; icon_url?: string; title: string; show: string; }
interface CustomPlaceInfo { label: string; code: string; }
interface ZoneDto     { id: string; nom: string; accuracy: number; N: number; /* +bornes lat/lon */ }
interface IosGpsDto   { pro: string; id: string; nom: string; protocole: string; canOpen: string; }
interface AppFeaturesDto { showPinsAV: boolean; switchMapListeAuto: boolean; userRatingPopup: boolean; }
interface LegacyErrorMessage { status: string; message: string; }  // format d'erreur legacy
interface ErrorMessage { message: string; }
```

---

## 6. Énumérations

### `PlaceType` — champ `code` / paramètre `types`

| Code | Constante | Signification |
|---|---|---|
| `C` | CAMPING | Camping |
| `ACC_P` | AIRE_CAMPING_CAR_PAYANTE | Aire camping-car payante |
| `ACC_G` | AIRE_CAMPING_CAR_GRATUITE | Aire camping-car gratuite |
| `ACC_PR` | AIRE_CAMPING_CAR_PRIVEE | Aire camping-car privée |
| `PN` | AIRE_PLEINE_NATURE | Aire pleine nature |
| `APN` | AIRE_PICNIC | Aire de pique-nique |
| `AR` | AIRE_AUTOROUTE | Aire d'autoroute |
| `ASS` | AIRE_STATIONNEMENT_SANS_STAT | Stationnement sans services |
| `DS` | EXTRAS_SERVICE | Point de services / extras |
| `EP` | ENTRE_PARTICULIER | Entre particuliers |
| `OR` | OFF_ROAD | Off-road |
| `F` | FERME | Fermé |
| `P` | PARKING | Parking |
| `PSS` | PARKING_SANS_SERVICES | Parking sans services |
| `PJ` | DAY_PARKING | Parking de jour |
| `` (vide) | CUSTOM | Personnalisé |

### Activités — paramètre `activites` (codes = nom en minuscules, séparés par `-`)

`jeux_enfants`, `point_de_vue`, `baignade`, `escalade`, `eaux_vives`, `peche`, `peche_pied`, `rando`, `visites`, `vtt`, `windsurf`, `moto`

### Services — paramètre `services` (codes = nom en minuscules, séparés par `-`)

`electricite`, `point_eau`, `eau_noire`, `eau_usee`, `poubelle`, `boulangerie`, `wc_public`, `douche`, `wifi`, `caravaneige`, `animaux`, `piscine`, `laverie`, `gpl`, `gaz`, `donnees_mobile`, `lavage`

### Filtre note — paramètre `note`

| Valeur | Signification |
|---|---|
| `4.75` | ≥ 4,75 ★ |
| `4` | ≥ 4 ★ |
| `3` | ≥ 3 ★ |

### ApiType (interne) : `LEGACY` · `V2` · `CUSTOM` — voir §1

---

## 7. Gestion des erreurs

Le client Ktol intercepte et normalise les erreurs (`com.park4night.p4nsharedlayers.data.f.call`) :

- **HTTP non-2xx** → `ResultWrapper.Error.Http(code, body: LegacyErrorMessage?)`.
- **Corps `LegacyErrorMessage`** avec `status` contenant `warning` → traité comme succès partiel (le message est remonté en commentaire).
- **`status` contenant `error`** ou `"Do not find this user"` → erreur.
- Timeout → `« Network error : Your connection seems too low »`.
- IOException → `« Network error : check your connection »`.

Format d'erreur type :
```json
{ "status": "error", "message": "Description de l'erreur" }
```

---

## 8. Notes techniques

- **Toutes les valeurs de `PlaceDto` sont des strings** (y compris booléens « 0 »/« 1 » et nombres) — l'API PHP historique renvoie du texte.
- Les endpoints `.php?` gardent le `?` final : les params sont ajoutés derrière (`…php?id=X&context_user=…`).
- `appli=park4night` est ajouté sur `getPlace`, `commGet` (place & user).
- L'app envoie **systématiquement** la position GPS (`context_latitude`/`longitude`) et la langue.
- Les logs Ktor sont en `LogLevel.BODY` : un simple proxy (mitmproxy/Charles) suffit à observer tout le trafic en clair (HTTPS).
- Pas de certificate pinning détecté dans la couche partagée.

---

*Généré par reverse-engineering statique (jadx) — park4night 7.1.60. Voir `park4night_API.postman_collection.json` pour tester.*
