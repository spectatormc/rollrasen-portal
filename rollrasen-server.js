require('dotenv').config({ override: true });
const express    = require('express');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const Database   = require('better-sqlite3');
const nodemailer = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 3002;

// ─── DATENBANK ────────────────────────────────────────────────────────────────

const db = new Database(path.join(__dirname, 'rollrasen.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS anfragen (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,
    email          TEXT NOT NULL,
    phone          TEXT,
    plz            TEXT,
    m2             REAL,
    product        TEXT,
    message        TEXT,
    haendler_count INTEGER,
    haendler_names TEXT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
console.log('✓ Datenbank bereit');

// Sichere Migration: neue Spalten falls noch nicht vorhanden
for (const sql of [
  "ALTER TABLE hersteller ADD COLUMN paket TEXT DEFAULT 'free'",
  "ALTER TABLE hersteller ADD COLUMN paket_start DATE",
  "ALTER TABLE hersteller ADD COLUMN paket_ende DATE",
  "ALTER TABLE hersteller ADD COLUMN video_url TEXT",
  "ALTER TABLE hersteller ADD COLUMN profil_slug TEXT",
  "ALTER TABLE hersteller ADD COLUMN profil_text TEXT",
  "ALTER TABLE hersteller ADD COLUMN logo_url TEXT",
  "ALTER TABLE hersteller ADD COLUMN webseite_status TEXT",
  "ALTER TABLE hersteller ADD COLUMN google_status TEXT",
  "ALTER TABLE hersteller ADD COLUMN kontakt_status TEXT DEFAULT 'offen'",
  "ALTER TABLE hersteller ADD COLUMN notizen_intern TEXT",
]) { try { db.exec(sql); } catch (_) {} }

// Findet die 3 nächsten aktiven Betriebe aus der hersteller-Tabelle.
// Sortierung: ABS(PLZ-Differenz) aufsteigend, Einträge ohne PLZ kommen zuletzt.
function findNearestHaendler(plz) {
  const plzNum = parseInt((plz || '').replace(/\D/g, ''), 10) || 0;
  return db.prepare(`
    SELECT id, name, typ, strasse, plz, ort, region,
           telefon, email, website, google_bewertung, google_bewertungen_anzahl,
           paket, profil_slug
    FROM   hersteller
    WHERE  aktiv = 1
    ORDER BY CASE WHEN plz IS NULL OR plz = '' THEN 99999
                  ELSE ABS(CAST(plz AS INTEGER) - ?)
             END ASC
    LIMIT 3
  `).all(plzNum);
}

// ─── E-MAIL ───────────────────────────────────────────────────────────────────

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || null;
const SMTP_HOST   = process.env.SMTP_HOST   || null;
const SMTP_USER   = process.env.SMTP_USER   || null;
const SMTP_PASS   = process.env.SMTP_PASS   || null;
const SMTP_PORT   = parseInt(process.env.SMTP_PORT || '587');

let transporter = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  console.log('✓ E-Mail konfiguriert (' + SMTP_HOST + ')');
} else {
  console.warn('⚠️  SMTP nicht konfiguriert – E-Mails werden nur geloggt');
}

async function sendMail(to, subject, html) {
  if (!transporter) {
    console.log(`[MAIL] An: ${to}\nBetreff: ${subject}\n${html.replace(/<[^>]+>/g,'')}\n`);
    return;
  }
  await transporter.sendMail({ from: SMTP_USER, to, subject, html });
}

const PRODUKT_LABELS = {
  premium:     'Premium-Fertigrasen (9,00 €/m²)',
  halbschatten:'Halbschattenrasen (8,50 €/m²)',
  sport:       'Sportrasen (6,50 €/m²)',
  spielrasen:  'Spielwiese / Landschaftsrasen (5,50 €/m²)',
};

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Erzeugt einen HTML-Block mit den Kontaktdaten eines Betriebs
function haendlerKontaktHtml(h, stripe) {
  const bg = stripe ? 'background:#f7f9f5' : 'background:#fff';
  const adresse = [h.strasse, h.plz && h.ort ? `${h.plz} ${h.ort}` : h.ort].filter(Boolean).join(', ');
  const sterne  = h.google_bewertung
    ? `<span style="color:#f59e0b">★</span> ${h.google_bewertung.toFixed(1)} (${h.google_bewertungen_anzahl} Bewertungen)`
    : '';

  return `
    <tr style="${bg}">
      <td style="padding:14px 16px;vertical-align:top;border-bottom:1px solid #e8f0e8">
        <strong style="color:#1a3d1a;font-size:1rem">${h.name}</strong>
        ${h.typ === 'Hersteller' ? '<span style="font-size:0.75rem;background:#2d6a2d;color:#fff;border-radius:3px;padding:1px 6px;margin-left:6px;vertical-align:middle">Hersteller</span>' : ''}
        ${sterne ? `<br><small style="color:#888">${sterne}</small>` : ''}
        ${adresse ? `<br><small style="color:#666;margin-top:4px;display:block">${adresse}</small>` : ''}
        <div style="margin-top:8px;line-height:1.8">
          ${h.telefon ? `<a href="tel:${h.telefon.replace(/\s/g,'')}" style="color:#2d6a2d;text-decoration:none">📞 ${h.telefon}</a><br>` : ''}
          ${h.email    ? `<a href="mailto:${h.email}" style="color:#2d6a2d;text-decoration:none">✉️ ${h.email}</a><br>` : ''}
          ${h.website  ? `<a href="${h.website}" style="color:#2d6a2d;text-decoration:none" target="_blank">🌐 ${h.website.replace(/^https?:\/\//,'')}</a>` : ''}
        </div>
      </td>
    </tr>`;
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────

app.use(cors({ origin: ['https://www.rasenrechner.de', 'https://rasenrechner.de'] }));
app.use(express.json());

const anfrageLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: { error: 'Zu viele Anfragen. Bitte in 15 Minuten erneut versuchen.' } });
const partnerLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 3, message: { error: 'Zu viele Anfragen. Bitte später erneut versuchen.' } });
app.use('/public', express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.redirect(301, '/bayern/'));
app.get('/bayern/', (req, res) => res.sendFile(path.join(__dirname, 'rollrasen-portal.html')));
app.get('/bayern', (req, res) => res.redirect(301, '/bayern/'));

// ─── IMPRESSUM / DATENSCHUTZ ──────────────────────────────────────────────────

const pageCss = `<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;font-size:1rem;line-height:1.7;color:#222;background:#fafaf8}
  .wrap{max-width:760px;margin:0 auto;padding:3rem 1.5rem 5rem}
  h1{font-size:1.8rem;color:#1a3d12;margin-bottom:2rem;padding-bottom:.75rem;border-bottom:2px solid #d4e8c8}
  h2{font-size:1.1rem;color:#2d6a2d;margin:2rem 0 .5rem}
  p,li{color:#444;margin-bottom:.6rem}
  ul{padding-left:1.25rem;margin-bottom:.6rem}
  a{color:#2d6a2d}
  .back{display:inline-block;margin-bottom:2rem;color:#2d6a2d;text-decoration:none;font-size:.9rem}
  .back:hover{text-decoration:underline}
  footer{text-align:center;font-size:.78rem;color:#999;margin-top:3rem;padding-top:1rem;border-top:1px solid #e0e8e0}
</style>`;

app.get('/impressum', (req, res) => res.send(`<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Impressum – rasenrechner.de</title>${pageCss}</head><body>
<div class="wrap">
  <a class="back" href="/bayern/">← Zurück zur Startseite</a>
  <h1>Impressum</h1>
  <h2>Angaben gemäß § 5 TMG</h2>
  <p><strong>Gartenschmiede GmbH</strong><br>
  Ortsstr. 7<br>85354 Freising-Hohenbachern</p>
  <h2>Vertreten durch</h2>
  <p>Bastian Rohrhuber, Marco Holmer</p>
  <h2>Kontakt</h2>
  <p>E-Mail: <a href="mailto:info@gartenbau-kosten.de">info@gartenbau-kosten.de</a></p>
  <h2>Registereintrag</h2>
  <p>Amtsgericht München, HRB 239683</p>
  <h2>Umsatzsteuer-ID</h2>
  <p>DE316910542</p>
  <h2>Inhaltlich Verantwortlicher</h2>
  <p>Bastian Rohrhuber (Anschrift wie oben)</p>
  <footer>rasenrechner.de · Ein Service der Gartenschmiede GmbH ·
    <a href="/impressum">Impressum</a> · <a href="/datenschutz">Datenschutz</a>
  </footer>
</div></body></html>`));

app.get('/datenschutz', (req, res) => res.send(`<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Datenschutz – rasenrechner.de</title>${pageCss}</head><body>
<div class="wrap">
  <a class="back" href="/bayern/">← Zurück zur Startseite</a>
  <h1>Datenschutzerklärung</h1>

  <h2>1. Verantwortlicher</h2>
  <p>Gartenschmiede GmbH, Ortsstr. 7, 85354 Freising-Hohenbachern<br>
  E-Mail: <a href="mailto:info@gartenbau-kosten.de">info@gartenbau-kosten.de</a></p>

  <h2>2. Welche Daten wir erheben</h2>
  <p>Wenn Sie über unser Kontaktformular eine Anfrage stellen, erheben wir:</p>
  <ul>
    <li>Name</li>
    <li>E-Mail-Adresse</li>
    <li>Telefonnummer (optional)</li>
    <li>Postleitzahl</li>
    <li>Angaben zur gewünschten Rasenfläche und Sorte</li>
    <li>Freitextnachricht (optional)</li>
  </ul>

  <h2>3. Zweck und Rechtsgrundlage</h2>
  <p>Die Daten werden ausschließlich zur Vermittlung Ihrer Anfrage an regionale Rollrasen-Händler in Ihrer Nähe verwendet.
  Rechtsgrundlage ist Art. 6 Abs. 1 lit. b DSGVO (Durchführung vorvertraglicher Maßnahmen).</p>

  <h2>4. Weitergabe an Händler</h2>
  <p>Ihre Kontaktdaten (Name, E-Mail, Telefon, PLZ, Anforderungen) werden an bis zu 3 regionale Fachbetriebe
  in Ihrer Nähe übermittelt, damit diese Ihnen ein Angebot unterbreiten können. Die Händler sind
  eigenverantwortliche Datenverantwortliche für die weitere Verarbeitung.</p>

  <h2>5. Speicherdauer</h2>
  <p>Ihre Anfragedaten werden für maximal 12 Monate gespeichert und anschließend gelöscht,
  sofern keine gesetzlichen Aufbewahrungspflichten entgegenstehen.</p>

  <h2>6. Cookies und Tracking</h2>
  <p>Diese Website verwendet keine Tracking-Cookies und kein Web-Analytics. Es werden keine
  Daten an Werbenetzwerke oder Drittanbieter übermittelt.</p>

  <h2>7. Ihre Rechte</h2>
  <p>Sie haben jederzeit das Recht auf Auskunft, Berichtigung, Löschung und Einschränkung der
  Verarbeitung Ihrer personenbezogenen Daten sowie das Recht auf Datenübertragbarkeit.
  Wenden Sie sich dazu an: <a href="mailto:info@gartenbau-kosten.de">info@gartenbau-kosten.de</a></p>

  <h2>8. Beschwerderecht</h2>
  <p>Sie haben das Recht, sich bei einer Datenschutzaufsichtsbehörde zu beschweren.
  Zuständig ist das Bayerische Landesamt für Datenschutzaufsicht (BayLDA).</p>

  <footer>rasenrechner.de · Ein Service der Gartenschmiede GmbH ·
    <a href="/impressum">Impressum</a> · <a href="/datenschutz">Datenschutz</a>
  </footer>
</div></body></html>`));

// ─── HÄNDLER PROFILSEITE ──────────────────────────────────────────────────────

const BADGE_HTML = {
  partner: '<span style="display:inline-flex;align-items:center;gap:6px;background:#dcfce7;color:#166534;border:1px solid #86efac;border-radius:20px;padding:4px 14px;font-size:0.82rem;font-weight:700">✓ Geprüfter Händler</span>',
  pro:     '<span style="display:inline-flex;align-items:center;gap:6px;background:#dbeafe;color:#1e40af;border:1px solid #93c5fd;border-radius:20px;padding:4px 14px;font-size:0.82rem;font-weight:700">⭐ Professional Partner</span>',
  premium: '<span style="display:inline-flex;align-items:center;gap:6px;background:#fef9c3;color:#854d0e;border:1px solid #fcd34d;border-radius:20px;padding:4px 14px;font-size:0.82rem;font-weight:700">🏆 Premium Partner</span>',
};

app.get('/haendler/:slug', (req, res) => {
  const h = db.prepare('SELECT * FROM hersteller WHERE profil_slug = ? AND aktiv = 1').get(req.params.slug);
  if (!h) return res.status(404).send(`<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><title>Nicht gefunden</title>${pageCss}</head><body><div class="wrap"><a class="back" href="/">← Startseite</a><h1>Händler nicht gefunden</h1><p>Dieses Profil existiert nicht oder ist nicht mehr aktiv.</p></div></body></html>`);

  const verifiziert = h.kontakt_status === 'abonniert';
  const badge   = BADGE_HTML[h.paket] || '';
  const adresse = [h.strasse, h.plz && h.ort ? `${h.plz} ${h.ort}` : h.ort].filter(Boolean).join(', ');
  const mapsUrl = adresse ? `https://www.google.com/maps/search/${encodeURIComponent(h.name + ' ' + adresse)}` : null;
  const sterne  = h.google_bewertung ? `<span style="color:#f59e0b;font-size:1.1rem">★</span> <strong>${h.google_bewertung.toFixed(1)}</strong> <span style="color:#888;font-size:0.85rem">(${h.google_bewertungen_anzahl} Bewertungen auf Google)</span>` : '';

  const videoBlock = h.video_url ? `
    <div style="margin:2rem 0;border-radius:10px;overflow:hidden;aspect-ratio:16/9;background:#000">
      <iframe src="${h.video_url}" style="width:100%;height:100%;border:none" allowfullscreen loading="lazy"></iframe>
    </div>` : '';

  const unverifiziertBanner = !verifiziert ? `
    <div style="background:#fefce8;border:1px solid #fde047;border-radius:8px;padding:.75rem 1rem;margin-bottom:1.5rem;font-size:.85rem;color:#854d0e;display:flex;align-items:center;gap:.5rem">
      ℹ️ Dieser Betrieb ist noch kein aktiver Partner auf rasenrechner.de. Die Angaben stammen aus öffentlichen Quellen.
    </div>` : '';

  const kontaktBlock = verifiziert
    ? `<div class="contact-card">
      <strong style="color:#1a3d12;font-size:.85rem;text-transform:uppercase;letter-spacing:.05em">Kontakt</strong>
      ${h.telefon ? `<div class="contact-row">📞 <a href="tel:${h.telefon.replace(/\s/g,'')}">${h.telefon}</a></div>` : ''}
      ${h.email   ? `<div class="contact-row">✉️ <a href="mailto:${h.email}">${h.email}</a></div>` : ''}
      ${h.website ? `<div class="contact-row">🌐 <a href="${h.website}" target="_blank" rel="noopener">${h.website.replace(/^https?:\/\//,'')}</a></div>` : ''}
      ${adresse   ? `<div class="contact-row">📍 ${adresse}</div>` : ''}
      ${mapsUrl   ? `<a class="maps-link" href="${mapsUrl}" target="_blank" rel="noopener">🗺️ Auf Google Maps anzeigen →</a>` : ''}
    </div>`
    : `<div class="contact-card">
      <strong style="color:#1a3d12;font-size:.85rem;text-transform:uppercase;letter-spacing:.05em">Kontakt</strong>
      ${h.telefon ? `<div class="contact-row">📞 <a href="tel:${h.telefon.replace(/\s/g,'')}">${h.telefon}</a></div>` : ''}
      ${h.website ? `<div class="contact-row">🌐 <a href="${h.website}" target="_blank" rel="noopener">${h.website.replace(/^https?:\/\//,'')}</a></div>` : ''}
      ${adresse   ? `<div class="contact-row">📍 ${adresse}</div>` : ''}
      ${mapsUrl   ? `<a class="maps-link" href="${mapsUrl}" target="_blank" rel="noopener">🗺️ Auf Google Maps anzeigen →</a>` : ''}
    </div>`;

  const ctaBlock = verifiziert
    ? `<div class="cta-block" id="direktanfrage">
      <h2>Direkt anfragen bei ${h.name}</h2>
      <p style="opacity:.85;font-size:.9rem;margin:0 0 1.25rem">Nur dieser Betrieb erhält Ihre Anfrage – unverbindlich</p>
      <form id="direktForm" style="text-align:left;display:flex;flex-direction:column;gap:.75rem">
        <input type="hidden" name="haendler_id" value="${h.id}">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
          <input name="name" placeholder="Ihr Name *" required style="padding:.65rem .85rem;border:none;border-radius:6px;font-size:.93rem;width:100%;box-sizing:border-box">
          <input name="email" type="email" placeholder="E-Mail *" required style="padding:.65rem .85rem;border:none;border-radius:6px;font-size:.93rem;width:100%;box-sizing:border-box">
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
          <input name="phone" type="tel" placeholder="Telefon (optional)" style="padding:.65rem .85rem;border:none;border-radius:6px;font-size:.93rem;width:100%;box-sizing:border-box">
          <input name="m2" type="number" placeholder="Fläche in m² (optional)" style="padding:.65rem .85rem;border:none;border-radius:6px;font-size:.93rem;width:100%;box-sizing:border-box">
        </div>
        <textarea name="message" placeholder="Ihre Nachricht (optional)" rows="3" style="padding:.65rem .85rem;border:none;border-radius:6px;font-size:.93rem;resize:vertical;box-sizing:border-box"></textarea>
        <button type="submit" class="cta-btn" style="cursor:pointer;border:none;width:100%;font-size:1rem">Anfrage senden →</button>
        <p id="direktStatus" style="text-align:center;font-size:.85rem;margin:0;min-height:1.2em"></p>
      </form>
      <script>
        document.getElementById('direktForm').addEventListener('submit', async function(e) {
          e.preventDefault();
          const btn = this.querySelector('button');
          const status = document.getElementById('direktStatus');
          btn.disabled = true;
          btn.textContent = 'Wird gesendet…';
          const data = Object.fromEntries(new FormData(this));
          try {
            const r = await fetch('/anfrage', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
            const j = await r.json();
            if (j.ok) {
              this.innerHTML = '<p style="text-align:center;font-size:1rem;margin:1rem 0">✅ Ihre Anfrage wurde direkt an <strong>${h.name}</strong> weitergeleitet. Sie erhalten in Kürze eine Bestätigung per E-Mail.</p>';
            } else {
              status.textContent = j.error || 'Fehler beim Senden. Bitte versuchen Sie es erneut.';
              btn.disabled = false; btn.textContent = 'Anfrage senden →';
            }
          } catch { status.textContent = 'Fehler beim Senden. Bitte versuchen Sie es erneut.'; btn.disabled = false; btn.textContent = 'Anfrage senden →'; }
        });
      </script>
    </div>`
    : `<div class="cta-block">
      <h2>Rollrasen in deiner Region anfragen</h2>
      <p style="opacity:.85;font-size:.9rem;margin:0 0 .25rem">Vergleiche Angebote von geprüften Betrieben in Bayern</p>
      <a class="cta-btn" href="/bayern/#rechner">Jetzt Bedarf berechnen</a>
    </div>`;

  const ortLabel   = h.ort || 'Bayern';
  const typLabel   = h.typ === 'Hersteller' ? 'Rollrasen-Hersteller' : 'Rollrasen-Fachbetrieb';
  const metaDesc   = h.profil_text
    ? `${h.name} aus ${ortLabel} – ${typLabel}. ${h.profil_text.slice(0, 130)}…`
    : `${h.name} aus ${ortLabel} – ${typLabel}. Kostenlose Angebote anfragen auf rasenrechner.de.`;
  const canonicalUrl = `https://www.rasenrechner.de/haendler/${h.profil_slug}`;
  const ogImage = h.logo_url || 'https://www.rasenrechner.de/img/og-default.jpg';

  const schemaRating  = h.google_bewertung ? `,"aggregateRating":{"@type":"AggregateRating","ratingValue":"${h.google_bewertung}","reviewCount":"${h.google_bewertungen_anzahl || 1}"}` : '';
  const schemaAdresse = adresse ? `,"address":{"@type":"PostalAddress","streetAddress":"${h.strasse || ''}","postalCode":"${h.plz || ''}","addressLocality":"${h.ort || ''}","addressCountry":"DE"}` : '';
  const schemaTel     = h.telefon ? `,"telephone":"${h.telefon}"` : '';
  const schemaUrl     = h.website ? `,"url":"${h.website}"` : '';
  const schema        = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness","name":"${h.name}"${schemaAdresse}${schemaTel}${schemaUrl}${schemaRating}}<\/script>`;

  // Nächste Stadtseite für Rücklink
  const PLZ_STADT = {'80':'muenchen','81':'muenchen','82':'muenchen','83':'rosenheim',
    '84':'landshut','85':'muenchen','86':'augsburg','87':'kempten',
    '90':'nuernberg','91':'erlangen','92':'regensburg','93':'regensburg',
    '94':'passau','95':'bayreuth','97':'wuerzburg'};
  const STADT_NAME = {muenchen:'München',rosenheim:'Rosenheim',landshut:'Landshut',
    augsburg:'Augsburg',nuernberg:'Nürnberg',regensburg:'Regensburg',
    wuerzburg:'Würzburg',erlangen:'Erlangen',bayreuth:'Bayreuth',
    passau:'Passau',kempten:'Kempten'};
  const stadtSlug  = h.plz ? PLZ_STADT[h.plz.slice(0,2)] || null : null;
  const stadtLink  = stadtSlug
    ? `<p style="margin-top:1.5rem;font-size:.88rem"><a href="/bayern/${stadtSlug}" style="color:#2d6a2d">← Weitere Rollrasen-Händler in ${STADT_NAME[stadtSlug]} &amp; Umgebung</a></p>`
    : `<p style="margin-top:1.5rem;font-size:.88rem"><a href="/bayern/" style="color:#2d6a2d">← Alle Rollrasen-Händler in Bayern</a></p>`;

  res.send(`<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${h.name} – Rollrasen in ${ortLabel} | rasenrechner.de</title>
  <meta name="description" content="${metaDesc}">
  <link rel="canonical" href="${canonicalUrl}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${h.name} – Rollrasen in ${ortLabel}">
  <meta property="og:description" content="${metaDesc}">
  <meta property="og:url" content="${canonicalUrl}">
  <meta property="og:image" content="${ogImage}">
  ${schema}
  ${pageCss}
  <style>
    .profile-hero{background:linear-gradient(135deg,#1a3d12 0%,#2d6a2d 100%);color:#fff;padding:2.5rem 1.5rem;border-radius:0 0 16px 16px;text-align:center;margin-bottom:2rem}
    .profile-hero h1{font-size:1.9rem;margin:.75rem 0 .5rem;color:#fff}
    .profile-hero p{opacity:.8;font-size:.9rem;margin:0}
    .profile-back{display:inline-block;color:#a8d5a8;font-size:.85rem;text-decoration:none;margin-bottom:.5rem}
    .profile-back:hover{color:#fff}
    .contact-card{background:#f4f8f4;border:1px solid #d4e8c8;border-radius:10px;padding:1.5rem;margin:1.5rem 0}
    .contact-row{display:flex;gap:.5rem;align-items:center;margin:.4rem 0;font-size:.93rem}
    .contact-row a{color:#2d6a2d;text-decoration:none}
    .contact-row a:hover{text-decoration:underline}
    .cta-block{background:#2d6a2d;color:#fff;border-radius:10px;padding:1.75rem;text-align:center;margin:2rem 0}
    .cta-block h2{font-size:1.15rem;margin:0 0 .75rem;color:#fff}
    .cta-btn{display:inline-block;background:#fff;color:#2d6a2d;font-weight:700;padding:.75rem 2rem;border-radius:6px;text-decoration:none;font-size:1rem;margin-top:.5rem}
    .cta-btn:hover{background:#f0f7f0}
    .profil-text{line-height:1.75;color:#444;margin:1.5rem 0}
    .maps-link{display:inline-flex;align-items:center;gap:6px;color:#2d6a2d;font-size:.87rem;text-decoration:none;margin-top:.75rem}
    .maps-link:hover{text-decoration:underline}
  </style>
</head>
<body>
  <div class="profile-hero">
    <a class="profile-back" href="/">← rasenrechner.de</a>
    ${h.logo_url ? `<div style="margin:.5rem auto;width:80px;height:80px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden"><img src="${h.logo_url}" alt="${h.name} Logo" style="width:100%;height:100%;object-fit:contain"></div>` : ''}
    <h1>${h.name}${h.ort ? ' – Rollrasen in ' + h.ort : ''}</h1>
    <div style="margin:.5rem 0">${badge}</div>
    <p>${typLabel}${h.region ? ' · ' + h.region : ''}</p>
  </div>

  <div class="wrap" style="padding-top:0">
    ${unverifiziertBanner}
    ${videoBlock}

    ${h.profil_text ? `<p class="profil-text">${h.profil_text}</p>` : ''}

    ${sterne ? `<p style="margin:1rem 0">${sterne}</p>` : ''}

    ${kontaktBlock}

    ${ctaBlock}

    ${stadtLink}

    <footer>rasenrechner.de · Ein Service der Gartenschmiede GmbH ·
      <a href="/impressum">Impressum</a> · <a href="/datenschutz">Datenschutz</a>
    </footer>
  </div>
</body>
</html>`);
});

// ─── ADMIN ────────────────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Rollrasen Admin"');
    return res.status(401).send('Anmeldung erforderlich');
  }
  const [, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
  if (!process.env.ADMIN_PASSWORD || pass !== process.env.ADMIN_PASSWORD) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Rollrasen Admin"');
    return res.status(401).send('Falsches Passwort');
  }
  next();
}

app.get('/admin', requireAdmin, (req, res) => {
  const anfragen = db.prepare('SELECT * FROM anfragen ORDER BY created_at DESC').all();
  const haendler = db.prepare('SELECT * FROM hersteller ORDER BY aktiv DESC, google_bewertung DESC').all();

  const today = new Date().toISOString().slice(0, 10);
  const todayCount = anfragen.filter(a => (a.created_at || '').startsWith(today)).length;
  const aktivCount = haendler.filter(h => h.aktiv).length;

  const fmt = dt => dt ? new Date(dt).toLocaleString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '–';
  const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  const anfrageRows = anfragen.map(a => `
    <tr>
      <td>${a.id}</td>
      <td style="white-space:nowrap">${fmt(a.created_at)}</td>
      <td><strong>${esc(a.name)}</strong></td>
      <td><a href="mailto:${esc(a.email)}">${esc(a.email)}</a></td>
      <td>${esc(a.phone || '–')}</td>
      <td>${a.plz || '–'}</td>
      <td>${a.m2 ? Math.round(a.m2) + ' m²' : '–'}</td>
      <td>${esc(a.product || '–')}</td>
      <td style="max-width:220px" title="${esc(a.message || '')}">${esc(a.haendler_names || '–')}</td>
      <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(a.message || '')}">${esc(a.message || '–')}</td>
    </tr>`).join('');

  const PAKET_BADGE = { partner: '<span class="badge" style="background:#dcfce7;color:#166534">Partner</span>', pro: '<span class="badge" style="background:#dbeafe;color:#1e40af">Pro</span>', premium: '<span class="badge" style="background:#fef9c3;color:#854d0e">Premium</span>' };
  const KS_BADGE   = { offen: '<span class="badge badge-off">Offen</span>', kontaktiert: '<span class="badge" style="background:#fef3c7;color:#92400e">Kontaktiert</span>', interessiert: '<span class="badge" style="background:#e0f2fe;color:#0369a1">Interessiert</span>', abonniert: '<span class="badge badge-on">Abonniert</span>', abgelehnt: '<span class="badge" style="background:#f1f5f9;color:#64748b">Abgelehnt</span>' };

  const haendlerRows = haendler.map(h => `
    <tr>
      <td><strong>${esc(h.name)}</strong><br><small style="color:#888">${esc(h.typ || '')}</small>${h.profil_slug ? `<br><small><a href="/haendler/${esc(h.profil_slug)}" target="_blank" style="color:#2d6a2d">↗ Profil</a></small>` : ''}</td>
      <td>${h.plz ? h.plz + ' ' : ''}${esc(h.ort || '')}${h.region ? '<br><small style="color:#888">'+esc(h.region)+'</small>' : ''}</td>
      <td style="white-space:nowrap">${h.google_bewertung ? '⭐ ' + h.google_bewertung.toFixed(1) + '<br><small>' + h.google_bewertungen_anzahl + ' Bew.</small>' : '–'}</td>
      <td>${h.email ? '<a href="mailto:'+esc(h.email)+'">'+esc(h.email)+'</a>' : '–'}</td>
      <td>${PAKET_BADGE[h.paket] || '<span class="badge" style="background:#f1f5f9;color:#64748b">Free</span>'}</td>
      <td>${KS_BADGE[h.kontakt_status] || KS_BADGE['offen']}</td>
      <td><span class="badge ${h.aktiv ? 'badge-on' : 'badge-off'}">${h.aktiv ? 'Aktiv' : 'Inaktiv'}</span></td>
      <td style="white-space:nowrap">
        <a href="/admin/haendler/${h.id}" style="display:inline-block;padding:4px 10px;background:#2d6a2d;color:#fff;border-radius:4px;font-size:0.75rem;text-decoration:none;font-weight:600;margin-right:4px">✏️ Edit</a>
        <form method="POST" action="/admin/haendler/${h.id}/toggle" style="display:inline">
          <button class="btn-toggle ${h.aktiv ? 'btn-off' : 'btn-on'}" type="submit">
            ${h.aktiv ? 'Aus' : 'An'}
          </button>
        </form>
      </td>
    </tr>`).join('');

  res.send(`<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Admin – Rollrasen-Portal</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,-apple-system,sans-serif;font-size:0.88rem;color:#222;background:#f7f9f7}
    .topbar{background:#2d6a2d;color:#fff;padding:1rem 2rem;display:flex;align-items:center;gap:1rem}
    .topbar h1{font-size:1.1rem;font-weight:700}
    .topbar small{opacity:.7;font-size:0.78rem}
    .content{max-width:1400px;margin:0 auto;padding:2rem}
    .stats{display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:2.5rem}
    .stat{background:#fff;border:1px solid #e0eee0;border-radius:10px;padding:1rem 1.5rem;text-align:center;min-width:140px}
    .stat strong{display:block;font-size:2rem;color:#2d6a2d;font-weight:700}
    .stat span{font-size:0.78rem;color:#666}
    h2{font-size:1rem;color:#2d6a2d;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin:2.5rem 0 0.75rem;padding-bottom:0.5rem;border-bottom:2px solid #e0eee0}
    .table-wrap{overflow-x:auto;border-radius:8px;box-shadow:0 1px 6px rgba(0,0,0,.07)}
    table{width:100%;border-collapse:collapse;background:#fff}
    th{background:#2d6a2d;color:#fff;padding:9px 12px;text-align:left;font-size:0.78rem;white-space:nowrap}
    td{padding:8px 12px;border-bottom:1px solid #f0f0f0;vertical-align:top}
    tr:last-child td{border-bottom:none}
    tr:hover td{background:#f9fbf9}
    .badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:600}
    .badge-on{background:#dcfce7;color:#166534}
    .badge-off{background:#fee2e2;color:#991b1b}
    .btn-toggle{padding:4px 12px;border:none;border-radius:4px;cursor:pointer;font-size:0.78rem;font-weight:600;font-family:inherit}
    .btn-off{background:#fee2e2;color:#991b1b}
    .btn-on{background:#dcfce7;color:#166534}
    .btn-toggle:hover{filter:brightness(.92)}
  </style>
</head>
<body>
  <div class="topbar">
    <div>
      <h1>🌿 Rollrasen-Portal Admin</h1>
      <small>Stand: ${new Date().toLocaleString('de-DE')}</small>
    </div>
  </div>
  <div class="content">
    <div class="stats">
      <div class="stat"><strong>${anfragen.length}</strong><span>Anfragen gesamt</span></div>
      <div class="stat"><strong>${todayCount}</strong><span>Anfragen heute</span></div>
      <div class="stat"><strong>${aktivCount}</strong><span>Händler aktiv</span></div>
      <div class="stat"><strong>${haendler.length}</strong><span>Händler gesamt</span></div>
    </div>

    <h2>Anfragen</h2>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>#</th><th>Datum</th><th>Name</th><th>E-Mail</th><th>Telefon</th>
          <th>PLZ</th><th>Fläche</th><th>Sorte</th><th>Händler benachrichtigt</th><th>Nachricht</th>
        </tr></thead>
        <tbody>${anfrageRows || '<tr><td colspan="10" style="text-align:center;color:#888;padding:2rem">Noch keine Anfragen</td></tr>'}</tbody>
      </table>
    </div>

    <h2>Händler</h2>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Name / Typ</th><th>PLZ / Ort</th><th>Bewertung</th>
          <th>E-Mail</th><th>Paket</th><th>Kontakt</th><th>Status</th><th>Aktionen</th>
        </tr></thead>
        <tbody>${haendlerRows}</tbody>
      </table>
    </div>
  </div>
</body>
</html>`);
});

app.post('/admin/haendler/:id/toggle', requireAdmin, (req, res) => {
  db.prepare('UPDATE hersteller SET aktiv = CASE WHEN aktiv = 1 THEN 0 ELSE 1 END WHERE id = ?').run(req.params.id);
  res.redirect('/admin');
});

app.get('/admin/haendler/:id', requireAdmin, (req, res) => {
  const h = db.prepare('SELECT * FROM hersteller WHERE id = ?').get(req.params.id);
  if (!h) return res.status(404).send('Händler nicht gefunden');
  const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const val = (v) => esc(v || '');
  const sel = (field, opt) => h[field] === opt ? ' selected' : '';

  res.send(`<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Händler bearbeiten – ${esc(h.name)}</title>
${pageCss}
<style>
  .edit-grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
  @media(max-width:600px){.edit-grid{grid-template-columns:1fr}}
  label{display:block;font-size:.82rem;font-weight:600;color:#444;margin:.1rem 0}
  input,select,textarea{width:100%;border:1.5px solid #d1d5db;border-radius:6px;padding:.55rem .8rem;font-size:.9rem;font-family:inherit;color:#222;background:#fff;margin-bottom:.75rem}
  input:focus,select:focus,textarea:focus{outline:2px solid #2d6a2d;border-color:#2d6a2d}
  textarea{min-height:100px;resize:vertical}
  .btn-save{background:#2d6a2d;color:#fff;border:none;border-radius:6px;padding:.7rem 2rem;font-size:1rem;font-weight:700;cursor:pointer;font-family:inherit}
  .btn-save:hover{background:#245a24}
  .section-title{font-size:.75rem;text-transform:uppercase;letter-spacing:.07em;color:#2d6a2d;font-weight:700;margin:1.5rem 0 .5rem;padding-bottom:.3rem;border-bottom:2px solid #d4e8c8}
  .readonly-note{color:#888;font-size:.78rem;margin-bottom:.5rem}
</style>
</head><body>
<div class="wrap">
  <a class="back" href="/admin">← Zurück zum Admin</a>
  <h1 style="font-size:1.4rem">✏️ ${esc(h.name)}</h1>
  <p class="readonly-note">ID: ${h.id} · Typ: ${esc(h.typ || '–')} · Erstellt: ${h.created_at || '–'}</p>

  <form method="POST" action="/admin/haendler/${h.id}">
    <div class="section-title">Paket & Status</div>
    <div class="edit-grid">
      <div>
        <label>Paket</label>
        <select name="paket">
          <option value="free"${sel('paket','free')}>Free (kein Badge)</option>
          <option value="partner"${sel('paket','partner')}>Partner – 49 €/Mo (✓ Geprüfter Händler)</option>
          <option value="pro"${sel('paket','pro')}>Professional – 99 €/Mo (⭐ Professional Partner)</option>
          <option value="premium"${sel('paket','premium')}>Premium – 199 €/Mo (🏆 Premium Partner)</option>
        </select>
      </div>
      <div>
        <label>Kontakt-Status</label>
        <select name="kontakt_status">
          <option value="offen"${sel('kontakt_status','offen')}>Offen</option>
          <option value="kontaktiert"${sel('kontakt_status','kontaktiert')}>Kontaktiert</option>
          <option value="interessiert"${sel('kontakt_status','interessiert')}>Interessiert</option>
          <option value="abonniert"${sel('kontakt_status','abonniert')}>Abonniert</option>
          <option value="abgelehnt"${sel('kontakt_status','abgelehnt')}>Abgelehnt</option>
        </select>
      </div>
      <div>
        <label>Paket Start</label>
        <input type="date" name="paket_start" value="${val(h.paket_start)}">
      </div>
      <div>
        <label>Paket Ende</label>
        <input type="date" name="paket_ende" value="${val(h.paket_ende)}">
      </div>
    </div>

    <div class="section-title">Webpräsenz-Status</div>
    <div class="edit-grid">
      <div>
        <label>Webseite-Qualität</label>
        <select name="webseite_status">
          <option value=""${sel('webseite_status','')}>– nicht geprüft –</option>
          <option value="gut"${sel('webseite_status','gut')}>Gut</option>
          <option value="mittel"${sel('webseite_status','mittel')}>Mittel</option>
          <option value="schlecht"${sel('webseite_status','schlecht')}>Schlecht</option>
          <option value="keine"${sel('webseite_status','keine')}>Keine Webseite</option>
        </select>
      </div>
      <div>
        <label>Google Business</label>
        <select name="google_status">
          <option value=""${sel('google_status','')}>– nicht geprüft –</option>
          <option value="gut"${sel('google_status','gut')}>Gut (viele Bewertungen)</option>
          <option value="mittel"${sel('google_status','mittel')}>Vorhanden, wenig Bewertungen</option>
          <option value="schlecht"${sel('google_status','schlecht')}>Vorhanden, schlechte Bewertungen</option>
          <option value="kein"${sel('google_status','kein')}>Kein Google-Eintrag</option>
        </select>
      </div>
    </div>

    <div class="section-title">Profil-Seite</div>
    <div class="edit-grid">
      <div>
        <label>URL-Slug (z.B. isar-rollrasen)</label>
        <input type="text" name="profil_slug" value="${val(h.profil_slug)}" placeholder="name-des-betriebs">
      </div>
      <div>
        <label>Logo-URL</label>
        <input type="url" name="logo_url" value="${val(h.logo_url)}" placeholder="https://...">
      </div>
    </div>
    <div>
      <label>Video-Embed-URL (YouTube: https://www.youtube.com/embed/ID)</label>
      <input type="url" name="video_url" value="${val(h.video_url)}" placeholder="https://www.youtube.com/embed/...">
    </div>
    <div>
      <label>Profil-Text (öffentlich sichtbar)</label>
      <textarea name="profil_text">${val(h.profil_text)}</textarea>
    </div>

    <div class="section-title">Interne Notizen</div>
    <div>
      <label>Notizen (nur intern)</label>
      <textarea name="notizen_intern">${val(h.notizen_intern)}</textarea>
    </div>

    <div style="margin-top:1.5rem;display:flex;gap:1rem;align-items:center">
      <button class="btn-save" type="submit">💾 Speichern</button>
      <a href="/admin" style="color:#666;font-size:.9rem">Abbrechen</a>
    </div>
  </form>
</div>
</body></html>`);
});

app.post('/admin/haendler/:id', requireAdmin, (req, res) => {
  const { paket, paket_start, paket_ende, kontakt_status, webseite_status, google_status,
          profil_slug, logo_url, video_url, profil_text, notizen_intern } = req.body;
  db.prepare(`
    UPDATE hersteller SET
      paket = ?, paket_start = ?, paket_ende = ?,
      kontakt_status = ?, webseite_status = ?, google_status = ?,
      profil_slug = ?, logo_url = ?, video_url = ?,
      profil_text = ?, notizen_intern = ?
    WHERE id = ?
  `).run(
    paket || 'free',
    paket_start || null, paket_ende || null,
    kontakt_status || 'offen', webseite_status || null, google_status || null,
    profil_slug?.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || null,
    logo_url?.trim() || null, video_url?.trim() || null,
    profil_text?.trim() || null, notizen_intern?.trim() || null,
    req.params.id
  );
  res.redirect('/admin');
});

// ─── HÄNDLER ENDPOINT ─────────────────────────────────────────────────────────

app.get('/haendler', (req, res) => {
  const plz  = (req.query.plz || '').replace(/\D/g, '');
  const top3 = findNearestHaendler(plz);
  const BADGE = { partner: '✓ Geprüfter Händler', pro: '⭐ Professional Partner', premium: '🏆 Premium Partner' };
  res.json({
    count:    top3.length,
    region:   top3[0]?.region || 'Bayern',
    haendler: top3.map(h => h.name),
    list:     top3.map(h => ({
      name:  h.name,
      paket: h.paket || 'free',
      slug:  h.profil_slug || null,
      badge: BADGE[h.paket] || null,
    })),
  });
});

// ─── ANFRAGE ENDPOINT ─────────────────────────────────────────────────────────

app.post('/anfrage', anfrageLimit, async (req, res) => {
  const { name, email, phone, plz, m2, product, message, haendler_id } = req.body;

  if (!name?.trim() || !email?.trim())
    return res.status(400).json({ error: 'Name und E-Mail sind Pflichtfelder' });

  const plzClean     = (plz || '').replace(/\D/g, '').slice(0, 5);
  const produktLabel = PRODUKT_LABELS[product] || product || 'nicht angegeben';
  const m2Display    = m2 ? Math.round(m2) + ' m²' : 'nicht angegeben';

  // Direktanfrage an einen spezifischen abonnierten Händler, oder PLZ-basierte Top-3
  let empfaenger;
  const direktId = haendler_id ? parseInt(haendler_id, 10) : null;
  if (direktId) {
    const direkt = db.prepare('SELECT * FROM hersteller WHERE id = ? AND aktiv = 1 AND kontakt_status = ?').get(direktId, 'abonniert');
    if (!direkt) return res.status(400).json({ error: 'Direktanfrage nicht möglich' });
    empfaenger = [direkt];
  } else {
    empfaenger = findNearestHaendler(plzClean);
  }

  // In DB speichern
  db.prepare(`
    INSERT INTO anfragen (name, email, phone, plz, m2, product, message, haendler_count, haendler_names)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name.trim(), email.trim(), phone?.trim() || null,
    plzClean || null, m2 || null, product?.trim() || null,
    message?.trim() || null, empfaenger.length,
    empfaenger.map(h => h.name).join(', ')
  );

  console.log(`📋 Neue Anfrage${direktId ? ' (direkt)' : ''}: ${name} (${email}) – ${m2Display} ${produktLabel} → ${empfaenger.map(h=>h.name).join(', ')}`);

  // ── Kunden-Bestätigungsmail ────────────────────────────────────────────────
  const haendlerRows = empfaenger.map((h, i) => haendlerKontaktHtml(h, i % 2 === 1)).join('');
  const isDirekt = !!direktId;

  const kundenMail = `
    <div style="font-family:sans-serif;max-width:600px;color:#222;margin:0 auto">
      <div style="background:#2d6a2d;padding:28px 24px;border-radius:8px 8px 0 0">
        <h2 style="color:#fff;margin:0;font-size:1.3rem">Ihre Rollrasen-Anfrage ist eingegangen</h2>
      </div>
      <div style="background:#fff;padding:24px;border:1px solid #dde8dd;border-top:none;border-radius:0 0 8px 8px">
        <p>Hallo ${escHtml(name)},</p>
        ${isDirekt
          ? `<p>Ihre Anfrage wurde direkt an <strong>${escHtml(empfaenger[0].name)}</strong> weitergeleitet. Der Betrieb meldet sich direkt bei Ihnen.</p>`
          : `<p>wir haben Ihre Anfrage erhalten und <strong>${empfaenger.length} Fachbetrieb${empfaenger.length !== 1 ? 'e' : ''}</strong> in Ihrer Region kontaktiert. Diese melden sich direkt per E-Mail oder Telefon bei Ihnen.</p>`
        }

        <table style="border-collapse:collapse;width:100%;margin:1.2rem 0;font-size:0.9rem">
          <tr style="background:#f0f4f0">
            <td style="padding:8px 16px;color:#666">Fläche</td>
            <td style="padding:8px 16px;font-weight:600">${escHtml(m2Display)}</td>
          </tr>
          <tr>
            <td style="padding:8px 16px;color:#666">Sorte</td>
            <td style="padding:8px 16px;font-weight:600">${escHtml(produktLabel)}</td>
          </tr>
          ${plzClean ? `<tr style="background:#f0f4f0"><td style="padding:8px 16px;color:#666">Ihre PLZ</td><td style="padding:8px 16px;font-weight:600">${escHtml(plzClean)}</td></tr>` : ''}
          ${message ? `<tr><td style="padding:8px 16px;color:#666;vertical-align:top">Ihre Nachricht</td><td style="padding:8px 16px">${escHtml(message)}</td></tr>` : ''}
        </table>

        <h3 style="color:#2d6a2d;margin:1.5rem 0 0.5rem;font-size:1rem;text-transform:uppercase;letter-spacing:.05em">
          ${isDirekt ? 'Kontaktierter Betrieb' : 'Kontaktierte Betriebe in Ihrer Nähe'}
        </h3>
        <table style="border-collapse:collapse;width:100%">
          ${haendlerRows}
        </table>

        <p style="margin-top:1.5rem;color:#555;font-size:0.9rem">
          Sollten Sie keine Rückmeldung erhalten, können Sie den Betrieb auch direkt über die oben angegebenen Kontaktdaten erreichen.
        </p>
        <hr style="border:none;border-top:1px solid #e0e8e0;margin:1.5rem 0">
        <p style="color:#999;font-size:0.8rem;margin:0">
          Diese E-Mail wurde automatisch versendet von
          <a href="https://www.rasenrechner.de" style="color:#2d6a2d">rasenrechner.de</a>
        </p>
      </div>
    </div>`;

  // ── Händler-Mail ──────────────────────────────────────────────────────────
  const haendlerMail = `
    <div style="font-family:sans-serif;max-width:600px;color:#222;margin:0 auto">
      <div style="background:#2d6a2d;padding:24px 28px;border-radius:8px 8px 0 0">
        <div style="color:#a8d5a8;font-size:0.8rem;letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px">Neue Kundenanfrage</div>
        <h2 style="color:#fff;margin:0;font-size:1.25rem">${isDirekt ? 'Direkte Rollrasen-Anfrage an Sie' : 'Rollrasen-Anfrage in Ihrer Region'}</h2>
      </div>
      <div style="background:#fff;padding:28px;border:1px solid #dde8dd;border-top:none;border-radius:0 0 8px 8px">
        <p style="margin-top:0">Guten Tag,</p>
        <p>über <a href="https://www.rasenrechner.de" style="color:#2d6a2d">rasenrechner.de</a> ist eine neue Anfrage eingegangen${isDirekt ? ', die <strong>direkt an Ihren Betrieb</strong> gerichtet wurde' : ', die wir Ihnen als nächstgelegenem Fachbetrieb weiterleiten'}.</p>
        <div style="background:#f4f8f4;border-left:4px solid #2d6a2d;border-radius:4px;padding:16px 20px;margin:20px 0">
          <div style="font-size:0.75rem;color:#2d6a2d;text-transform:uppercase;letter-spacing:.08em;font-weight:700;margin-bottom:12px">Anfrage-Details</div>
          <table style="border-collapse:collapse;width:100%;font-size:0.92rem">
            <tr><td style="padding:5px 0;color:#555;width:130px">Name</td><td style="padding:5px 0;font-weight:600">${escHtml(name)}</td></tr>
            <tr><td style="padding:5px 0;color:#555">E-Mail</td><td style="padding:5px 0"><a href="mailto:${escHtml(email)}" style="color:#2d6a2d">${escHtml(email)}</a></td></tr>
            ${phone ? `<tr><td style="padding:5px 0;color:#555">Telefon</td><td style="padding:5px 0">${escHtml(phone)}</td></tr>` : ''}
            <tr><td style="padding:5px 0;color:#555">PLZ / Ort</td><td style="padding:5px 0">${escHtml(plzClean || '–')}</td></tr>
            <tr><td style="padding:5px 0;color:#555">Fläche</td><td style="padding:5px 0;font-weight:600">${escHtml(m2Display)}</td></tr>
            <tr><td style="padding:5px 0;color:#555">Sorte</td><td style="padding:5px 0;font-weight:600">${escHtml(produktLabel)}</td></tr>
            ${message ? `<tr><td style="padding:5px 0;color:#555;vertical-align:top">Nachricht</td><td style="padding:5px 0;font-style:italic;color:#444">${escHtml(message)}</td></tr>` : ''}
          </table>
        </div>
        <p>Bitte nehmen Sie direkt per E-Mail oder Telefon Kontakt auf.</p>
        <div style="text-align:center;margin:28px 0 8px">
          <a href="mailto:${email}?subject=Ihr%20Rollrasen-Angebot"
             style="background:#2d6a2d;color:#fff;text-decoration:none;padding:12px 28px;border-radius:5px;font-weight:600;font-size:0.95rem;display:inline-block">
            Jetzt Angebot senden
          </a>
        </div>
        <hr style="border:none;border-top:1px solid #e0e8e0;margin:24px 0">
        <p style="color:#999;font-size:0.78rem;margin:0">
          Diese Anfrage wurde automatisch über <a href="https://www.rasenrechner.de" style="color:#2d6a2d">rasenrechner.de</a> weitergeleitet.
          Sie erhalten diese E-Mail, weil Ihr Betrieb als regionaler Fachpartner registriert ist.<br>
          Bei Fragen: <a href="mailto:info@gartenbau-kosten.de" style="color:#2d6a2d">info@gartenbau-kosten.de</a>
        </p>
      </div>
    </div>`;

  try {
    await sendMail(email, 'Ihre Rollrasen-Anfrage ist eingegangen – Kontaktierte Betriebe', kundenMail);

    const mailEmpfaenger = ADMIN_EMAIL
      ? [ADMIN_EMAIL]
      : empfaenger.filter(h => h.email).map(h => h.email);

    for (const empf of mailEmpfaenger) {
      await sendMail(empf, `Neue Rollrasen-Anfrage – ${m2Display}, PLZ ${plzClean}`, haendlerMail);
    }

    res.json({ ok: true, haendler_count: empfaenger.length, region: empfaenger[0]?.region || 'Bayern' });
  } catch (err) {
    console.error(`Mail-Fehler: ${err.message}`);
    res.json({ ok: true, haendler_count: empfaenger.length, region: empfaenger[0]?.region || 'Bayern' });
  }
});

// ─── PARTNER-ANFRAGE ENDPOINT ─────────────────────────────────────────────────

app.post('/partner-anfrage', partnerLimit, async (req, res) => {
  const { name, email, tel, type, msg } = req.body;

  if (!name?.trim() || !email?.trim())
    return res.status(400).json({ ok: false, error: 'Name und E-Mail sind Pflichtfelder' });

  console.log(`🤝 Partner-Anfrage: ${name} (${email}) – Typ: ${type || 'unbekannt'}`);

  const adminMail = `
    <div style="font-family:sans-serif;max-width:560px;color:#222">
      <h2 style="color:#2d6a2d">Neue Partner-Anfrage</h2>
      <table style="border-collapse:collapse;width:100%;margin:1rem 0">
        <tr><td style="padding:6px 12px;color:#666;width:140px">Name / Firma</td><td style="padding:6px 12px;font-weight:600">${name}</td></tr>
        <tr style="background:#f5f5f5"><td style="padding:6px 12px;color:#666">E-Mail</td><td style="padding:6px 12px"><a href="mailto:${email}">${email}</a></td></tr>
        ${tel ? `<tr><td style="padding:6px 12px;color:#666">Telefon</td><td style="padding:6px 12px">${tel}</td></tr>` : ''}
        <tr style="background:#f5f5f5"><td style="padding:6px 12px;color:#666">Typ</td><td style="padding:6px 12px">${type || '–'}</td></tr>
        ${msg ? `<tr><td style="padding:6px 12px;color:#666">Nachricht</td><td style="padding:6px 12px">${msg}</td></tr>` : ''}
      </table>
      <p style="color:#666;font-size:0.9rem">Eingegangen über rasenrechner.de</p>
    </div>`;

  const bestaetigung = `<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;background:#f7f9f7;margin:0;padding:0">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">
  <div style="background:#2d6a2d;padding:28px 28px 24px">
    <div style="color:#a8d5a8;font-size:.75rem;letter-spacing:.1em;text-transform:uppercase;margin-bottom:6px">rasenrechner.de · Partnerschaft</div>
    <h1 style="color:#fff;font-size:1.3rem;margin:0;line-height:1.3">Ihre Anfrage ist eingegangen</h1>
  </div>
  <div style="padding:28px">
    <p style="margin-top:0">Sehr geehrte/r ${name},</p>
    <p>vielen Dank für Ihr Interesse an einer Partnerschaft auf <a href="https://www.rasenrechner.de" style="color:#2d6a2d">rasenrechner.de</a>.</p>
    <p>Wir haben Ihre Anfrage erhalten und melden uns in der Regel <strong>innerhalb von 1–2 Werktagen</strong> persönlich bei Ihnen.</p>

    <div style="background:#f4f8f4;border-left:4px solid #2d6a2d;border-radius:4px;padding:16px 20px;margin:20px 0">
      <p style="margin:0 0 8px;font-weight:700;color:#1a3d1a">Ihre Angaben</p>
      <table style="border-collapse:collapse;width:100%;font-size:.9rem">
        <tr><td style="padding:5px 0;color:#666;width:130px">Name / Firma</td><td style="padding:5px 0;font-weight:600">${name}</td></tr>
        <tr><td style="padding:5px 0;color:#666">E-Mail</td><td style="padding:5px 0">${email}</td></tr>
        ${tel ? `<tr><td style="padding:5px 0;color:#666">Telefon</td><td style="padding:5px 0">${tel}</td></tr>` : ''}
        ${type ? `<tr><td style="padding:5px 0;color:#666">Paket-Interesse</td><td style="padding:5px 0">${type}</td></tr>` : ''}
        ${msg ? `<tr><td style="padding:5px 0;color:#666;vertical-align:top">Nachricht</td><td style="padding:5px 0">${msg}</td></tr>` : ''}
      </table>
    </div>

    <p style="font-size:.9rem;color:#555">
      In der Zwischenzeit können Sie gerne unsere <a href="https://www.rasenrechner.de" style="color:#2d6a2d">Portal-Startseite</a> besuchen
      und sich einen Eindruck verschaffen, wie Ihr Betrieb dort erscheinen würde.
    </p>

    <p>Mit freundlichen Grüßen<br>
    <strong>Bastian Rohrhuber</strong><br>
    rasenrechner.de · <a href="mailto:info@gartenbau-kosten.de" style="color:#2d6a2d">info@gartenbau-kosten.de</a></p>

    <hr style="border:none;border-top:1px solid #e0eee0;margin:1.5rem 0">
    <p style="color:#999;font-size:.75rem;margin:0">
      Diese Bestätigung wurde automatisch versandt. Bei Rückfragen antworten Sie einfach auf diese E-Mail.
    </p>
  </div>
</div>
</body></html>`;

  try {
    await sendMail(ADMIN_EMAIL || 'info@gartenbau-kosten.de', `Partner-Anfrage: ${name} (${type || 'unbekannt'})`, adminMail);
    await sendMail(email, 'Ihre Partner-Anfrage bei rasenrechner.de – Bestätigung', bestaetigung);
    res.json({ ok: true });
  } catch (err) {
    console.error('Mail-Fehler:', err.message);
    res.json({ ok: true });
  }
});

// ─── SITEMAP ─────────────────────────────────────────────────────────────────

app.get('/sitemap.xml', (req, res) => {
  const base = 'https://www.rasenrechner.de';
  const today = new Date().toISOString().slice(0, 10);

  const staticUrls = ['/bayern/', '/bayern/muenchen', '/bayern/nuernberg', '/bayern/augsburg', '/bayern/regensburg',
    '/bayern/landshut', '/bayern/rosenheim', '/bayern/ingolstadt', '/bayern/freising', '/bayern/fuerth',
    '/bayern/wuerzburg', '/bayern/erlangen', '/bayern/bayreuth', '/bayern/passau', '/bayern/kempten'];

  const profileSlugs = db.prepare("SELECT profil_slug FROM hersteller WHERE profil_slug IS NOT NULL AND profil_slug != '' AND aktiv = 1").all();

  const urls = [
    ...staticUrls.map((path, i) => ({
      loc: base + path,
      priority: i === 0 ? '1.0' : '0.8',
      changefreq: i === 0 ? 'weekly' : 'monthly',
    })),
    ...profileSlugs.map(h => ({
      loc: `${base}/haendler/${h.profil_slug}`,
      priority: '0.7',
      changefreq: 'monthly',
    })),
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>`;

  res.set('Content-Type', 'application/xml');
  res.send(xml);
});

// ─── STADTSEITEN ─────────────────────────────────────────────────────────────

const STAEDTE = {
  muenchen: {
    name: 'München', region: 'Oberbayern', plz: '80331',
    title: 'Rollrasen München – Kosten, Händler & kostenlose Angebote 2026',
    desc:  'Rollrasen in München kaufen & verlegen lassen: Preisrechner, regionale Händler & kostenlose Angebote. Geprüfte Fachbetriebe aus dem Großraum München.',
    preisHinweis: 'In München können Anfahrt und Parkraummangel in innerstädtischen Lagen die Verlegekosten leicht erhöhen – bei Projekten in der Innenstadt oder dichtem Stadtgebiet realistisch 2–4 €/m² Aufschlag einkalkulieren. Im Münchner Umland (Unterschleißheim, Germering, Kirchheim) entsprechen die Preise dem bayerischen Durchschnitt.',
    nachbarStaedte: ['landshut', 'rosenheim', 'ingolstadt', 'freising', 'augsburg'],
    intro: `München und das Großraum-Umland zählen zu den aktivsten Rollrasen-Märkten in Bayern. Das mild-kontinentale Klima mit rund 930 mm Jahresniederschlag bietet grundsätzlich gute Bedingungen – kritisch ist jedoch der oft trockene Frühsommer zwischen Mitte Juni und Ende Juli, wenn intensive Bewässerung über Erfolg oder Misserfolg entscheidet.

Die Böden im Münchner Raum sind heterogen. In Stadtrandlagen wie Unterschleißheim, Grünwald oder Germering dominiert lehmig-sandiger Boden mit guter Drainage und guten Anwachsbedingungen. Innerstädtische Gärten stehen dagegen oft auf verdichtetem Untergrund oder aufgefülltem Bauland – hier ist gründliche Bodenvorbereitung keine Option, sondern Voraussetzung für dauerhaft schönen Rasen.

Die Stärken einer regionalen Versorgung zeigen sich in München besonders deutlich: Betriebe aus Unterschleißheim, Kirchheim, Schwabhausen und Strasslach liefern frisch geernteten Rasen, der meist noch am selben oder folgenden Tag verlegt wird. Kurze Transportwege sichern höchste Anwachsraten – ein spürbarer Unterschied zu überregionalen Versandhändlern, bei denen Rollrasen manchmal 24–48 Stunden unterwegs ist.

Typische Projekte im Münchner Raum: Reihenhaus-Gärten in Pasing oder Neuaubing (60–120 m²), Neubaugebiete in Unterschleißheim, Kirchheim oder Eching (100–400 m²) und repräsentative Villengärten in Grünwald oder Pullach (ab 500 m²). Für alle Größen gibt es geeignete Fachbetriebe – PLZ eingeben und drei Angebote direkt vergleichen.`,
    faq: [
      { q: 'Was kostet Rollrasen in München?', a: 'Das Material liegt je nach Sorte bei 5–12 €/m². Mit Lieferung und Verlegung durch einen Fachbetrieb sind 15–25 €/m² realistisch. Bodenvorbereitung kommt bei Bedarf obendrauf – insgesamt sind 25–55 €/m² ein realistischer Gesamtrahmen für eine Komplettlösung.' },
      { q: 'Welche Händler liefern im Großraum München?', a: 'Mehrere geprüfte Fachbetriebe aus Unterschleißheim, Kirchheim, Schwabhausen und Strasslach beliefern den gesamten Großraum München. PLZ eingeben – wir verbinden Sie mit den nächsten drei Betrieben.' },
      { q: 'Wann ist die beste Zeit für Rollrasen in München?', a: 'April bis Juni und August bis Oktober sind ideal. Der Münchner Sommer kann trocken sein – wer im Juli verlegt, muss täglich intensiv wässern. Im Herbst ist das Anwachsen oft zuverlässiger.' },
      { q: 'Kann ich Rollrasen in München selbst verlegen?', a: 'Ja, bei kleineren Flächen gut machbar. Die Bodenvorbereitung (Fräsen, Planieren) ist der anspruchsvollere Teil. Für Flächen ab 100 m² lohnt sich ein Fachbetrieb zeitlich und qualitätsmäßig.' },
      { q: 'Welche Bodenvorbereitung brauche ich in München?', a: 'Das hängt vom Standort ab: Sandige Böden am Stadtrand brauchen Humus-Einarbeitung (ca. 5 cm), verdichtete Böden aus Neubaugebieten müssen gefräst und planiert werden. Ein Fachbetrieb beurteilt den Boden vor Ort und gibt eine ehrliche Einschätzung.' },
      { q: 'Wie lange bis der Rollrasen in München begehbar ist?', a: 'Nach 10–14 Tagen ist Rollrasen leicht begehbar, nach 3–4 Wochen voll belastbar. Ausreichende Bewässerung in den ersten 3 Wochen ist entscheidend – mindestens einmal täglich, bei Hitze zweimal.' },
      { q: 'Lohnt sich Rollrasen für kleine Flächen unter 30 m² in München?', a: 'Ja, aber das Preis-Leistungs-Verhältnis ist ungünstiger: Anfahrt, Mindestmengen und Bodenvorbereitung fallen als Fixkosten an. Unter 20 m² ist Eigenverlegung mit gekauften Soden oft günstiger.' },
    ],
  },
  nuernberg: {
    name: 'Nürnberg', region: 'Mittelfranken', plz: '90402',
    title: 'Rollrasen Nürnberg – Kosten, Händler & kostenlose Angebote 2026',
    desc:  'Rollrasen in Nürnberg kaufen & verlegen lassen: Preisrechner, regionale Händler & kostenlose Angebote. Geprüfte Fachbetriebe aus Mittelfranken.',
    preisHinweis: 'Nürnberg hat mit Noris Rollrasen einen lokalen Produzenten direkt vor Ort – das hält die Materialpreise wettbewerbsfähig und die Transportkosten niedrig. Für eine typische Gartenfläche von 80 m² sind 1.200–4.400 € Gesamtkosten ein realistischer Rahmen.',
    nachbarStaedte: ['erlangen', 'fuerth', 'ingolstadt', 'bayreuth', 'wuerzburg'],
    intro: `Nürnberg und der Großraum Mittelfranken haben eine ausgeprägte Gartenkultur – und mit Noris Rollrasen sowie den Greenkeepers Gartenbau aus Fürth gleich zwei spezialisierte Betriebe vor Ort. Das ist ein klarer Vorteil: frischer Rasen, kurze Lieferwege, und Betriebe die die lokalen Bodenbedingungen aus dem Alltag kennen.

Das Klima Mittelfrankens ist klar kontinental: heiße, oft trockene Sommer mit Temperaturen über 30°C sind keine Seltenheit, die Winter können streng sein. Für Rollrasen bedeutet das: Verlegung im Frühjahr (April/Mai) oder Frühherbst (September/Oktober) ist deutlich zuverlässiger als im Hochsommer. Wer im Juli verlegt, muss täglich bewässern – sonst leidet die Anwachsrate.

Die Böden in der Region sind größtenteils sandsteinhaltig und leicht sauer – das ist für Rollrasen beherrschbar, erfordert aber manchmal eine Kalkung vor der Verlegung. Lokale Betriebe kennen die Bodenverhältnisse in einzelnen Stadtteilen und Umlandgemeinden und können gezielt beraten.

Häufige Projekte in Nürnberg: Reihenhaus-Gärten in Langwasser oder Stein (50–100 m²), Neubaugebiete in Wendelstein oder Schwaig (150–400 m²), und Gewerbe-Außenanlagen rund um die Messe (ab 500 m²). Für alle Projekte gilt: Mehrere Angebote vergleichen lohnt sich – die Preisunterschiede zwischen Betrieben können 20–30 % ausmachen.`,
    faq: [
      { q: 'Was kostet Rollrasen in Nürnberg?', a: 'Material: 5–12 €/m². Inkl. Lieferung und Verlegung: 15–25 €/m². Komplett mit Bodenvorbereitung: 25–55 €/m². Für eine typische Gartenfläche von 80 m² sind 1.200–4.400 € ein realistischer Gesamtrahmen.' },
      { q: 'Welche Händler liefern in Nürnberg und Umgebung?', a: 'Noris Rollrasen (Nürnberg) und die Greenkeepers Gartenbau (Fürth) sind direkt vor Ort. Überregionale Hersteller wie Isar Rollrasen und BayernRasen liefern ebenfalls nach Mittelfranken.' },
      { q: 'Wann ist die beste Zeit für Rollrasen in Nürnberg?', a: 'Frühjahr (April/Mai) und Frühherbst (September/Oktober) sind ideal. Der Nürnberger Sommer ist trocken und heiß – Verlegung im Juli/August erfordert intensive tägliche Bewässerung.' },
      { q: 'Gibt es Rollrasen auch für schattige Gärten in Nürnberg?', a: 'Ja. Halbschattenrasen ist für Gärten mit altem Baumbestand geeignet. Lokale Händler beraten zu den richtigen Sorten für Ihren spezifischen Standort.' },
      { q: 'Welche Rasensorte eignet sich für das Nürnberger Klima?', a: 'Gebrauchsrasen und Strapazierrasen sind in Mittelfranken am verbreitetsten. Für trockene Lagen empfiehlt sich eine trockenheitstolerante Sorte – lokale Händler kennen die bewährten Sorten für die Region.' },
      { q: 'Wie lange dauert die Verlegung von Rollrasen in Nürnberg?', a: 'Ein typischer Garten von 80–100 m² ist inklusive Bodenvorbereitung an einem Arbeitstag fertig verlegt. Reine Verlegung ohne Bodenvorbereitung geht bei erfahrenen Betrieben in 2–4 Stunden.' },
      { q: 'Was kostet die Bodenvorbereitung in Nürnberg?', a: 'Fräsen und Planieren kosten je nach Aufwand 5–15 €/m². Humus-Einarbeitung kommt obendrauf. Auf Nürnberger Sandsteinböden ist eine Kalkung empfehlenswert – ca. 1–2 €/m² zusätzlich.' },
    ],
  },
  augsburg: {
    name: 'Augsburg', region: 'Schwaben', plz: '86150',
    title: 'Rollrasen Augsburg – Kosten, Händler & kostenlose Angebote 2026',
    desc:  'Rollrasen in Augsburg kaufen & verlegen lassen: Preisrechner, regionale Händler & kostenlose Angebote. Geprüfte Fachbetriebe aus Schwaben.',
    preisHinweis: 'Augsburg liegt nah am Hersteller Walter Schwab GmbH in Waidhofen – das hält Transportkosten vergleichsweise niedrig. Augsburg zählt zu den günstigsten Standorten in Bayern für Rollrasen-Lieferung.',
    nachbarStaedte: ['muenchen', 'ingolstadt', 'kempten'],
    intro: `Augsburg und der Raum Schwaben sind rollrasenmäßig hervorragend versorgt: Mit der Walter Schwab GmbH aus Waidhofen gibt es einen der ältesten und größten Rollrasen-Hersteller Deutschlands in direkter Nachbarschaft – gegründet in den 1970er Jahren, heute mit rund 250 Hektar Eigenproduktion. Diese Nähe bedeutet: frisch geernteter Rasen, kurze Transportwege und konkurrenzfähige Preise.

Das Klima in Augsburg ist gemäßigt-kontinental mit rund 800 mm Jahresniederschlag. Die Sommer sind warm aber nicht extrem trocken, die Winter moderat. Für Rollrasen sind das gute Bedingungen: Das Frühjahr (April–Juni) und der Frühherbst (September/Oktober) bieten die besten Anwachsbedingungen. Auch Sommerverlegungen sind möglich, erfordern aber konsequente Bewässerung in den ersten drei Wochen.

Augsburgs Böden sind im Stadtgebiet oft lehmig, im Umland sandiger und kiesiger. Besonders in Neubaugebieten wie Haunstetten oder Lechhausen ist eine gründliche Bodenvorbereitung wichtig: Der Untergrund aus dem Bau muss aufgelockert und mit Humus angereichert werden, bevor Rollrasen dauerhaft gut gedeiht.

Typische Projekte: Reihenhausgärten in Haunstetten (50–120 m²), Neubaugebiete in Gersthofen oder Königsbrunn (150–350 m²), und Gewerbeflächen entlang der Industriegebiete südlich der Stadt.`,
    faq: [
      { q: 'Was kostet Rollrasen in Augsburg?', a: 'Material: 5–12 €/m². Mit Lieferung und Verlegung: 15–25 €/m². Komplett mit Bodenvorbereitung: 25–55 €/m². Augsburg hat kurze Wege zu Walter Schwab GmbH, was die Lieferkosten niedrig hält.' },
      { q: 'Welche Händler liefern in Augsburg?', a: 'Walter Schwab GmbH aus Waidhofen bei Augsburg ist einer der bekanntesten Produzenten Bayerns. Ergänzend liefern BayernRasen und Isar Rollrasen bayernweit – auch nach Augsburg.' },
      { q: 'Wann ist der beste Zeitpunkt für Rollrasen in Augsburg?', a: 'April bis Juni und September/Oktober sind ideal. Der Augsburger Sommer kann trocken ausfallen – intensive Bewässerung in den ersten zwei Wochen nach Verlegung ist entscheidend.' },
      { q: 'Lohnt sich Rollrasen gegenüber Rasensaat in Augsburg?', a: 'Bei schnell genutzten Flächen (Garten fertigstellen, Neubau, Event) ist Rollrasen klar besser. Bei großen Flächen mit ausreichend Zeit ist Rasensaat günstiger – die Bodenvorbereitung ist bei beiden ähnlich aufwendig.' },
      { q: 'Welche Rasensorte empfiehlt sich für Augsburg?', a: 'Gebrauchsrasen ist für die meisten Augsburger Gärten ideal: robust, pflegeleicht und belastbar. Für Flächen mit Baumschatten (z.B. in Stadtrandlagen mit altem Baumbestand) empfiehlt sich Halbschattenrasen.' },
      { q: 'Wie schnell wächst Rollrasen in Augsburg an?', a: 'Bei optimaler Bewässerung und milden Temperaturen im Frühjahr oder Herbst wächst Rollrasen innerhalb von 10–14 Tagen fest an. Im Sommer dauert es bei Hitze etwas länger – dafür ist er nach dem Anwachsen robuster.' },
      { q: 'Gibt es Mindestmengen bei der Lieferung in Augsburg?', a: 'Die meisten Betriebe liefern ab 30–50 m². Darunter lohnt sich Abholung direkt beim Hersteller oder Kauf im Gartencenter. Walter Schwab GmbH bietet auch Selbstabholung in Waidhofen an.' },
    ],
  },
  regensburg: {
    name: 'Regensburg', region: 'Oberpfalz', plz: '93047',
    title: 'Rollrasen Regensburg – Kosten, Händler & kostenlose Angebote 2026',
    desc:  'Rollrasen in Regensburg kaufen & verlegen lassen: Preisrechner, regionale Händler & kostenlose Angebote. Geprüfte Fachbetriebe aus der Oberpfalz.',
    preisHinweis: 'Regensburg liegt etwas abseits der größten Produktionsbetriebe – Lieferkosten entsprechen dem bayerischen Durchschnitt. Betriebe aus der Oberpfalz und aus dem Landshuter Raum halten sich preislich die Waage.',
    nachbarStaedte: ['landshut', 'ingolstadt', 'passau', 'nuernberg'],
    intro: `Regensburg und die Oberpfalz haben eine eigene regionale Rollrasen-Versorgung: Gartenbau Schaknat aus Seubersdorf ist ein direkt in der Region verwurzelter Fachbetrieb. Für größere Projekte liefern überregionale Hersteller wie Isar Rollrasen aus Altheim und Sued-Rasen zuverlässig in den Regensburger Raum.

Das Klima Regensburgs ist ausgesprochen kontinental mit deutlichen Jahreszeiten. Mit durchschnittlich nur 540 mm Jahresniederschlag gehört Regensburg zu den trockensten Städten Bayerns – ein wichtiger Faktor bei der Rollrasen-Planung. Intensives Wässern in den ersten drei Wochen nach der Verlegung ist hier besonders kritisch, nicht optional.

Die Böden der Oberpfalz sind oft kalkhaltig und lehmig – gute Voraussetzungen für Rollrasen, wenn die Drainage stimmt. In Regensburger Neubaugebieten wie Burgweinting oder Harting ist verdichteter Baustellenboden die häufigste Herausforderung: Fräsen und Planieren sind dann Pflicht.

Das Frühjahr (April bis Juni) ist die beste Verlegezeit: Die Böden erwärmen sich nach dem Winter rasch, und die Frühjahrsregenfälle unterstützen das Anwachsen. Im Herbst (September) bietet sich eine gute zweite Chance – das Stadtklima Regensburgs ist im Frühherbst noch warm genug für sicheres Wurzelwachstum.`,
    faq: [
      { q: 'Was kostet Rollrasen in Regensburg?', a: 'Material: 5–12 €/m². Mit Lieferung und Verlegung: 15–25 €/m². Komplett mit Bodenvorbereitung: 25–55 €/m². Preise sind vergleichbar mit dem bayerischen Durchschnitt.' },
      { q: 'Welche Händler liefern in Regensburg?', a: 'Gartenbau Schaknat aus der Oberpfalz ist regional tätig. Zusätzlich liefern Isar Rollrasen (Niederbayern) und BayernRasen bayernweit – auch nach Regensburg.' },
      { q: 'Wann ist der beste Zeitpunkt für Rollrasen in Regensburg?', a: 'April bis Juni und September sind ideal. Das kontinentale Klima Regensburgs macht Frühjahrspflanzungen besonders erfolgreich – die Böden erwärmen sich schnell und die Niederschläge sind ausreichend.' },
      { q: 'Gibt es einen Unterschied zwischen Rollrasen und Fertigrasen?', a: 'Nein – beides bezeichnet dasselbe Produkt. „Fertigrasen" ist die häufigere Bezeichnung im Fachhandel, „Rollrasen" die geläufigere Umgangssprache.' },
      { q: 'Warum brauche ich in Regensburg besonders viel Wasser?', a: 'Regensburg gehört zu den niederschlagsärmsten Städten Bayerns (ca. 540 mm/Jahr). In den ersten 14–21 Tagen nach der Verlegung muss täglich gewässert werden – ohne das trocknet der Rasen ein und wächst schlecht an.' },
      { q: 'Welche Rasensorte eignet sich für die Oberpfalz?', a: 'Trockenheitstolerante Gebrauchsrasen-Sorten sind für Regensburg empfehlenswert. Lokale Händler beraten zu Sorten, die mit dem trockenen Klima der Oberpfalz gut zurechtkommen.' },
      { q: 'Wie plane ich die Bodenvorbereitung in Regensburg?', a: 'Auf kalkhaltigen Böden der Oberpfalz ist eine pH-Kontrolle sinnvoll. Bei stark verdichtetem Boden (häufig in Neubaugebieten) ist Tiefenlockerung notwendig. Ein Fachbetrieb aus der Region beurteilt dies vor Ort.' },
    ],
  },
  landshut: {
    name: 'Landshut', region: 'Niederbayern', plz: '84028',
    title: 'Rollrasen Landshut – Kosten, Händler & kostenlose Angebote 2026',
    desc:  'Rollrasen in Landshut kaufen & verlegen lassen: Preisrechner, regionale Händler & kostenlose Angebote. Geprüfte Fachbetriebe aus Niederbayern.',
    preisHinweis: 'Landshut profitiert von seiner Nähe zu Isar Rollrasen in Altheim – einer der kürzesten Lieferwege in ganz Niederbayern. Das drückt Transportkosten nach unten und sorgt für besonders frischen Rasen.',
    nachbarStaedte: ['muenchen', 'freising', 'regensburg', 'passau'],
    intro: `Landshut liegt im Herzen Niederbayerns und ist rollrasenmäßig exzellent versorgt: Isar Rollrasen aus dem nahe gelegenen Altheim und Nodes Gartenbau aus Essenbach sind beide innerhalb einer halben Autostunde – und liefern frisch geernteten Rasen oft noch am selben Tag nach der Ernte. Diese Frische macht einen messbaren Unterschied: Rollrasen, der schnell vom Feld zum Garten kommt, wurzelt zuverlässiger an als Ware, die 24–48 Stunden auf LKWs verbracht hat.

Das niederbayerische Klima rund um Landshut ist mild-kontinental mit rund 800 mm Jahresniederschlag – mehr als in Regensburg oder Nürnberg. Das kommt Rollrasen zugute: Die Anwachsbedingungen im Frühjahr sind hervorragend, intensive Bewässerung ist weniger kritisch als in trockeneren Regionen.

Die Böden im Isartal sind oft tiefgründig und fruchtbar – Auenlehm mit gutem Wasserhaltvermögen ist typisch für die Flussniederungen rund um Landshut. Höher gelegene Lagen rund um die Stadt haben sandige bis sandig-lehmige Böden, die etwas mehr Humusergänzung vertragen.

Häufige Projekte: Einfamilienhausgärten in Achdorf und Nikola (60–150 m²), Neubaugebiete am Stadtrand (150–400 m²) und landwirtschaftliche Außenanlagen im Umland.`,
    faq: [
      { q: 'Was kostet Rollrasen in Landshut?', a: 'Material: 5–12 €/m². Inkl. Lieferung und Verlegung: 15–25 €/m². Mit Bodenvorbereitung: 25–55 €/m². Landshut profitiert von kurzen Wegen zu regionalen Herstellern – besonders günstige Lieferbedingungen.' },
      { q: 'Welche Händler liefern in Landshut?', a: 'Isar Rollrasen aus Altheim und Nodes Gartenbau aus Essenbach sind direkt vor Ort. Beide decken den Raum Niederbayern zuverlässig ab.' },
      { q: 'Wann ist der beste Zeitpunkt für Rollrasen in Landshut?', a: 'April bis Juni und September/Oktober. Niederbayern hat ausreichend Frühjahrs-Niederschläge – ideal für schnelles Anwachsen ohne übermäßigen Bewässerungsaufwand.' },
      { q: 'Was ist der Vorteil von regionalem Rollrasen aus Niederbayern?', a: 'Kurze Transportwege bedeuten frischeren Rasen mit höherer Anwurzelungsrate. Isar Rollrasen liefert oft am selben oder nächsten Tag nach der Ernte – das ist ein echter Qualitätsvorteil.' },
      { q: 'Wie lange muss ich nach der Verlegung wässern in Landshut?', a: 'Mindestens 2–3 Wochen täglich, am besten morgens. Im Frühjahr und Herbst reicht meist einmal täglich; im Sommer ist zweimal täglich (morgens und abends) ratsam.' },
      { q: 'Kann ich Rollrasen in Landshut auch im Oktober noch verlegen?', a: 'Ja, Oktober ist oft noch gut geeignet – solange kein Frost droht und die Bodentemperatur über 8°C liegt. Frühherbstverlegungen haben in Niederbayern eine hohe Erfolgsrate.' },
      { q: 'Gibt es Rollrasen für Spielflächen und Kindergärten in Landshut?', a: 'Ja – Sportrasen und Strapazierrasen sind dafür ausgelegt. Diese Sorten vertragen intensive Nutzung und erholen sich schneller. Lokale Händler beraten zur optimalen Sorte für Kinderspielbereich oder Sportfläche.' },
    ],
  },
  rosenheim: {
    name: 'Rosenheim', region: 'Oberbayern', plz: '83022',
    title: 'Rollrasen Rosenheim – Kosten, Händler & kostenlose Angebote 2026',
    desc:  'Rollrasen in Rosenheim kaufen & verlegen lassen: Preisrechner, regionale Händler & kostenlose Angebote. Geprüfte Fachbetriebe aus dem Chiemgau.',
    preisHinweis: 'In Rosenheim und dem Chiemgau können Hanglagen und aufwendigere Verlegetechnik die Kosten um 3–8 €/m² erhöhen. Immer vorab im Angebot klären lassen – seriöse Betriebe besichtigen die Fläche vor der Kalkulation.',
    nachbarStaedte: ['muenchen', 'kempten', 'freising'],
    intro: `Rosenheim und der Chiemgau liegen am Fuß der Voralpen – eine Region mit eigenen klimatischen Anforderungen an Rollrasen. Rasen Schwab ist als lokaler Fachbetrieb direkt vor Ort und kennt die Besonderheiten der Region: Hanglagen, schwere Lehmböden in Tallage und das Voralpenklima mit späten Frösten im Frühjahr.

Das Klima im Chiemgau ist feucht und niederschlagsreich – Rosenheim bekommt im Schnitt über 1.000 mm Regen pro Jahr. Das ist ein Segen für Rollrasen: Einmal fest angewachsen, gedeiht er hier üppig und tiefgrün ohne übermäßigen Pflegeaufwand. Die Herausforderung liegt im Frühjahr: Fröste bis in den Mai hinein sind in der Voralpenregion keine Seltenheit, weshalb Pflanzungen erst nach den Eisheiligen (Mitte Mai) sicherer sind.

Die Böden rund um Rosenheim sind vielschichtig: In Tallage dominieren schwere, feuchte Lehmböden – gut für die Wasserversorgung, aber anfällig für Staunässe. Eine gute Drainage ist hier entscheidend. In Hanglagen und höheren Lagen findet sich steiniger, gut drainierter Boden, der sich hervorragend für Rollrasen eignet.

Hanglagen stellen auch bei der Verlegung besondere Anforderungen: Rollrasen muss auf Hängen mit Heringen oder Netzen gesichert werden bis er fest angewachsen ist – ein Detailaspekt, den regionale Fachbetriebe aus dem Chiemgau routinemäßig beherrschen.`,
    faq: [
      { q: 'Was kostet Rollrasen in Rosenheim?', a: 'Material: 5–12 €/m². Inkl. Lieferung und Verlegung: 15–25 €/m². Mit Bodenvorbereitung: 25–55 €/m². Hanglagen im Chiemgau können die Verlegekosten um 3–8 €/m² erhöhen.' },
      { q: 'Welche Händler liefern in Rosenheim?', a: 'Rasen Schwab GmbH ist der lokale Spezialist direkt in Rosenheim. Für größere Projekte liefern auch Isar Rollrasen und BayernRasen in die Region.' },
      { q: 'Brauche ich in Rosenheim spezielle Rasensorten?', a: 'Für Hanglagen empfiehlt sich Strapazierrasen – er wurzelt tiefer und hält besser. In schattigen Gärten unter altem Baumbestand ist Halbschattenrasen die bessere Wahl.' },
      { q: 'Wann ist der beste Zeitpunkt für Rollrasen im Chiemgau?', a: 'Mai bis Juni und September sind optimal. Die Voralpenregion hat Spätfröste bis Mitte Mai – Pflanzungen erst nach den Eisheiligen sind deutlich sicherer.' },
      { q: 'Wie verlege ich Rollrasen auf einer Hanglage in Rosenheim?', a: 'Rollrasen auf Hängen muss mit Holzheringen oder Jutenetzen gesichert werden, bis er nach 2–3 Wochen fest angewachsen ist. Auf steilen Hängen (über 30%) sollte immer ein Fachbetrieb ausführen.' },
      { q: 'Muss ich trotz des feuchten Chiemgauer Klimas bewässern?', a: 'In den ersten 14 Tagen nach der Verlegung ist tägliches Wässern auch im Chiemgau wichtig – die Wurzeln müssen erst Kontakt zum Untergrund aufbauen. Danach genügt bei normalem Niederschlag oft das natürliche Regenwasser.' },
      { q: 'Was kostet Rollrasen in Hanglagen rund um Rosenheim?', a: 'Hanglagen erhöhen den Aufwand für Bodenvorbereitung, Verlegung und Sicherung. Realistisch sind 3–8 €/m² Aufschlag auf die Verlegekosten – eine Besichtigung vor Ort und ein schriftliches Angebot sind bei Hangprojekten unbedingt empfehlenswert.' },
    ],
  },
  ingolstadt: {
    name: 'Ingolstadt', region: 'Oberbayern', plz: '85049',
    title: 'Rollrasen Ingolstadt – Kosten, Händler & kostenlose Angebote 2026',
    desc:  'Rollrasen in Ingolstadt kaufen & verlegen lassen: Preisrechner, regionale Händler & kostenlose Angebote. Geprüfte Fachbetriebe aus der Region.',
    preisHinweis: 'Ingolstadt liegt günstig zwischen mehreren Herstellern aus Oberbayern und Mittelfranken – gute Ausgangslage für wettbewerbsfähige Preise. Mehrere Angebote einholen lohnt sich: Die Konkurrenz zwischen Betrieben aus beiden Richtungen hält die Preise fair.',
    nachbarStaedte: ['muenchen', 'nuernberg', 'augsburg', 'freising', 'regensburg'],
    intro: `Ingolstadt liegt zentral im Herzen Bayerns – zwischen München im Süden und Nürnberg im Norden. Diese geografische Lage ist rollrasenmäßig ein echter Vorteil: Betriebe aus beiden Richtungen beliefern die Region, was echten Wettbewerb und damit faire Preise schafft. BayernRasen aus Schwabhausen und Schwab Rollrasen aus Pörnbach zählen zu den nächstgelegenen Herstellern.

Das Klima Ingolstadts ist ausgesprochen kontinental – heiße, trockene Sommer gehören zur Norm. Die Jahresdurchschnittstemperatur ist vergleichsweise hoch, die Niederschläge mit rund 620 mm pro Jahr eher gering. Für Rollrasen bedeutet das: Bewässerung ist das A und O. Wer im Frühsommer verlegt und nicht konsequent wässert, riskiert den Misserfolg. Frühjahrspflanzungen (April/Mai) nutzen die Frühjahrs-Niederschläge und sind in Ingolstadt besonders empfehlenswert.

Die Böden im Ingolstädter Raum sind meist sandig bis lehmig-sandig, oft mit kiesigen Anteilen – günstig für die Drainage, erfordern aber Humusergänzung für dauerhaft gutes Rasenwachstum. In stark versiegelten Gewerbegebieten oder auf alten Audi-Werksgeländen sind aufwendigere Bodenvorbereitungen nötig.

Ingolstadts starke Wirtschaft und Bevölkerungswachstum treiben eine hohe Nachfrage nach Rollrasen in Neubaugebieten an: Oberbürgermeister-Viertel, Südwest-Viertel und die wachsenden Vorortgemeinden brauchen regelmäßig schnell fertige Grünflächen.`,
    faq: [
      { q: 'Was kostet Rollrasen in Ingolstadt?', a: 'Material: 5–12 €/m². Inkl. Lieferung und Verlegung: 15–25 €/m². Mit Bodenvorbereitung: 25–55 €/m². Ingolstadt liegt günstig zwischen mehreren Herstellern – faire Preise durch echten Wettbewerb.' },
      { q: 'Welche Händler liefern nach Ingolstadt?', a: 'BayernRasen (Schwabhausen), Schwab Rollrasen (Pörnbach) und Isar Rollrasen (Altheim) liefern alle in den Raum Ingolstadt. PLZ eingeben – wir finden die drei nächsten Betriebe.' },
      { q: 'Wann ist der beste Zeitpunkt für Rollrasen in Ingolstadt?', a: 'April bis Juni ist ideal. Der Ingolstädter Sommer ist oft trocken und heiß – wer im Juli verlegt, muss täglich intensiv wässern. Herbst (September/Oktober) ist eine gute Alternative.' },
      { q: 'Kann ich Rollrasen auch für größere Gewerbeflächen bestellen?', a: 'Ja – regionale Hersteller wie BayernRasen produzieren auf über 100 Hektar Eigenanbau und können große Mengen kurzfristig liefern. Für Projekte über 500 m² lohnt sich ein direkter Kontakt zum Hersteller.' },
      { q: 'Wie wichtig ist die Bewässerung nach der Verlegung in Ingolstadt?', a: 'Sehr wichtig – Ingolstadt gehört zu den trockeneren Standorten in Bayern. In den ersten 3 Wochen täglich wässern, im Sommer zweimal täglich (morgens und abends). Wer das nicht gewährleisten kann, sollte im Frühjahr oder Herbst verlegen.' },
      { q: 'Lohnt sich ein Bewässerungssystem in Ingolstadt?', a: 'Für Flächen ab 100 m² kann eine automatische Bewässerungsanlage eine sinnvolle Investition sein – besonders im trockenen Ingolstädter Klima. Kosten: ab ca. 800–1.500 € für ein einfaches System. Einige Gartenbau-Betriebe installieren beides zusammen.' },
      { q: 'Welche Bodenvorbereitung brauche ich in Ingolstadt?', a: 'Kiesige und sandige Böden im Ingolstädter Raum brauchen eine Humusschicht von 5–8 cm. Bei Neubauten ist Tiefenlockerung und Planieren nötig. Ein Fachbetrieb schätzt den Aufwand vor Ort ein.' },
    ],
  },
  freising: {
    name: 'Freising', region: 'Oberbayern', plz: '85354',
    title: 'Rollrasen Freising – Kosten, Händler & kostenlose Angebote 2026',
    desc:  'Rollrasen in Freising kaufen & verlegen lassen: Preisrechner, regionale Händler & kostenlose Angebote. Geprüfte Fachbetriebe aus der Region.',
    preisHinweis: 'Freising hat eine hervorragende Lieferanbindung: sowohl Münchner Betriebe als auch Isar Rollrasen aus Niederbayern konkurrieren um die Region. Das schafft echten Wettbewerb und faire Preise – hier lohnt es sich, mehrere Angebote einzuholen.',
    nachbarStaedte: ['muenchen', 'landshut', 'ingolstadt', 'regensburg'],
    intro: `Freising liegt verkehrsgünstig zwischen München und dem Niederbayerischen Hügelland – und profitiert rollrasenmäßig von beiden Seiten. Isar Rollrasen aus Altheim ist nur wenige Kilometer entfernt, Münchner Betriebe aus Unterschleißheim und Kirchheim decken den Raum ebenfalls zuverlässig ab. Diese günstige Position zwischen mehreren Anbietern bedeutet echten Preiswettbewerb.

Das Klima in Freising ist mild-kontinental mit rund 800 mm Jahresniederschlag. Der Freisinger Raum gehört nicht zu den Extremstandorten – weder zu heiß noch zu feucht – was Rollrasen zu einer verlässlichen Wahl macht. Die besten Verlegezeiten sind Frühjahr (April–Juni) und Frühherbst (September/Oktober).

Die Böden im Freisinger Raum sind sehr unterschiedlich: In der Isarniederung rund um die Altstadt gibt es tiefgründige, humusreiche Lehmböden – ideal für Rollrasen. Auf den höher gelegenen Schotterterrassen nordöstlich der Stadt sind die Böden sandiger und kiesiger, was gute Drainage bedeutet, aber Humusergänzung erfordert.

Freising ist stark geprägt von Neubaugebieten rund um den Flughafen München (Ober- und Niederding, Hallbergmoos, Eching) – ein Markt mit konstant hoher Nachfrage nach Rollrasen für frisch fertiggestellte Gärten.`,
    faq: [
      { q: 'Was kostet Rollrasen in Freising?', a: 'Material: 5–12 €/m². Inkl. Lieferung und Verlegung: 15–25 €/m². Komplett mit Bodenvorbereitung: 25–55 €/m². Freising liegt sehr günstig zwischen mehreren großen Herstellern – günstige Ausgangslage.' },
      { q: 'Welche Händler liefern nach Freising?', a: 'Isar Rollrasen (Altheim, Niederbayern) ist besonders nah. Zusätzlich liefern Betriebe aus dem Münchner Raum (Unterschleißheim, Kirchheim) nach Freising.' },
      { q: 'Wann ist der beste Zeitpunkt für Rollrasen in Freising?', a: 'April bis Juni und September/Oktober. Das Klima ist gemäßigt – Frühjahrspflanzungen gelingen zuverlässig, wenn der Boden frostfrei ist.' },
      { q: 'Lohnt sich Rollrasen für Neubaugebiete in Freising?', a: 'Besonders ja – Rollrasen ist sofort nutzbar und schützt den Boden schnell vor Erosion. Bei Neubauprojekten rund um den Flughafen München die mit Abstand bevorzugte Wahl.' },
      { q: 'Welche Bodenvorbereitung ist in Freising nötig?', a: 'Das hängt vom Standort ab: Isarniederung-Böden brauchen wenig Aufbereitung, Schotterflächen am Stadtrand benötigen Humusergänzung (5 cm). Bei Neubauflächen ist Fräsen und Planieren Standard.' },
      { q: 'Kann ich Rollrasen in Freising auch selbst verlegen?', a: 'Ja – für Flächen bis 80 m² ist Eigenverlegung gut machbar. Die Bodenvorbereitung ist der aufwendigste Teil. Für größere Flächen oder schwierige Böden empfiehlt sich ein Fachbetrieb.' },
      { q: 'Wie lange bis Rollrasen in Freising begehbar ist?', a: 'Nach 10–14 Tagen ist der Rasen leicht begehbar, nach 3–4 Wochen voll belastbar. Konsequentes Wässern in den ersten 3 Wochen ist entscheidend für diesen Zeitplan.' },
    ],
  },
  fuerth: {
    name: 'Fürth', region: 'Mittelfranken', plz: '90762',
    title: 'Rollrasen Fürth – Kosten, Händler & kostenlose Angebote 2026',
    desc:  'Rollrasen in Fürth kaufen & verlegen lassen: Preisrechner, regionale Händler & kostenlose Angebote. Geprüfte Fachbetriebe aus Mittelfranken.',
    preisHinweis: 'Fürth und Nürnberg bilden einen gemeinsamen Markt mit kurzen Wegen zu Greenkeepers Gartenbau und Noris Rollrasen. Die Preise im Fürther Raum entsprechen dem mittelfränkischen Durchschnitt – Konkurrenz zwischen mehreren lokalen Betrieben sorgt für faire Konditionen.',
    nachbarStaedte: ['nuernberg', 'erlangen', 'ingolstadt', 'wuerzburg'],
    intro: `Fürth und Nürnberg bilden einen gemeinsamen Wirtschafts- und Wohnraum – und sind rollrasenmäßig sehr gut aufgestellt. Die Greenkeepers Gartenbau GbR hat ihren Sitz direkt in Fürth, Noris Rollrasen in Nürnberg ergänzt das Angebot. Kurze Wege, bekannte Betriebe, lokale Expertise.

Das Klima Mittelfrankens ist klar kontinental mit trockenen Sommern und kalten Wintern. Fürth bekommt mit rund 590 mm Jahresniederschlag vergleichsweise wenig Regen – intensive Bewässerung nach der Verlegung ist daher besonders wichtig. Frühjahr und Frühherbst sind die optimalen Verlegezeiten; Hochsommerverlegungen erfordern konsequentes Wässern.

Die Böden in Fürth und Umgebung sind charakteristisch für Mittelfranken: sandsteinhaltig, leicht sauer, mit guter Drainage. Das ist für Rollrasen gut handhabbar, erfordert aber oft eine pH-Korrektur (Kalkung) und Humusergänzung vor der Verlegung. Lokale Betriebe wissen um diese Besonderheit und bereiten Flächen entsprechend vor.

Fürth hat in den letzten Jahren starkes Bevölkerungswachstum erlebt – neue Wohnviertel in Ronhof, Oberfürberg und entlang der Stadtbahn-Achsen sind ein kontinuierlich wachsender Markt für Rollrasen bei Neubau und Gartensanierung.`,
    faq: [
      { q: 'Was kostet Rollrasen in Fürth?', a: 'Material: 5–12 €/m². Inkl. Lieferung und Verlegung: 15–25 €/m². Mit Bodenvorbereitung: 25–55 €/m². Preise entsprechen dem mittelfränkischen Durchschnitt – faire Konditionen durch lokalen Wettbewerb.' },
      { q: 'Welche Händler liefern in Fürth?', a: 'Greenkeepers Gartenbau GbR ist direkt in Fürth ansässig. Noris Rollrasen (Nürnberg) und überregionale Hersteller wie BayernRasen liefern ebenfalls in den Großraum Fürth.' },
      { q: 'Wann ist der beste Zeitpunkt für Rollrasen in Fürth?', a: 'April bis Juni und September. Fürth und Nürnberg haben relativ trockene Sommer – intensive Bewässerung nach der Verlegung ist besonders wichtig.' },
      { q: 'Kann ich Rollrasen in Fürth auch in Eigenleistung verlegen?', a: 'Ja, bei kleineren Flächen gut machbar. Wichtig ist eine ebene, ausreichend lockere Unterlage. Lokale Händler helfen mit Beratung zur richtigen Sorte und Bodenvorbereitung.' },
      { q: 'Muss ich die Böden in Fürth kalkeln?', a: 'Auf den typischen Sandsteinböden Mittelfrankens ist der pH-Wert oft zu niedrig für optimales Rasenwachstum. Eine Kalkung vor der Verlegung (ca. 1–2 €/m²) verbessert die Anwachsrate deutlich.' },
      { q: 'Welche Rasensorte eignet sich für Fürth?', a: 'Gebrauchsrasen und trockenheitstolerante Sorten sind für das trockene Mittelfranken empfehlenswert. Für stark genutzte Gärten (Kinder, Hund) empfiehlt sich Strapazierrasen.' },
      { q: 'Wie lange dauert es bis Rollrasen in Fürth fest angewachsen ist?', a: 'Bei guter Bewässerung und kühlen bis milden Temperaturen (Frühjahr/Herbst) 10–14 Tage. Im Sommer bei Hitze kann es 3–4 Wochen dauern – Bewässerung ist dann entscheidend.' },
    ],
  },
  wuerzburg: {
    name: 'Würzburg', region: 'Unterfranken', plz: '97070',
    title: 'Rollrasen Würzburg – Kosten, Händler & kostenlose Angebote 2026',
    desc:  'Rollrasen in Würzburg kaufen & verlegen lassen: Preisrechner, regionale Händler & kostenlose Angebote. Geprüfte Fachbetriebe aus Unterfranken.',
    preisHinweis: 'Würzburg liegt weiter von den größten bayerischen Produzenten entfernt – Lieferkosten können 3–5 €/m² höher sein als im südbayerischen Raum. Dennoch: Mit einem kostenlosen Angebot-Vergleich finden Sie den günstigsten verfügbaren Betrieb.',
    nachbarStaedte: ['nuernberg', 'erlangen', 'fuerth'],
    intro: `Würzburg ist eine der wärmsten Städte Deutschlands – das milde Weinbauklima am Main macht die Stadt zu einem der klimatisch bevorzugten Rollrasen-Standorte in ganz Bayern. Lange Vegetationsperioden, milde Winter und warme Frühjahre schaffen ideale Bedingungen: Rollrasen wächst hier zuverlässig an, und die Nutzungszeit ist länger als in kälteren Regionen.

Der Nachteil liegt in der Distanz zu den großen bayerischen Rollrasen-Produzenten. Walter Schwab GmbH aus Waidhofen im schwäbischen Raum ist einer der nächsten Produzenten; bayernweit liefernde Hersteller wie BayernRasen, Isar Rollrasen und Sued-Rasen sind ebenfalls verfügbar. Mehrere Angebote einzuholen ist in Würzburg besonders empfehlenswert, da die Preisunterschiede je nach Lieferant spürbar sein können.

Das Klima am Main ist warm und vergleichsweise trocken – Würzburg bekommt mit rund 550 mm Jahresniederschlag ähnlich wenig Regen wie Regensburg. Intensive Bewässerung in den ersten Wochen nach der Verlegung ist daher Pflicht. Die gute Nachricht: Das warme Klima verkürzt die Anwachszeit – bei Frühlingstemperaturen ist Rollrasen in Würzburg schneller durchwurzelt als in kühleren Regionen.

Würzburgs Böden sind oft lehmig-tonig (Muschelkalk-Gebiete), was gute Wasserhaltung bedeutet aber manchmal Drainage-Probleme verursacht. In solchen Lagen ist eine Drainageschicht vor dem Rollrasen sinnvoll.`,
    faq: [
      { q: 'Was kostet Rollrasen in Würzburg?', a: 'Material: 5–12 €/m². Inkl. Lieferung und Verlegung: 15–25 €/m². Mit Bodenvorbereitung: 25–55 €/m². Die etwas weiteren Transportwege von bayerischen Herstellern können die Lieferkosten leicht erhöhen.' },
      { q: 'Welche Händler liefern nach Würzburg?', a: 'Überregionale Hersteller wie BayernRasen, Isar Rollrasen und Sued-Rasen liefern bayernweit – auch nach Würzburg. PLZ eingeben und die drei nächsten Betriebe finden.' },
      { q: 'Wann ist der beste Zeitpunkt für Rollrasen in Würzburg?', a: 'März bis Juni und September/Oktober. Das milde Würzburger Klima ermöglicht frühere Frühjahrspflanzungen als im restlichen Bayern – oft schon ab Ende März.' },
      { q: 'Welche Rasensorte eignet sich für Würzburgs Klima?', a: 'Trockenheitstolerante Gebrauchsrasen-Sorten sind für Würzburg empfehlenswert. Das warme, trockene Maintal-Klima stellt Rasen im Sommer vor Bewässerungs-Anforderungen.' },
      { q: 'Muss ich trotz warmem Klima in Würzburg viel wässern?', a: 'Ja – Würzburg ist einer der trockensten Standorte in Bayern. Besonders in den ersten 3 Wochen nach Verlegung ist tägliches Wässern Pflicht. Ein automatisches Bewässerungssystem kann sich hier langfristig lohnen.' },
      { q: 'Gibt es Drainage-Probleme bei Würzburger Böden?', a: 'Auf lehmig-tonigen Muschelkalk-Böden kann Staunässe ein Problem sein. In solchen Fällen empfiehlt sich eine 5–10 cm Drainageschicht (Kies/Splitt) unter dem Rollrasen. Lokale Betriebe kennen die Problemzonen in Würzburg.' },
      { q: 'Wie früh im Jahr kann ich in Würzburg verlegen?', a: 'Dank des warmen Mainklimas oft schon ab Ende März – wenn der Boden frostfrei und über 8°C warm ist. Das ist 3–4 Wochen früher als in nördlicheren oder höher gelegenen Regionen Bayerns.' },
    ],
  },
  erlangen: {
    name: 'Erlangen', region: 'Mittelfranken', plz: '91052',
    title: 'Rollrasen Erlangen – Kosten, Händler & kostenlose Angebote 2026',
    desc:  'Rollrasen in Erlangen kaufen & verlegen lassen: Preisrechner, regionale Händler & kostenlose Angebote. Geprüfte Fachbetriebe aus Mittelfranken.',
    preisHinweis: 'Erlangen profitiert von seiner Nähe zu Nürnberg – Noris Rollrasen und Greenkeepers Gartenbau liefern zu kurzen Wegen und konkurrenzfähigen Preisen. Die Kosten entsprechen dem mittelfränkischen Durchschnitt.',
    nachbarStaedte: ['nuernberg', 'fuerth', 'bayreuth', 'ingolstadt'],
    intro: `Erlangen liegt direkt nördlich von Nürnberg und ist Teil des starken Wirtschaftsraums Mittelfranken. Rollrasenmäßig profitiert Erlangen von denselben spezialisierten Betrieben wie Nürnberg: Noris Rollrasen und Greenkeepers Gartenbau aus Fürth sind beide in wenigen Minuten erreichbar. Die Universitätsstadt mit ihren vielen Neubaugebieten und Reihenhaussiedlungen ist ein aktiver Rollrasen-Markt.

Das kontinentale Klima Erlangen ist typisch für Mittelfranken: trockene Sommer, kalte Winter, Jahresniederschlag rund 590 mm. Frühjahr und Frühherbst sind die optimalen Verlegezeiten. Besonders die Hochsommerverlegungen erfordern konsequente Bewässerung – ohne die vertrocknet der Rasen in der Anwachsphase.

Die Böden in Erlangen sind ähnlich wie in Nürnberg sandsteinhaltig und leicht sauer. In den Neubaugebieten rund um den Siemens-Campus und in den expandierenden Vorortgemeinden wie Tennenlohe, Büchenbach oder Kriegenbrunn ist verdichteter Aushub die häufigste Herausforderung – gründliches Fräsen und Humuseinarbeitung sind dann nötig.

Erlangen ist bekannt für seine hohe Kaufkraft und anspruchsvolle Kundschaft: Zierrasen und Premium-Sorten werden hier überdurchschnittlich oft nachgefragt. Für repräsentative Gärten in Büchenbacher Hängen oder Bruck lohnen sich hochwertige Rollrasen-Sorten und professionelle Verlegung.`,
    faq: [
      { q: 'Was kostet Rollrasen in Erlangen?', a: 'Material: 5–12 €/m². Inkl. Lieferung und Verlegung: 15–25 €/m². Mit Bodenvorbereitung: 25–55 €/m². Erlangen liegt nah an Nürnberger Betrieben – kurze Wege, faire Preise.' },
      { q: 'Welche Händler liefern nach Erlangen?', a: 'Noris Rollrasen (Nürnberg) und Greenkeepers Gartenbau (Fürth) sind direkt vor Ort. Überregionale Hersteller wie BayernRasen liefern ebenfalls nach Mittelfranken.' },
      { q: 'Wann ist der beste Zeitpunkt für Rollrasen in Erlangen?', a: 'April bis Juni und September. Das kontinentale Klima Mittelfrankens macht Frühjahrspflanzungen nach den Eisheiligen besonders zuverlässig.' },
      { q: 'Lohnt sich Rollrasen für Neubauten in Erlangen?', a: 'Ja – Rollrasen ist bei Neubauprojekten die bevorzugte Wahl: sofort nutzbar, kein Warten auf Keimung und professionelles Erscheinungsbild von Tag eins.' },
      { q: 'Welche Rollrasen-Sorte eignet sich für repräsentative Erlanger Gärten?', a: 'Für anspruchsvolle Gärten ist Zierrasen oder Premium-Gebrauchsrasen empfehlenswert – dichtes, feines Gras, attraktiv und belastbar. Für intensiv genutzte Flächen (Kinder, Hund) besser Strapazierrasen wählen.' },
      { q: 'Was ist bei der Bodenvorbereitung in Erlangen zu beachten?', a: 'Auf sandsteinhaltigem Boden ist eine pH-Kontrolle und gegebenenfalls Kalkung empfehlenswert. Bei Neubauten: Tiefenlockerung (30 cm), Planieren und Humuseinarbeitung (5 cm). Lokale Betriebe kennen die typischen Bodenprobleme in Erlangens Stadtteilen.' },
      { q: 'Gibt es auch Rollrasen für Dachgärten oder Balkone in Erlangen?', a: 'Spezielle leichte Rollrasen-Systeme für Dachgärten und Balkone sind möglich, aber eher selten. Die meisten Hersteller beraten auf Anfrage – Gewichtslimits und Drainage müssen vorab geprüft werden.' },
    ],
  },
  bayreuth: {
    name: 'Bayreuth', region: 'Oberfranken', plz: '95444',
    title: 'Rollrasen Bayreuth – Kosten, Händler & kostenlose Angebote 2026',
    desc:  'Rollrasen in Bayreuth kaufen & verlegen lassen: Preisrechner, regionale Händler & kostenlose Angebote. Geprüfte Fachbetriebe aus Oberfranken.',
    preisHinweis: 'Bayreuth liegt etwas weiter von den Hauptproduktionsbetrieben entfernt – Transportkosten von Nürnberger Betrieben können die Gesamtkosten leicht erhöhen. Mehrere Angebote einholen um den günstigsten Lieferanten zu finden.',
    nachbarStaedte: ['erlangen', 'nuernberg', 'regensburg'],
    intro: `Bayreuth und Oberfranken sind die nördlichste Region Bayerns – mit einem raueren, kühleren Klima als Oberbayern. Das stellt eigene Anforderungen an Rollrasen: Frostresistente Sorten, die auch strengen Oberfränkischen Wintern standhalten, sind wichtiger als anderswo in Bayern. Der späte Frühlingsbeginn bedeutet, dass Verlegung frühestens Mitte Mai sicher ist – nach den Eisheiligen.

Die Versorgungslage in Bayreuth ist gut: Betriebe aus dem Großraum Nürnberg – Noris Rollrasen und Greenkeepers Gartenbau – liefern zuverlässig in die Region. Die etwas weiteren Transportwege sind einzuplanen, aber für ein frisches, hochwertiges Endprodukt kein Hindernis.

Das Klima in Bayreuth ist kontinental mit deutlicher Saisonalität. Die Jahrestemperatur ist etwas niedriger als in Südbayern, die Vegetationszeit kürzer. Für Rollrasen bedeutet das: Im Frühjahr später verlegen (Mai statt April), im Herbst früher abschließen (bis Mitte Oktober). Die Frühjahrsniederschläge in Oberfranken sind ausreichend für gutes Anwachsen.

Die Böden rund um Bayreuth sind oft tonig-lehmig im Talboden und kalkhaltiger auf den Höhenzügen. Beide Bodentypen eignen sich für Rollrasen – mit der richtigen Vorbereitung. In Hanglagen (typisch für das Bayreuther Stadtbild) ist Erosionsschutz beim Verlegen wichtig.`,
    faq: [
      { q: 'Was kostet Rollrasen in Bayreuth?', a: 'Material: 5–12 €/m². Inkl. Lieferung und Verlegung: 15–25 €/m². Mit Bodenvorbereitung: 25–55 €/m². Transportkosten von Nürnberger Betrieben sind bei der Kalkulation einzuplanen.' },
      { q: 'Welche Händler liefern nach Bayreuth?', a: 'Noris Rollrasen (Nürnberg) und Greenkeepers Gartenbau (Fürth) liefern in den Raum Oberfranken. Überregionale Hersteller wie Isar Rollrasen und BayernRasen sind ebenfalls verfügbar.' },
      { q: 'Wann ist der beste Zeitpunkt für Rollrasen in Bayreuth?', a: 'Mai bis Juni und September. Oberfranken hat längere Winterperioden als Südbayern – Pflanzungen erst nach den Eisheiligen (Mitte Mai) sind deutlich sicherer.' },
      { q: 'Welche Sorte eignet sich für Oberfranken?', a: 'Robuste Strapazierrasen-Sorten mit guter Frosttoleranz sind ideal. Lokale Händler beraten zu den besten Sorten für Bayreuths Bodenverhältnisse und das raue oberfränkische Klima.' },
      { q: 'Wie gehe ich mit Hanglagen in Bayreuth um?', a: 'Hanglagen sind in Bayreuth häufig. Rollrasen auf Hängen muss mit Heringen gesichert werden bis er angewachsen ist. Auf steilen Hängen (über 30%) empfiehlt sich immer ein Fachbetrieb mit Erfahrung in Hangverlegung.' },
      { q: 'Kann ich Rollrasen in Bayreuth noch im Oktober verlegen?', a: 'Ja, aber nur bis Mitte Oktober – nach den ersten Frösten sollte kein Rollrasen mehr verlegt werden. In Oberfranken kommen Herbstfröste früher als in Südbayern; frühherbstliche Verlegung bis Ende September ist die sicherste Option.' },
      { q: 'Welche Bodenvorbereitung ist in Bayreuth typisch?', a: 'Auf tonig-lehmigen Böden im Talboden ist Drainageverbesserung wichtig. Auf kalkhaltigen Böden der Höhenzüge pH-Wert prüfen. Bei Neubauflächen: Fräsen, Planieren und Humuseinarbeitung wie üblich.' },
    ],
  },
  passau: {
    name: 'Passau', region: 'Niederbayern', plz: '94032',
    title: 'Rollrasen Passau – Kosten, Händler & kostenlose Angebote 2026',
    desc:  'Rollrasen in Passau kaufen & verlegen lassen: Preisrechner, regionale Händler & kostenlose Angebote. Geprüfte Fachbetriebe aus Niederbayern.',
    preisHinweis: 'Passau liegt am östlichen Rand Bayerns – Betriebe aus dem Landshuter Raum (Isar Rollrasen, Nodes Gartenbau) beliefern die Region mit etwas längeren Transportwegen. Transportkosten realistisch einkalkulieren.',
    nachbarStaedte: ['regensburg', 'landshut', 'freising'],
    intro: `Passau liegt an der Dreiflüssestadt-Lage von Inn, Ilz und Donau – mit einem Klima, das für Rollrasen hervorragende Bedingungen schafft. Das Drei-Flüsse-Klima bringt ausreichend Niederschläge und milde Temperaturen; der Passauer Raum zählt zu den niederschlagsreichsten in Niederbayern. Rollrasen wächst hier schnell und üppig an.

Isar Rollrasen aus Altheim und Nodes Gartenbau aus Essenbach sind die nächsten niederbayerischen Spezialisten – ein Stück weiter als bei Landshut, aber zuverlässig für den Passauer Raum. Für große Projekte stehen bayernweite Hersteller zur Verfügung.

Die Böden im Passauer Raum sind vielschichtig: Im Donautal und entlang der Flussniederlassungen gibt es fruchtbare Auenböden mit gutem Wasserhaltevermögen. Auf den angrenzenden Hochflächen und Hanglagen (Passau ist sehr hügelig) findet sich eher tonig-kristalliner Boden. Besonders an den stadtprägenden Hängen – Innstadt, Ilzstadt, Inngebiet – ist bei der Verlegung Hangschutz wichtig.

Passau hat viele historische Gärten und Terrassengärten an den Steilhängen – eine eigene Kategorie mit besonderen Anforderungen. Erfahrene lokale Betriebe kennen diese Besonderheiten und können individuell beraten.`,
    faq: [
      { q: 'Was kostet Rollrasen in Passau?', a: 'Material: 5–12 €/m². Inkl. Lieferung und Verlegung: 15–25 €/m². Mit Bodenvorbereitung: 25–55 €/m². Transportwege von Landshuter Betrieben sind realistisch einzuplanen.' },
      { q: 'Welche Händler liefern nach Passau?', a: 'Isar Rollrasen (Altheim) und Nodes Gartenbau (Essenbach) decken Niederbayern ab. Für größere Projekte stehen bayernweite Hersteller wie BayernRasen und Sued-Rasen zur Verfügung.' },
      { q: 'Wann ist der beste Zeitpunkt für Rollrasen in Passau?', a: 'April bis Juni und September/Oktober. Das feuchte Klima im Passauer Raum begünstigt schnelles Anwachsen – Frühjahrsverlegungen sind besonders zuverlässig.' },
      { q: 'Kann ich Rollrasen auch in Hanglagen in Passau verlegen?', a: 'Ja, aber Hanglagen erfordern spezielle Verlegetechnik und Erosionsschutz. Passaus viele Steilhänge sind typisch – ein erfahrener Fachbetrieb sichert den Rasen mit Heringen und berät zur besten Vorgehensweise.' },
      { q: 'Brauche ich in Passau wegen der vielen Niederschläge weniger wässern?', a: 'In der Anwachsphase (erste 2–3 Wochen) sollte trotzdem täglich gewässert werden – auch wenn es regnet. Flachregen reicht oft nicht aus; nur gezielte Bewässerung direkt am Rasen sichert die Durchwurzelung.' },
      { q: 'Gibt es Rollrasen-Betriebe auch in der österreichischen Grenzregion?', a: 'Deutsche Betriebe liefern bis an die Grenze; österreichische Anbieter sind nach deutschem Recht und Preisrecht eigenständig. Für Passau empfehlen wir bayerische Betriebe – Garantie, Gewährleistung und Ansprechpartner auf deutschem Rechtsgebiet.' },
      { q: 'Was sind die größten Herausforderungen bei Rollrasen in Passau?', a: 'Die Hanglagen sind die größte Besonderheit – technisch aufwendiger als flache Flächen. Außerdem können Hochwassergefährdete Zonen (Donautal) nach starken Regenfällen den Rasen belasten. Lokale Betriebe kennen diese Risiken und beraten entsprechend.' },
    ],
  },
  kempten: {
    name: 'Kempten', region: 'Allgäu', plz: '87435',
    title: 'Rollrasen Kempten – Kosten, Händler & kostenlose Angebote 2026',
    desc:  'Rollrasen in Kempten kaufen & verlegen lassen: Preisrechner, regionale Händler & kostenlose Angebote. Geprüfte Fachbetriebe aus dem Allgäu.',
    preisHinweis: 'Kempten liegt am südlichen Rand Bayerns – Walter Schwab GmbH aus Waidhofen und überregionale Betriebe liefern in die Region. Im Allgäu können Hanglagen und weite Transportwege den Gesamtpreis leicht erhöhen.',
    nachbarStaedte: ['augsburg', 'rosenheim', 'muenchen'],
    intro: `Kempten im Allgäu liegt am Rand der Alpen – mit einem Klima, das zu den niederschlagsreichsten in ganz Bayern zählt. Über 1.100 mm Regen pro Jahr bedeuten: Rollrasen wächst hier üppig und benötigt nach dem Anwachsen vergleichsweise wenig Bewässerungsaufwand. Die kühlen, feuchten Sommer sind für Gras ideal, die Vegetationszeit ist allerdings kürzer als im Münchner Raum.

Walter Schwab GmbH aus Waidhofen in Schwaben ist einer der nächsten Hersteller. Überregionale Betriebe liefern ins gesamte Allgäu – die etwas weiteren Transportwege im Allgäu sind einzuplanen.

Das Klima stellt spezifische Anforderungen: Die Sommer sind kurz und kühl, die Winter lang und schneereich. Rollrasen sollte im Allgäu erst nach den Eisheiligen (Mitte Mai) verlegt werden – Spätfröste bis Ende April sind keine Seltenheit. Die optimale Verlege-Saison ist Mai bis September, wobei Juli und August die intensivste Nutzungszeit sind.

Die Böden rund um Kempten sind häufig schwer und lehmig – typisch für das Alpenvorland. Gute Drainage ist entscheidend: Staunässe bei schweren Lehmböden kann Rollrasen schädigen. Eine Drainageschicht unter dem Rollrasen ist bei problematischen Standorten empfehlenswert.

Hanglagen sind im Allgäu allgegenwärtig – für die Rollrasen-Verlegung bedeutet das technischen Mehraufwand und entsprechend sorgfältige Planung mit dem ausführenden Betrieb.`,
    faq: [
      { q: 'Was kostet Rollrasen in Kempten?', a: 'Material: 5–12 €/m². Inkl. Lieferung und Verlegung: 15–25 €/m². Mit Bodenvorbereitung: 25–55 €/m². Im Allgäu können Hanglagen und etwas weitere Transportwege den Gesamtpreis leicht erhöhen.' },
      { q: 'Welche Händler liefern nach Kempten?', a: 'Walter Schwab GmbH (Waidhofen, Schwaben) ist einer der nächsten Hersteller. Ergänzend liefern BayernRasen und Sued-Rasen bayernweit – auch ins Allgäu.' },
      { q: 'Wann ist der beste Zeitpunkt für Rollrasen in Kempten?', a: 'Mai bis September. Das Allgäuer Klima hat Spätfröste bis Mitte Mai – Pflanzungen erst danach sind sicherer. Die hohen Niederschläge erleichtern dann das Anwachsen erheblich.' },
      { q: 'Eignet sich Rollrasen für das feuchte Allgäuer Klima?', a: 'Besonders gut – hohe Niederschläge bedeuten weniger Bewässerungsaufwand und schnelleres Anwachsen. Strapazierrasen ist für kurze Allgäuer Sommer und intensive Nutzung ideal.' },
      { q: 'Was muss ich bei schweren Lehmböden in Kempten beachten?', a: 'Schwere Lehmböden können zu Staunässe führen, die Rollrasen schädigt. Eine Drainageschicht aus Kies (5–8 cm) unter dem Rollrasen schützt davor. Ein Fachbetrieb prüft den Boden vor Ort und empfiehlt die nötige Maßnahme.' },
      { q: 'Wie gehe ich mit Hanglagen im Allgäu um?', a: 'Hanglagen sind im Allgäu die Norm. Rollrasen muss auf Hängen gesichert werden (Holzheringe, Jutenetze) bis er nach 2–3 Wochen angewachsen ist. Auf steilen Hängen immer einen erfahrenen Fachbetrieb beauftragen.' },
      { q: 'Wie lange ist die Rollrasen-Saison in Kempten?', a: 'Von Mitte Mai (nach Eisheiligen) bis Ende September/Anfang Oktober. Im Oktober können frühe Fröste die Anwachsphase gefährden. Für etwa 4 Monate optimale Verlegebedingungen – kürzer als im Münchner Raum, aber dafür sehr verlässlich.' },
    ],
  },
};

const stadtCss = `<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;font-size:1rem;line-height:1.7;color:#222;background:#fafaf8}
  .st-header{background:#2d6a2d;padding:1rem 1.5rem;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.75rem}
  .st-header a{color:#fff;text-decoration:none;font-weight:700;font-size:1rem}
  .st-header .nav-links{display:flex;gap:1.25rem}
  .st-header .nav-links a{font-size:.85rem;font-weight:400;opacity:.85}
  .st-header .nav-links a:hover{opacity:1}
  .st-hero{background:linear-gradient(rgba(26,61,18,0.80),rgba(45,106,45,0.75)),url('/public/img/tautropfen-rasen.webp') center/cover no-repeat;color:#fff;padding:3rem 1.5rem 2.5rem;text-align:center}
  .st-hero h1{font-size:2rem;font-weight:800;margin:.5rem 0;color:#fff}
  .st-hero p{opacity:1;max-width:560px;margin:.75rem auto 0;font-size:.95rem;color:#fff;text-shadow:0 1px 4px rgba(0,0,0,0.55)}
  .st-hero .breadcrumb{font-size:.78rem;opacity:.6;margin-bottom:.5rem}
  .wrap{max-width:800px;margin:0 auto;padding:2.5rem 1.5rem 5rem}
  h2{font-size:1.25rem;color:#1a3d12;font-weight:700;margin:2.5rem 0 .75rem;padding-bottom:.5rem;border-bottom:2px solid #d4e8c8}
  h3{font-size:1rem;color:#2d6a2d;font-weight:700;margin:1.25rem 0 .4rem}
  p{color:#444;margin-bottom:.75rem}
  .intro-box{background:#f4f8f4;border-left:4px solid #2d6a2d;border-radius:4px;padding:1.25rem 1.5rem;margin:2rem 0;color:#333;line-height:1.8}
  .dealer-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:1rem;margin:1rem 0 2rem}
  .dealer-card{background:#fff;border:1px solid #d4e8c8;border-radius:10px;padding:1.25rem;box-shadow:0 1px 4px rgba(0,50,0,.06)}
  .dealer-card strong{color:#1a3d12;font-size:1rem;display:block;margin-bottom:.25rem}
  .dealer-card small{color:#888;font-size:.78rem}
  .dealer-card .rating{color:#f59e0b;font-size:.88rem;margin:.3rem 0}
  .dealer-badge-pill{display:inline-block;background:#dcfce7;color:#166534;border-radius:10px;padding:1px 8px;font-size:.72rem;font-weight:700;margin-left:4px;vertical-align:middle}
  .cta-block{background:#2d6a2d;color:#fff;border-radius:12px;padding:2rem;text-align:center;margin:2.5rem 0}
  .cta-block h2{color:#fff;border:none;margin:0 0 .5rem;font-size:1.2rem}
  .cta-block p{color:rgba(255,255,255,.8);margin:0 0 1.25rem;font-size:.92rem}
  .cta-btn{display:inline-block;background:#fff;color:#2d6a2d;font-weight:700;padding:.75rem 2rem;border-radius:6px;text-decoration:none;font-size:1rem}
  .cta-btn:hover{background:#f0f7f0}
  .faq-item{border-bottom:1px solid #e8f0e8;padding:.75rem 0}
  .faq-item:last-child{border-bottom:none}
  .faq-q{font-weight:600;color:#1a3d12;margin-bottom:.3rem}
  .faq-a{color:#555;font-size:.93rem}
  .city-links{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem 0 2rem}
  .city-link{background:#f4f8f4;border:1px solid #d4e8c8;border-radius:6px;padding:.4rem 1rem;color:#2d6a2d;text-decoration:none;font-size:.88rem;font-weight:500}
  .city-link:hover{background:#e8f5e8;border-color:#2d6a2d}
  .dealer-note{font-size:.85rem;color:#666;background:#f9fbf9;border-radius:6px;padding:.75rem 1rem;margin-top:.75rem;border:1px solid #e8f0e8}
  footer{text-align:center;font-size:.78rem;color:#999;margin-top:3rem;padding-top:1rem;border-top:1px solid #e0e8e0}
  footer a{color:#2d6a2d}
  @media(max-width:600px){.st-hero h1{font-size:1.5rem}.dealer-grid{grid-template-columns:1fr}}
</style>`;

app.get('/:city', (req, res, next) => {
  const stadt = STAEDTE[req.params.city];
  if (!stadt) return next();
  return res.redirect(301, `/bayern/${req.params.city}`);
});

app.get('/bayern/:city', (req, res, next) => {
  const stadt = STAEDTE[req.params.city];
  if (!stadt) return next();

  const top3  = findNearestHaendler(stadt.plz);
  const BADGE = { partner: 'Geprüfter Händler', pro: 'Professional Partner', premium: 'Premium Partner' };

  const dealerCards = top3.map(h => `
    <div class="dealer-card">
      <strong>${h.name}</strong>
      ${h.typ === 'Hersteller' ? '<small>Rollrasen-Hersteller · Lieferung &amp; Verlegung</small>' : '<small>Gartenbau-Fachbetrieb · Beratung &amp; Verlegung</small>'}
      ${h.google_bewertung ? `<div class="rating">★ ${h.google_bewertung.toFixed(1)} <span style="color:#999">(${h.google_bewertungen_anzahl} Bewertungen)</span></div>` : ''}
      ${h.ort ? `<div style="font-size:.82rem;color:#666;margin:.2rem 0">📍 ${h.ort}</div>` : ''}
      ${BADGE[h.paket] ? `<span class="dealer-badge-pill">${BADGE[h.paket]}</span>` : ''}
      ${h.profil_slug ? `<div style="margin-top:.5rem"><a href="/haendler/${h.profil_slug}" style="color:#2d6a2d;font-size:.82rem;text-decoration:none">→ Profil &amp; Kontakt ansehen</a></div>` : ''}
    </div>`).join('');

  const nachbarLinks = (stadt.nachbarStaedte || [])
    .filter(slug => STAEDTE[slug])
    .map(slug => `<a class="city-link" href="/bayern/${slug}">Rollrasen ${STAEDTE[slug].name}</a>`)
    .join('');

  const faqHtml = stadt.faq.map(f => `
    <div class="faq-item">
      <div class="faq-q">${f.q}</div>
      <div class="faq-a">${f.a}</div>
    </div>`).join('');

  const faqSchema = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: stadt.faq.map(f => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  });

  res.send(`<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${stadt.title}</title>
  <meta name="description" content="${stadt.desc}">
  <link rel="canonical" href="https://www.rasenrechner.de/bayern/${req.params.city}">
  <meta property="og:title" content="${stadt.title}">
  <meta property="og:description" content="${stadt.desc}">
  <meta property="og:url" content="https://www.rasenrechner.de/bayern/${req.params.city}">
  <meta property="og:type" content="website">
  <script type="application/ld+json">${faqSchema}</script>
  ${stadtCss}
</head>
<body>
  <header class="st-header">
    <a href="/bayern/">🌿 rasenrechner.de</a>
    <nav class="nav-links">
      <a href="/bayern/#rechner">Preisrechner</a>
      <a href="/bayern/#anfrage">Angebot anfragen</a>
    </nav>
  </header>

  <div class="st-hero">
    <div class="breadcrumb"><a href="/bayern/" style="color:rgba(255,255,255,.6);text-decoration:none">rasenrechner.de</a> › ${stadt.name}</div>
    <h1>Rollrasen ${stadt.name}</h1>
    <p>Preise, geprüfte Händler & kostenlose Angebote aus ${stadt.region}</p>
  </div>

  <div class="wrap">
    <div class="intro-box">${stadt.intro}</div>

    <h2>Händler in ${stadt.name} & Umgebung</h2>
    <div class="dealer-grid">${dealerCards || '<p>Aktuell keine Händler-Daten verfügbar.</p>'}</div>
    <p class="dealer-note">Alle aufgeführten Betriebe sind geprüfte Fachbetriebe aus der Region. PLZ eingeben und kostenlose Angebote direkt vergleichen – unverbindlich und ohne Weitergabe Ihrer Daten an Dritte ohne Ihre Zustimmung.</p>

    <div class="cta-block">
      <h2>Kostenloses Angebot für ${stadt.name} anfragen</h2>
      <p>PLZ eingeben – wir verbinden Sie sofort mit den nächsten Fachbetrieben. Kostenlos & unverbindlich.</p>
      <a class="cta-btn" href="/bayern/?plz=${stadt.plz}#rechner">Jetzt Bedarf berechnen &amp; anfragen →</a>
    </div>

    <h2>Preise für Rollrasen in ${stadt.name}</h2>
    <table style="width:100%;border-collapse:collapse;margin:1rem 0;font-size:.92rem">
      <tr style="background:#f4f8f4"><td style="padding:9px 14px;color:#555">Rollrasen Material</td><td style="padding:9px 14px;font-weight:700;color:#2d6a2d">5–12 €/m²</td></tr>
      <tr><td style="padding:9px 14px;color:#555">Inkl. Lieferung & Verlegung</td><td style="padding:9px 14px;font-weight:700;color:#2d6a2d">15–25 €/m²</td></tr>
      <tr style="background:#f4f8f4"><td style="padding:9px 14px;color:#555">Komplett inkl. Bodenvorbereitung</td><td style="padding:9px 14px;font-weight:700;color:#2d6a2d">25–55 €/m²</td></tr>
    </table>
    <p style="font-size:.9rem;color:#555;margin-top:.5rem">${stadt.preisHinweis || ''}</p>
    <p style="font-size:.85rem;color:#888">Alle Angaben inkl. MwSt. Bodenvorbereitung (Fräsen, Planieren, Humus) wird separat kalkuliert. <a href="/bayern/" style="color:#2d6a2d">Preisrechner nutzen →</a></p>

    <h2>Häufige Fragen – Rollrasen ${stadt.name}</h2>
    <div>${faqHtml}</div>

    ${nachbarLinks ? `<h2>Rollrasen in weiteren Städten Bayerns</h2>
    <p style="color:#555;margin-bottom:.75rem">Wir verbinden Sie auch in diesen Regionen mit geprüften Fachbetrieben:</p>
    <div class="city-links">${nachbarLinks}</div>` : ''}

    <footer>rasenrechner.de · Ein Service der Gartenschmiede GmbH ·
      <a href="/impressum">Impressum</a> · <a href="/datenschutz">Datenschutz</a>
    </footer>
  </div>
</body>
</html>`);
});

// ─── CHATBOT ─────────────────────────────────────────────────────────────────

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

const CHAT_SYSTEM = `Du bist "Grasi", ein freundlicher Rollrasen-Experte für rasenrechner.de – das bayerische Portal für Rollrasen und Fertigrasen.

WICHTIG: Antworte immer in einfachem Fließtext. Kein Markdown, keine Sternchen, keine Aufzählungszeichen mit Bindestrichen, keine Überschriften. Schreib wie ein Mensch spricht – kurze, direkte Sätze.

Dein Wissen:
Rollrasen kostet als Material 5,50 bis 9 Euro pro m² je nach Sorte (Spielwiese 5,50, Sportrasen 6,50, Halbschatten 8,50, Premium 9,00). Verlegung durch einen Fachbetrieb kostet zusätzlich 5–12 Euro pro m², Bodenvorbereitung (Fräsen, Planieren, Humus) nochmals 5–15 Euro pro m². Realistisch komplett: 25–55 Euro pro m². Lieferung kostet je nach Menge 60–280 Euro. Immer 5–10 % Verschnitt einplanen. Beste Verlegezeit ist Frühling und Herbst. Nach dem Verlegen 2–3 Wochen täglich bewässern.

Über rasenrechner.de:
Kostenloses Vergleichsportal für Bayern. Nutzer berechnen ihren Bedarf mit dem Verlegerechner, dann fordern sie kostenlos und unverbindlich Angebote von regionalen Händlern an – aus ihrer PLZ-Region. Die Händler sind aus ganz Bayern (München, Nürnberg, Augsburg usw.), kennen den lokalen Boden und das Klima, und liefern frisch. Der Vorteil: Mehrere echte Angebote gleichzeitig, kein Listenpreis.

Kommunikationsstil:
Antworte auf Deutsch, immer in 2–4 Sätzen Fließtext. Keine Listen, keine Markdown-Formatierung. Konkrete Zahlen nennen. Bei Interesse am Kauf: den Rechner empfehlen und danach ein Angebot anfragen. Ehrlich bleiben, kein Marketing-Sprech.`;

const chatLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });

app.post('/chat', chatLimiter, async (req, res) => {
  const { message, history = [] } = req.body || {};
  if (!message || typeof message !== 'string' || message.length > 800) {
    return res.status(400).json({ error: 'Ungültige Nachricht' });
  }
  if (!ANTHROPIC_KEY) {
    return res.json({ reply: 'Der Assistent ist gerade nicht verfügbar. Bitte nutzen Sie das Kontaktformular.' });
  }
  try {
    const safeHistory = Array.isArray(history)
      ? history.slice(-10).filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      : [];
    const messages = [
      ...safeHistory.map(m => ({ role: m.role, content: m.content.slice(0, 800) })),
      { role: 'user', content: String(message).slice(0, 800) }
    ];
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, system: CHAT_SYSTEM, messages })
    });
    const data = await apiRes.json();
    const reply = data.content?.[0]?.text?.trim() || 'Ich konnte Ihre Frage leider nicht beantworten.';
    res.json({ reply });
  } catch (e) {
    console.error('Chat-Fehler:', e.message);
    res.status(500).json({ reply: 'Der Assistent ist gerade nicht erreichbar. Bitte nutzen Sie das Kontaktformular.' });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────

const haendlerCount = db.prepare('SELECT COUNT(*) as c FROM hersteller WHERE aktiv = 1').get().c;
app.listen(PORT, () => {
  console.log(`\nRollrasen-Portal läuft auf http://localhost:${PORT}`);
  console.log(`E-Mail:    ${transporter ? '✓ ' + SMTP_USER : '✗ nicht konfiguriert (nur Logging)'}`);
  console.log(`Händler:   ${haendlerCount} aktive Betriebe in der DB\n`);
});
