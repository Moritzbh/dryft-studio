#!/usr/bin/env bash
# ============================================================
# Setup-Script: LEO-Pages in Redis registrieren
# Einmalig ausführen — dann zeigt der Hub die 4 Cards.
#
# Usage:
#   ADMIN_TOKEN=xxx bash _setup-leo.sh
#
# Oder mit anderer Domain (default www.bb-brands.de):
#   ADMIN_TOKEN=xxx HOST=https://www.bb-brands.de bash _setup-leo.sh
# ============================================================

set -e

HOST="${HOST:-https://www.bb-brands.de}"

if [ -z "$ADMIN_TOKEN" ]; then
  echo "❌ ADMIN_TOKEN env-var fehlt"
  exit 1
fi

call() {
  local body="$1"
  curl -s -X POST "$HOST/api/preview-auth" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$body"
  echo
}

echo "→ Phase setzen: brief_plan"
call '{"action":"set-phase","slug":"leo","phase":"brief_plan"}'

echo "→ Card 1/4: Werkvertrag"
call '{
  "action":"add-page",
  "slug":"leo",
  "page":{
    "key":"contract",
    "label":"Werkvertrag",
    "url_path":"vertrag"
  }
}'

echo "→ Card 2/4: Scope-Brief"
call '{
  "action":"add-page",
  "slug":"leo",
  "page":{
    "key":"scope_brief",
    "label":"Scope-Brief",
    "url_path":"scope-brief"
  }
}'

echo "→ Card 3/4: Onboarding"
call '{
  "action":"add-page",
  "slug":"leo",
  "page":{
    "key":"onboarding",
    "label":"Onboarding-Fragebogen",
    "url_path":"onboarding"
  }
}'

echo "→ Card 4/4: Konzept-Store"
call '{
  "action":"add-page",
  "slug":"leo",
  "page":{
    "key":"concept",
    "label":"Konzept-Store",
    "url_path":"konzept/"
  }
}'

echo "✅ LEO-Setup fertig. Hub-URL: $HOST/preview/leo-oppahw/"
