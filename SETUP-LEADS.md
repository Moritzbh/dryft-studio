# Lead Magnet Backend — Setup-Anleitung

> 5 Minuten. Drei Schritte. Danach funktioniert das Formular auf der Homepage und du siehst alle Anfragen unter `/admin`.

## Was du gebaut hast

- **Public Form** (`index.html`) → POST an `/api/leads`
- **Serverless Function** (`api/leads.js`) → speichert in Upstash Redis
- **Admin Dashboard** (`admin/index.html`) → zeigt alle Leads, Statusmanagement, Copy-to-Clipboard, WhatsApp-Quick-Open
- **Auth:** Bearer-Token via `ADMIN_TOKEN` env var

## Schritt 1 — Upstash Redis Datenbank anlegen

1. Geh auf [console.upstash.com](https://console.upstash.com) → mit GitHub einloggen (kostenlos)
2. **Create Database** → Name: `bbbrands-leads` → Region: `eu-central-1` (Frankfurt) → **Free Plan**
3. Auf der Detailseite der DB findest du unten unter **REST API** zwei Werte:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

Das war's. Free Plan = 10 000 Commands/Tag — locker mehr als genug.

> **Alternative:** Wenn du das lieber direkt in Vercel klickst → Vercel-Dashboard → Storage → Marketplace → Upstash auswählen → der Connector spritzt dir die env vars automatisch ins Projekt. Spart Schritt 2.

## Schritt 2 — Env Vars in Vercel setzen

Vercel-Projekt öffnen → **Settings** → **Environment Variables** → drei Werte anlegen (alle drei Environments anhaken: Production, Preview, Development):

| Name | Wert | Woher |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` | `https://eu1-...upstash.io` | aus Schritt 1 |
| `UPSTASH_REDIS_REST_TOKEN` | `AX1...` | aus Schritt 1 |
| `ADMIN_TOKEN` | _selbst gewähltes Passwort_ | min. 24 Zeichen, generieren z.B. via `openssl rand -hex 24` |

**Wichtig:** Den `ADMIN_TOKEN` sicher speichern (Bitwarden, 1Password). Damit loggst du dich später unter `/admin` ein.

## Schritt 3 — Deployen

```bash
git add .
git commit -m "feat: lead magnet backend + admin dashboard"
git push
```

Vercel deployt automatisch. Sobald der Build grün ist:

- **Form testen:** Auf der Homepage runter zur Style-Guide-Section, Formular ausfüllen, abschicken → Success-Screen
- **Lead checken:** Auf `https://bb-brands.de/admin` (oder deiner Vercel-URL) → Admin-Token eingeben → der Lead steht da

## Wie der Workflow im Alltag aussieht

1. **Push-Notification:** Optional kannst du in Vercel → Integrations einen Slack/Discord-Webhook einrichten, der bei jedem `/api/leads` POST anschlägt. Oder du checkst `/admin` 1×/Tag.
2. **Lead bearbeiten:** Im Dashboard auf "In Arbeit" klicken, sobald du startest. Auf "Versendet" wenn raus.
3. **Direkt-Aktionen:** E-Mail/Telefon mit einem Klick kopieren. Bei WhatsApp-Versand öffnet "Auf WhatsApp öffnen" direkt den Chat (`wa.me/...`).
4. **Filter:** Oben Toolbar → "Neu" zeigt nur unbearbeitete. Suchfeld nach Name/Firma/Mail.

## API-Referenz (intern)

Falls du das Backend mal mit anderen Tools (Zapier, Make, n8n) ansprechen willst:

```bash
# Lead anlegen (kein Auth)
curl -X POST https://bb-brands.de/api/leads \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Max Mustermann",
    "company": "Muster GmbH",
    "website": "https://muster.de",
    "email": "max@muster.de",
    "phone": "+49 170 1234567",
    "delivery": "whatsapp"
  }'

# Alle Leads holen (Admin-Token nötig)
curl https://bb-brands.de/api/leads \
  -H "Authorization: Bearer DEIN_ADMIN_TOKEN"

# Status updaten
curl -X PATCH https://bb-brands.de/api/leads \
  -H "Authorization: Bearer DEIN_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id": "...", "status": "delivered"}'

# Lead löschen
curl -X DELETE https://bb-brands.de/api/leads \
  -H "Authorization: Bearer DEIN_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id": "..."}'
```

## Sicherheit & Datenschutz

- **Bot-Schutz:** Honeypot-Feld `_gotcha` blockiert die meisten Spam-Bots stillschweigend
- **Validation:** E-Mail- und URL-Format werden serverseitig geprüft, alle Felder auf max. 500 Zeichen begrenzt
- **Auth:** Admin-Endpunkte (GET/PATCH/DELETE) brauchen den Bearer-Token, ohne den kommt 401
- **Headers:** `/admin` und `/api` sind via `vercel.json` mit `X-Robots-Tag: noindex` und `Cache-Control: no-store` versehen — kein Indexing, kein Caching
- **DSGVO:** Du speicherst Name + Firma + Webseite + Mail + (optional) Telefon + IP + User-Agent. Trag das in deine **Datenschutzerklärung** ein. Vorschlag: "Beim Anfordern unseres kostenlosen Brand Style Guides verarbeiten wir die von dir freiwillig angegebenen Kontaktdaten zur einmaligen Erstellung und Auslieferung des Style Guides. Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO. Speicherdauer: bis zur Auslieferung + 6 Monate für Nachfragen."
- **Lead-Löschung auf Anfrage:** Im Dashboard → "Löschen" klicken → ist sofort weg.

## Troubleshooting

| Problem | Lösung |
|---|---|
| `Redis not configured` im Vercel-Log | Env vars nicht gesetzt oder Deploy nicht neu gemacht. Nach Env-Änderung **Redeploy** triggern (Deployments → ⋯ → Redeploy) |
| Admin-Login schlägt mit "Falsches Token" fehl | `ADMIN_TOKEN` env var prüfen — keine Spaces drumherum, nach Änderung redeployen |
| Form gibt 400 zurück | Validation-Fehler — alle Pflichtfelder ausgefüllt? E-Mail valides Format? Bei WhatsApp-Versand: Phone gesetzt? |
| Form gibt 500 zurück | Vercel-Function-Logs prüfen (`vercel logs` oder Dashboard → Functions → leads) |
| Leads kommen nicht im Dashboard an | Browser DevTools → Network → POST `/api/leads` → Response checken. Wenn 200, dann GET `/api/leads` mit Auth checken (Token korrekt?) |

## Was als nächstes sinnvoll wäre

- **Slack/Discord Notification** bei neuem Lead — neuer kleiner Endpoint oder Vercel-Webhook
- **CSV-Export** im Dashboard — 10 Zeilen Code
- **Auto-E-Mail Bestätigung** an den Lead — Resend.com API, kostenlos bis 100 Mails/Tag
- **Captcha** falls Spam-Bots durchkommen — hCaptcha oder Cloudflare Turnstile (gratis)
