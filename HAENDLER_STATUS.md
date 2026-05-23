# Händler-Status & Optimierungsübersicht
Stand: 2026-05-23

---

## Alle 14 Händler – Was zu tun ist

| ID | Firma | ★ | Bew. | Webseite | E-Mail | Priorität | Was tun |
|----|-------|---|------|----------|--------|-----------|---------|
| 1 | Isar Rollrasen | 4.9 | 118 | isar-rollrasen.de | info@isar-rollrasen.de | 🔴 Hoch | Profilseite anlegen, Video drehen, Pro-Paket anbieten |
| 2 | Wolf Gruen | 5.0 | 13 | ? prüfen | wolf@wolf-gruen.de | 🔴 Hoch | Mehr Bewertungen aufbauen, Webseite prüfen, Partner-Paket |
| 3 | Rasen Schwab GmbH | 5.0 | 3 | ? prüfen | ✗ fehlt | 🟡 Mittel | E-Mail beschaffen, Bewertungsbasis aufbauen |
| 4 | Schwab Rollrasen GmbH | 4.7 | 33 | schwab-rollrasen.de | info@schwab-rollrasen.de | 🔴 Hoch | Video drehen, Pro-Paket anbieten |
| 5 | BayernRasen | 4.6 | 65 | bayernrasen.de | info@bayernrasen.de | 🔴 Hoch | Profilseite anlegen, Pro-Paket anbieten |
| 6 | Sued-Rasen GmbH | 4.5 | 116 | sued-rasen.de | info@sued-rasen.de | 🔴 Hoch | Profilseite + Video, Premium-Paket |
| 7 | Walter Schwab GmbH | — | — | ? prüfen | ✗ fehlt | 🟡 Mittel | E-Mail beschaffen, Google Business prüfen |
| 8 | Noris Rollrasen (Konrad Städtler) | — | — | konrad-staedtler.de | info@konrad-staedtler.de | 🟡 Mittel | Google Business anlegen, Bewertungen aufbauen |
| 9 | Spiegl Gartenbau GmbH | — | — | ? prüfen | info@spiegl-gartenbau.de | 🟢 Normal | Outreach senden, Google + Webseite prüfen |
| 10 | Greenkeepers Gartenbau GbR | — | — | ? prüfen | info@greenkeepers-gartenbau.de | 🟢 Normal | Outreach senden, Google + Webseite prüfen |
| 11 | Wolfgang Köpsell Rollrasen | — | — | ? prüfen | cobse@t-online.de | 🟡 Mittel | Neue Webseite anbieten (t-online = unprofessionell), Google Business |
| 12 | Gartenbau Schaknat | — | — | ? prüfen | info@gartenbau-schaknat.de | 🟢 Normal | Outreach senden, Google prüfen |
| 13 | Nodes Gartenbau | — | — | ? prüfen | kontakt@nodes-bayern.de | 🟢 Normal | Outreach senden, Google prüfen |
| 14 | BR Rasenzentrum | — | — | ? prüfen | info@br-rasenzentrum.de | 🟢 Normal | Online-Händler, Google Business + Webseite prüfen |

---

## Offene Hausaufgaben

- [ ] Webseiten + Google Business der 9 unbekannten manuell googeln → Status im Admin eintragen
- [ ] E-Mail für Rasen Schwab GmbH (ID 3) und Walter Schwab GmbH (ID 7) recherchieren
- [ ] Outreach-Mailtext finalisieren (Erstentwurf existiert, noch nicht versendet)
- [ ] Outreach an alle 12 Händler mit E-Mail starten
- [ ] Profil-Slugs für Top-6 im Admin eintragen (damit Profilseiten live gehen)
- [ ] Videos bei interessierten Händlern vereinbaren (490 € Einmalgebühr)

---

## Paket-Struktur

| Paket | Preis | Kernleistung |
|-------|-------|-------------|
| Free | 0 € | Grundlisting, PLZ-basiert, kein Badge |
| Partner | 49 €/Mo | ✓ Geprüfter-Händler-Badge, Profilseite, bevorzugte Platzierung |
| Professional | 99 €/Mo | + Video auf Profil, Google Business Optimierung, Anfrage-Statistik |
| Premium | 199 €/Mo | + eigene Webseite, SEO-Monatsreport, Bewertungsmanagement |

**Einmalig:**
- Videoproduktion (2–3 Min. Betriebsfilm): 490 €
- Google Business einrichten & optimieren: 190 €
- Neue Webseite (ohne Premium-Abo): 1.290 €

---

## Technischer Stand (2026-05-23)

### Portal
- URL: https://www.rasenrechner.de (+ Apex-Redirect von rasenrechner.de)
- Admin: https://www.rasenrechner.de/admin · Passwort: rollrasen2025
- Server: Hetzner VPS 88.198.151.84, Node.js + Express, PM2, Nginx, SSL via Let's Encrypt
- DB: SQLite (`rollrasen.db`), Tabellen: `anfragen`, `hersteller`

### Features live
- Preisrechner mit konfigurierbarem Verschnitt
- PLZ-basierte Händlersuche (Top 3 nächste)
- Anfrage-Formular → E-Mail an Händler + Kundenbestätigung
- Admin-Seite: Anfragen + Händler verwalten, Edit-Seite pro Händler
- Individuelle Profilseiten unter `/haendler/:slug` (sobald Slug gesetzt)
- Badge-Anzeige im Formular (Partner/Pro/Premium)
- Impressum + Datenschutz
- Weiterleitungen von rollrasen.gartenbau-kosten.de + gartenbau-kosten.de → rasenrechner.de

### DB-Felder Händler (hersteller-Tabelle)
Basisfelder: `name, typ, strasse, plz, ort, region, telefon, email, website, google_bewertung, google_bewertungen_anzahl, liefergebiet, plz_prefixes, aktiv, partner`

Neue Felder (2026-05-23):
`paket` (free/partner/pro/premium), `paket_start`, `paket_ende`, `video_url`, `profil_slug`, `profil_text`, `logo_url`, `webseite_status`, `google_status`, `kontakt_status`, `notizen_intern`

### Scripts
- `outreach_haendler.py` — Personalisierte Outreach-Mails an alle Händler mit E-Mail
  - Nutzung: `PYTHONUTF8=1 DB_PATH=... SMTP_... python outreach_haendler.py --test --id X`
  - Läuft lokal (IONOS-SMTP blockiert vom Server)
  - Setzt `kontakt_status = 'kontaktiert'` nach Versand

### Cross-Links
- gartenbau-kosten.de `/rasen/rollrasen-kosten/` → Link auf rasenrechner.de (deployed)
- gartenbau-kosten.de `/rasen/rasen-anlegen-kosten/` → Related Link auf rasenrechner.de (deployed)

---

## Deployment-Workflow
```bash
# Lokal
git add . && git commit -m "..." && git push origin master

# Server (automatisch via git push, oder manuell):
ssh root@88.198.151.84 "cd /var/www/rollrasen-portal && git pull && pm2 restart rollrasen-portal"
```
