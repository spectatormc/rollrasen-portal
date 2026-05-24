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

  const badge   = BADGE_HTML[h.paket] || '';
  const adresse = [h.strasse, h.plz && h.ort ? `${h.plz} ${h.ort}` : h.ort].filter(Boolean).join(', ');
  const mapsUrl = adresse ? `https://www.google.com/maps/search/${encodeURIComponent(h.name + ' ' + adresse)}` : null;
  const sterne  = h.google_bewertung ? `<span style="color:#f59e0b;font-size:1.1rem">★</span> <strong>${h.google_bewertung.toFixed(1)}</strong> <span style="color:#888;font-size:0.85rem">(${h.google_bewertungen_anzahl} Bewertungen auf Google)</span>` : '';

  const videoBlock = h.video_url ? `
    <div style="margin:2rem 0;border-radius:10px;overflow:hidden;aspect-ratio:16/9;background:#000">
      <iframe src="${h.video_url}" style="width:100%;height:100%;border:none" allowfullscreen loading="lazy"></iframe>
    </div>` : '';

  res.send(`<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${h.name} – Rollrasen-Händler | rasenrechner.de</title>
  <meta name="description" content="${h.name} aus ${h.ort || 'Bayern'} – regionaler Rollrasen-Fachbetrieb. ${h.profil_text ? h.profil_text.slice(0,120) + '...' : 'Kostenlose Angebote anfragen auf rasenrechner.de.'}">
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
    <h1>${h.name}</h1>
    <div style="margin:.5rem 0">${badge}</div>
    <p>${h.typ === 'Hersteller' ? 'Rollrasen-Hersteller' : 'Rollrasen-Fachbetrieb'}${h.ort ? ' · ' + h.ort : ''}${h.region ? ' · ' + h.region : ''}</p>
  </div>

  <div class="wrap" style="padding-top:0">
    ${videoBlock}

    ${h.profil_text ? `<p class="profil-text">${h.profil_text}</p>` : ''}

    ${sterne ? `<p style="margin:1rem 0">${sterne}</p>` : ''}

    <div class="contact-card">
      <strong style="color:#1a3d12;font-size:.85rem;text-transform:uppercase;letter-spacing:.05em">Kontakt</strong>
      ${h.telefon ? `<div class="contact-row">📞 <a href="tel:${h.telefon.replace(/\s/g,'')}">${h.telefon}</a></div>` : ''}
      ${h.email   ? `<div class="contact-row">✉️ <a href="mailto:${h.email}">${h.email}</a></div>` : ''}
      ${h.website ? `<div class="contact-row">🌐 <a href="${h.website}" target="_blank" rel="noopener">${h.website.replace(/^https?:\/\//,'')}</a></div>` : ''}
      ${adresse   ? `<div class="contact-row">📍 ${adresse}</div>` : ''}
      ${mapsUrl   ? `<a class="maps-link" href="${mapsUrl}" target="_blank" rel="noopener">🗺️ Auf Google Maps anzeigen →</a>` : ''}
    </div>

    <div class="cta-block">
      <h2>Kostenloses Angebot anfragen</h2>
      <p style="opacity:.85;font-size:.9rem;margin:0 0 .25rem">Unverbindlich, direkt vom Fachbetrieb, Antwort in 24h</p>
      <a class="cta-btn" href="/bayern/${h.plz ? '?plz=' + h.plz + '#rechner' : '#rechner'}">Jetzt Bedarf berechnen &amp; anfragen</a>
    </div>

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
  const { name, email, phone, plz, m2, product, message } = req.body;

  if (!name?.trim() || !email?.trim())
    return res.status(400).json({ error: 'Name und E-Mail sind Pflichtfelder' });

  const plzClean     = (plz || '').replace(/\D/g, '').slice(0, 5);
  const top3         = findNearestHaendler(plzClean);
  const produktLabel = PRODUKT_LABELS[product] || product || 'nicht angegeben';
  const m2Display    = m2 ? Math.round(m2) + ' m²' : 'nicht angegeben';

  // In DB speichern
  db.prepare(`
    INSERT INTO anfragen (name, email, phone, plz, m2, product, message, haendler_count, haendler_names)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name.trim(), email.trim(), phone?.trim() || null,
    plzClean || null, m2 || null, product?.trim() || null,
    message?.trim() || null, top3.length,
    top3.map(h => h.name).join(', ')
  );

  console.log(`📋 Neue Anfrage: ${name} (${email}) – ${m2Display} ${produktLabel}, PLZ ${plzClean} → ${top3.length} Händler: ${top3.map(h=>h.name).join(', ')}`);

  // ── Kunden-Bestätigungsmail ────────────────────────────────────────────────
  const haendlerRows = top3.map((h, i) => haendlerKontaktHtml(h, i % 2 === 1)).join('');

  const kundenMail = `
    <div style="font-family:sans-serif;max-width:600px;color:#222;margin:0 auto">
      <div style="background:#2d6a2d;padding:28px 24px;border-radius:8px 8px 0 0">
        <h2 style="color:#fff;margin:0;font-size:1.3rem">Ihre Rollrasen-Anfrage ist eingegangen</h2>
      </div>
      <div style="background:#fff;padding:24px;border:1px solid #dde8dd;border-top:none;border-radius:0 0 8px 8px">
        <p>Hallo ${escHtml(name)},</p>
        <p>wir haben Ihre Anfrage erhalten und <strong>${top3.length} Fachbetrieb${top3.length !== 1 ? 'e' : ''}</strong> in Ihrer Region kontaktiert.
           Diese melden sich in der Regel <strong>innerhalb von 24 Stunden</strong> direkt bei Ihnen.</p>

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
          Kontaktierte Betriebe in Ihrer Nähe
        </h3>
        <table style="border-collapse:collapse;width:100%">
          ${haendlerRows}
        </table>

        <p style="margin-top:1.5rem;color:#555;font-size:0.9rem">
          Sollten Sie keine Rückmeldung erhalten, können Sie die Betriebe auch direkt über die oben angegebenen Kontaktdaten erreichen.
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
        <h2 style="color:#fff;margin:0;font-size:1.25rem">Rollrasen-Anfrage in Ihrer Region</h2>
      </div>
      <div style="background:#fff;padding:28px;border:1px solid #dde8dd;border-top:none;border-radius:0 0 8px 8px">
        <p style="margin-top:0">Guten Tag,</p>
        <p>über <a href="https://www.rasenrechner.de" style="color:#2d6a2d">rasenrechner.de</a> ist eine neue Anfrage eingegangen, die wir Ihnen als nächstgelegenem Fachbetrieb weiterleiten.</p>
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
        <p>Der Kunde erwartet eine Rückmeldung <strong>innerhalb von 24 Stunden</strong>. Bitte nehmen Sie direkt per E-Mail oder Telefon Kontakt auf.</p>
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

    const empfaenger = ADMIN_EMAIL
      ? [ADMIN_EMAIL]
      : top3.filter(h => h.email).map(h => h.email);

    for (const empf of empfaenger) {
      await sendMail(empf, `Neue Rollrasen-Anfrage – ${m2Display}, PLZ ${plzClean}`, haendlerMail);
    }

    res.json({ ok: true, haendler_count: top3.length, region: top3[0]?.region || 'Bayern' });
  } catch (err) {
    console.error(`Mail-Fehler: ${err.message}`);
    res.json({ ok: true, haendler_count: top3.length, region: top3[0]?.region || 'Bayern' });
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
    '/bayern/landshut', '/bayern/rosenheim', '/bayern/ingolstadt', '/bayern/freising', '/bayern/fuerth'];

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
    intro: 'München und das Umland zählen zu den besten Gebieten für Rollrasen in Bayern: mild-kontinentales Klima, hoher Gartenanteil in den Vororten und eine dichte Dichte an erfahrenen Fachbetrieben. Ob Reihenhaus in Pasing, Garten in Grünwald oder Neubau in Unterschleißheim – regionale Händler aus dem Großraum liefern und verlegen meist noch im gleichen Wochenrhythmus.',
    faq: [
      { q: 'Was kostet Rollrasen in München?', a: 'Das Material liegt je nach Sorte bei 5–12 €/m². Mit Lieferung und Verlegung durch einen Fachbetrieb sind 15–25 €/m² realistisch. Bodenvorbereitung kommt bei Bedarf obendrauf – insgesamt sind 25–55 €/m² ein realistischer Gesamtrahmen.' },
      { q: 'Welche Händler liefern im Großraum München?', a: 'Mehrere geprüfte Fachbetriebe aus Unterschleißheim, Kirchheim, Schwabhausen und Strasslach beliefern den gesamten Großraum München. Einfach PLZ eingeben – wir verbinden Sie mit den nächsten drei Betrieben.' },
      { q: 'Wann ist die beste Zeit für Rollrasen in München?', a: 'April bis Juni und August bis Oktober sind ideal. Der Münchner Sommer kann trocken sein – wer im Juli verlegt, muss intensiv wässern. Im Herbst ist das Anwachsen oft sicherer.' },
      { q: 'Kann ich Rollrasen in München selbst verlegen?', a: 'Ja, bei kleineren Flächen gut machbar. Die Bodenvorbereitung (Fräsen, Planieren) ist der anspruchsvollere Teil. Für Flächen ab 100 m² lohnt sich ein Fachbetrieb zeitlich und qualitativ.' },
    ],
  },
  nuernberg: {
    name: 'Nürnberg', region: 'Mittelfranken', plz: '90402',
    title: 'Rollrasen Nürnberg – Kosten, Händler & kostenlose Angebote 2026',
    desc:  'Rollrasen in Nürnberg kaufen & verlegen lassen: Preisrechner, regionale Händler & kostenlose Angebote. Geprüfte Fachbetriebe aus Mittelfranken.',
    intro: 'Nürnberg und der Großraum Mittelfranken haben eine aktive Gartenkultur – und mit Noris Rollrasen sowie den Greenkeepers aus Fürth gleich zwei spezialisierte Betriebe vor Ort. Die kontinentale Lage bedeutet heiße Sommer und kalte Winter: lokale Sorten sind auf diese Bedingungen abgestimmt, was das Anwachsrisiko deutlich senkt.',
    faq: [
      { q: 'Was kostet Rollrasen in Nürnberg?', a: 'Material: 5–12 €/m². Inkl. Lieferung und Verlegung: 15–25 €/m². Komplett mit Bodenvorbereitung: 25–55 €/m². Für eine typische Gartenfläche von 80 m² sind 1.200–4.400 € ein realistischer Gesamtrahmen.' },
      { q: 'Welche Händler liefern in Nürnberg und Umgebung?', a: 'Noris Rollrasen (Nürnberg) und die Greenkeepers Gartenbau (Fürth) sind direkt vor Ort. Überregionale Hersteller wie Isar Rollrasen und BayernRasen liefern ebenfalls nach Mittelfranken.' },
      { q: 'Wann ist die beste Zeit für Rollrasen in Nürnberg?', a: 'Frühjahr (April/Mai) und Frühherbst (September/Oktober) sind ideal. Der Nürnberger Sommer ist trocken und heiß – Verlegung im Juli/August erfordert intensive Bewässerung.' },
      { q: 'Gibt es Rollrasen auch für schattige Gärten in Nürnberg?', a: 'Ja. Halbschattenrasen ist für Gärten mit altem Baumbestand geeignet. Lokale Händler beraten zu den richtigen Sorten für Ihren Standort.' },
    ],
  },
  augsburg: {
    name: 'Augsburg', region: 'Schwaben', plz: '86150',
    title: 'Rollrasen Augsburg – Kosten, Händler & kostenlose Angebote 2026',
    desc:  'Rollrasen in Augsburg kaufen & verlegen lassen: Preisrechner, regionale Händler & kostenlose Angebote. Geprüfte Fachbetriebe aus Schwaben.',
    intro: 'Augsburg und der Raum Schwaben sind gut versorgt: Mit Walter Schwab GmbH aus Waidhofen gibt es einen der ältesten Rollrasen-Hersteller Deutschlands in direkter Nähe – gegründet in den 1970er Jahren, heute mit rund 250 Hektar Eigenproduktion. Dazu liefern überregionale Hersteller aus Oberbayern zuverlässig in den Augsburger Raum.',
    faq: [
      { q: 'Was kostet Rollrasen in Augsburg?', a: 'Material: 5–12 €/m². Mit Lieferung und Verlegung: 15–25 €/m². Komplett mit Bodenvorbereitung: 25–55 €/m². Augsburg hat kurze Wege zu mehreren Herstellern, was die Lieferkosten niedrig hält.' },
      { q: 'Welche Händler liefern in Augsburg?', a: 'Walter Schwab GmbH aus Waidhofen bei Augsburg ist einer der bekanntesten Produzenten in Schwaben. Ergänzend liefern BayernRasen und Isar Rollrasen bayernweit – auch nach Augsburg.' },
      { q: 'Wann ist der beste Zeitpunkt für Rollrasen in Augsburg?', a: 'April bis Juni und September/Oktober sind ideal. Der Augsburger Sommer kann trocken ausfallen – intensive Bewässerung in den ersten zwei Wochen ist entscheidend.' },
      { q: 'Lohnt sich Rollrasen gegenüber Rasensaat in Augsburg?', a: 'Bei schnell genutzten Flächen (Garten fertigstellen, Neubau, Event) ist Rollrasen klar besser. Bei großen Flächen und Zeit ist Rasensaat günstiger – die Bodenvorbereitung ist bei beiden ähnlich aufwendig.' },
    ],
  },
  regensburg: {
    name: 'Regensburg', region: 'Oberpfalz', plz: '93047',
    title: 'Rollrasen Regensburg – Kosten, Händler & kostenlose Angebote 2026',
    desc:  'Rollrasen in Regensburg kaufen & verlegen lassen: Preisrechner, regionale Händler & kostenlose Angebote. Geprüfte Fachbetriebe aus der Oberpfalz.',
    intro: 'Regensburg und die Oberpfalz haben mit Gartenbau Schaknat aus Seubersdorf einen regionalen Fachbetrieb direkt in der Region. Für größere Projekte stehen überregionale Hersteller wie Isar Rollrasen und Sued-Rasen zur Verfügung, die bayernweit liefern. Das Regensburger Klima – mit deutlichen Jahreszeiten und gelegentlich kalten Wintern – spricht für lokal adaptierte Rasensorten.',
    faq: [
      { q: 'Was kostet Rollrasen in Regensburg?', a: 'Material: 5–12 €/m². Mit Lieferung und Verlegung: 15–25 €/m². Komplett mit Bodenvorbereitung: 25–55 €/m². Preise sind vergleichbar mit dem bayerischen Durchschnitt.' },
      { q: 'Welche Händler liefern in Regensburg?', a: 'Gartenbau Schaknat aus der Oberpfalz ist regional tätig. Zusätzlich liefern Isar Rollrasen (Niederbayern) und BayernRasen bayernweit – auch nach Regensburg.' },
      { q: 'Wann ist der beste Zeitpunkt für Rollrasen in Regensburg?', a: 'April bis Juni und September sind ideal. Das kontinentale Klima Regensburgs macht Frühjahrspflanzungen besonders erfolgreich – die Böden erwärmen sich gut und die Niederschläge sind ausreichend.' },
      { q: 'Gibt es einen Unterschied zwischen Rollrasen und Fertigrasen?', a: 'Nein – beides bezeichnet dasselbe Produkt. „Fertigrasen" ist die häufigere Bezeichnung im Fachhandel für Premiumsorten.' },
    ],
  },
  landshut: {
    name: 'Landshut', region: 'Niederbayern', plz: '84028',
    title: 'Rollrasen Landshut – Kosten, Händler & kostenlose Angebote 2026',
    desc:  'Rollrasen in Landshut kaufen & verlegen lassen: Preisrechner, regionale Händler & kostenlose Angebote. Geprüfte Fachbetriebe aus Niederbayern.',
    intro: 'Landshut liegt mitten in Niederbayern und hat gleich zwei Rollrasen-Spezialisten in direkter Nachbarschaft: Isar Rollrasen aus Altheim und Nodes Gartenbau aus Essenbach. Beide Betriebe liefern frisch geernteten Rasen innerhalb weniger Stunden – ein klarer Vorteil gegenüber überregionalen Versandhändlern.',
    faq: [
      { q: 'Was kostet Rollrasen in Landshut?', a: 'Material: 5–12 €/m². Inkl. Lieferung und Verlegung: 15–25 €/m². Mit Bodenvorbereitung: 25–55 €/m². Landshut profitiert von kurzen Wegen zu regionalen Herstellern.' },
      { q: 'Welche Händler liefern in Landshut?', a: 'Isar Rollrasen aus Altheim und Nodes Gartenbau aus Essenbach sind direkt vor Ort. Beide decken den Raum Niederbayern zuverlässig ab.' },
      { q: 'Wann ist der beste Zeitpunkt für Rollrasen in Landshut?', a: 'April bis Juni und September/Oktober. Niederbayern hat ausreichend Niederschläge im Frühjahr – ideal für schnelles Anwachsen.' },
      { q: 'Was ist der Vorteil von regionalem Rollrasen aus Niederbayern?', a: 'Kurze Transportwege bedeuten frischeren Rasen mit höherer Anwurzelungsrate. Isar Rollrasen liefert oft am selben oder nächsten Tag nach der Ernte.' },
    ],
  },
  rosenheim: {
    name: 'Rosenheim', region: 'Oberbayern', plz: '83022',
    title: 'Rollrasen Rosenheim – Kosten, Händler & kostenlose Angebote 2026',
    desc:  'Rollrasen in Rosenheim kaufen & verlegen lassen: Preisrechner, regionale Händler & kostenlose Angebote. Geprüfte Fachbetriebe aus dem Chiemgau.',
    intro: 'Rosenheim und der Chiemgau haben mit Rasen Schwab einen lokalen Fachbetrieb direkt vor Ort. Die Voralpenregion stellt besondere Anforderungen an Rollrasen: Frostbeständige Sorten, die auch harten Wintern trotzen, sind hier entscheidend. Regionale Händler kennen die lokalen Bodenbedingungen und Hanglagen besser als überregionale Versandhändler.',
    faq: [
      { q: 'Was kostet Rollrasen in Rosenheim?', a: 'Material: 5–12 €/m². Inkl. Lieferung und Verlegung: 15–25 €/m². Mit Bodenvorbereitung: 25–55 €/m². Hanglagen im Chiemgau können die Verlegekosten leicht erhöhen.' },
      { q: 'Welche Händler liefern in Rosenheim?', a: 'Rasen Schwab GmbH ist der lokale Spezialist direkt in Rosenheim. Für größere Projekte liefern auch überregionale Hersteller wie Isar Rollrasen und BayernRasen in die Region.' },
      { q: 'Brauche ich in Rosenheim spezielle Rasensorten?', a: 'Für Lagen mit starker Sonneneinstrahlung und Hanglagen empfiehlt sich Strapazierrasen. In schattigen Gärten unter altem Baumbestand ist Halbschattenrasen die bessere Wahl.' },
      { q: 'Wann ist der beste Zeitpunkt für Rollrasen im Chiemgau?', a: 'Mai bis Juni und September sind optimal. Die Voralpenregion hat längere Winternachkälten – Frühjahrspflanzungen erst nach den Eisheiligen (Mitte Mai) sind sicherer.' },
    ],
  },
  ingolstadt: {
    name: 'Ingolstadt', region: 'Oberbayern', plz: '85049',
    title: 'Rollrasen Ingolstadt – Kosten, Händler & kostenlose Angebote 2026',
    desc:  'Rollrasen in Ingolstadt kaufen & verlegen lassen: Preisrechner, regionale Händler & kostenlose Angebote. Geprüfte Fachbetriebe aus der Region.',
    intro: 'Ingolstadt liegt zentral zwischen München und Nürnberg – und profitiert damit von Händlern aus beiden Richtungen. BayernRasen aus Schwabhausen und Schwab Rollrasen aus Pörnbach sind besonders nah. Ingolstadts Klima ist kontinental mit heißen Sommern: intensive Bewässerung in den ersten Wochen nach der Verlegung ist entscheidend.',
    faq: [
      { q: 'Was kostet Rollrasen in Ingolstadt?', a: 'Material: 5–12 €/m². Inkl. Lieferung und Verlegung: 15–25 €/m². Mit Bodenvorbereitung: 25–55 €/m². Ingolstadt liegt günstig zwischen mehreren Herstellern.' },
      { q: 'Welche Händler liefern nach Ingolstadt?', a: 'BayernRasen (Schwabhausen), Schwab Rollrasen (Pörnbach) und Isar Rollrasen (Altheim) liefern alle in den Raum Ingolstadt. PLZ eingeben – wir finden die drei nächsten.' },
      { q: 'Wann ist der beste Zeitpunkt für Rollrasen in Ingolstadt?', a: 'April bis Juni. Der Ingolstädter Sommer ist oft trocken und heiß – wer im Juli verlegt, muss täglich intensiv wässern. Herbst (September/Oktober) ist eine gute Alternative.' },
      { q: 'Kann ich Rollrasen auch für größere Gewerbeflächen bestellen?', a: 'Ja – regionale Hersteller wie BayernRasen produzieren auf über 100 Hektar Eigenanbau und können auch größere Mengen kurzfristig liefern.' },
    ],
  },
  freising: {
    name: 'Freising', region: 'Oberbayern', plz: '85354',
    title: 'Rollrasen Freising – Kosten, Händler & kostenlose Angebote 2026',
    desc:  'Rollrasen in Freising kaufen & verlegen lassen: Preisrechner, regionale Händler & kostenlose Angebote. Geprüfte Fachbetriebe aus der Region.',
    intro: 'Freising liegt zwischen München und dem Niederbayerischen Hügelland – und hat damit eine ideale Lage für schnelle Rollrasen-Lieferungen. Isar Rollrasen aus Altheim ist nur wenige Kilometer entfernt, die Münchner Betriebe rund um Unterschleißheim und Kirchheim decken den Raum ebenfalls ab. Freisings Böden sind oft tiefgründig und humos – gute Voraussetzungen für schnelles Anwachsen.',
    faq: [
      { q: 'Was kostet Rollrasen in Freising?', a: 'Material: 5–12 €/m². Inkl. Lieferung und Verlegung: 15–25 €/m². Komplett mit Bodenvorbereitung: 25–55 €/m². Freising liegt sehr günstig zu mehreren großen Herstellern.' },
      { q: 'Welche Händler liefern nach Freising?', a: 'Isar Rollrasen (Altheim, Niederbayern) ist besonders nah. Zusätzlich liefern Wolf Gruen (Unterschleißheim) und Spiegl Gartenbau (Kirchheim) aus dem Münchner Raum nach Freising.' },
      { q: 'Wann ist der beste Zeitpunkt für Rollrasen in Freising?', a: 'April bis Juni und September/Oktober. Das Klima in Freising ist gemäßigt – Frühjahrspflanzungen gelingen zuverlässig, wenn der Boden frost frei ist.' },
      { q: 'Lohnt sich Rollrasen für Neubaugebiete in Freising?', a: 'Besonders ja – Rollrasen ist sofort nutzbar und schützt den Boden schnell vor Erosion. Bei Neubauprojekten oft die bevorzugte Wahl gegenüber Rasensaat.' },
    ],
  },
  fuerth: {
    name: 'Fürth', region: 'Mittelfranken', plz: '90762',
    title: 'Rollrasen Fürth – Kosten, Händler & kostenlose Angebote 2026',
    desc:  'Rollrasen in Fürth kaufen & verlegen lassen: Preisrechner, regionale Händler & kostenlose Angebote. Geprüfte Fachbetriebe aus Mittelfranken.',
    intro: 'Fürth und Nürnberg bilden einen gemeinsamen Wirtschaftsraum – und sind rollrasenmäßig gut aufgestellt. Die Greenkeepers Gartenbau GbR hat ihren Sitz direkt in Fürth, Noris Rollrasen in Nürnberg ergänzt das Angebot. Mittelfranken hat ein klar kontinentales Klima mit trockenen Sommern: lokale Sorten sind darauf abgestimmt.',
    faq: [
      { q: 'Was kostet Rollrasen in Fürth?', a: 'Material: 5–12 €/m². Inkl. Lieferung und Verlegung: 15–25 €/m². Mit Bodenvorbereitung: 25–55 €/m². Preise entsprechen dem mittelfränkischen Durchschnitt.' },
      { q: 'Welche Händler liefern in Fürth?', a: 'Greenkeepers Gartenbau GbR ist direkt in Fürth ansässig. Noris Rollrasen (Nürnberg) und überregionale Hersteller wie BayernRasen liefern ebenfalls in den Großraum Fürth.' },
      { q: 'Wann ist der beste Zeitpunkt für Rollrasen in Fürth?', a: 'April bis Juni und September. Fürth und Nürnberg haben relativ trockene Sommer – intensive Bewässerung nach der Verlegung ist besonders wichtig.' },
      { q: 'Kann ich Rollrasen in Fürth auch in Eigenleistung verlegen?', a: 'Ja, bei kleineren Flächen gut machbar. Wichtig ist eine ebene, ausreichend lockere Unterlage. Lokale Händler helfen mit Beratung zur richtigen Sorte und Bodenvorbereitung.' },
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
  .st-hero{background:linear-gradient(135deg,#1a3d12 0%,#2d6a2d 100%);color:#fff;padding:3rem 1.5rem 2.5rem;text-align:center}
  .st-hero h1{font-size:2rem;font-weight:800;margin:.5rem 0;color:#fff}
  .st-hero p{opacity:.85;max-width:560px;margin:.75rem auto 0;font-size:.95rem}
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
      ${h.typ === 'Hersteller' ? '<small>Rollrasen-Hersteller</small>' : '<small>Fachbetrieb</small>'}
      ${h.google_bewertung ? `<div class="rating">★ ${h.google_bewertung.toFixed(1)} <span style="color:#999">(${h.google_bewertungen_anzahl} Bewertungen)</span></div>` : ''}
      ${h.ort ? `<div style="font-size:.82rem;color:#666;margin:.2rem 0">📍 ${h.ort}</div>` : ''}
      ${BADGE[h.paket] ? `<span class="dealer-badge-pill">${BADGE[h.paket]}</span>` : ''}
      ${h.profil_slug ? `<div style="margin-top:.5rem"><a href="/haendler/${h.profil_slug}" style="color:#2d6a2d;font-size:.82rem;text-decoration:none">→ Profil ansehen</a></div>` : ''}
    </div>`).join('');

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

    <div class="cta-block">
      <h2>Kostenloses Angebot für ${stadt.name} anfragen</h2>
      <p>PLZ eingeben – wir verbinden Sie sofort mit den nächsten Fachbetrieben. Kostenlos & unverbindlich.</p>
      <a class="cta-btn" href="/bayern/?plz=${stadt.plz}#rechner">Jetzt Bedarf berechnen &amp; anfragen →</a>
    </div>

    <h2>Preise für Rollrasen in ${stadt.name}</h2>
    <p>Die Preise in ${stadt.name} entsprechen dem bayerischen Durchschnitt:</p>
    <table style="width:100%;border-collapse:collapse;margin:1rem 0;font-size:.92rem">
      <tr style="background:#f4f8f4"><td style="padding:9px 14px;color:#555">Rollrasen Material</td><td style="padding:9px 14px;font-weight:700;color:#2d6a2d">5–12 €/m²</td></tr>
      <tr><td style="padding:9px 14px;color:#555">Inkl. Lieferung & Verlegung</td><td style="padding:9px 14px;font-weight:700;color:#2d6a2d">15–25 €/m²</td></tr>
      <tr style="background:#f4f8f4"><td style="padding:9px 14px;color:#555">Komplett inkl. Bodenvorbereitung</td><td style="padding:9px 14px;font-weight:700;color:#2d6a2d">25–55 €/m²</td></tr>
    </table>
    <p style="font-size:.85rem;color:#888">Alle Angaben inkl. MwSt. Bodenvorbereitung (Fräsen, Planieren, Humus) wird separat kalkuliert. <a href="/bayern/" style="color:#2d6a2d">Preisrechner nutzen →</a></p>

    <h2>Häufige Fragen – Rollrasen ${stadt.name}</h2>
    <div>${faqHtml}</div>

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
