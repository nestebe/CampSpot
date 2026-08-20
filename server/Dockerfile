# PocketBase + les hooks du dépôt.
# -----------------------------------------------------------------------------
# Les hooks sont COPIÉS DANS L'IMAGE plutôt que montés depuis l'hôte. C'est ce qui
# rend la mise à jour par `git push` réellement automatique sous Coolify :
#
#   Coolify clone le dépôt dans un conteneur helper JETABLE (`/artifacts/<uuid>`,
#   lancé en `--rm`). Un bind relatif `./pb_hooks` du compose est réécrit par
#   Coolify en `/data/coolify/applications/<uuid>/pb_hooks` — un dossier de l'HÔTE
#   qu'il crée VIDE et que le dépôt ne remplit jamais. Les hooks ne seraient donc
#   pas déployés, sans le moindre message d'erreur.
#
# En les baquant dans l'image : `git push` → Coolify rebuild → hooks à jour, et le
# contenu de `/pb_hooks` est exactement celui du commit déployé (reproductible).
#
# ⚠️ L'image de base ne déclare PAS `VOLUME /pb_hooks` — sans quoi un volume anonyme
# masquerait ce COPY au démarrage. À revérifier en cas de changement d'image de base.

ARG PB_VERSION=0.39.6
FROM ghcr.io/muchobien/pocketbase:${PB_VERSION}

# `pb_hooks/` est relatif au contexte de build (= le dossier `server/`).
COPY pb_hooks/ /pb_hooks/
