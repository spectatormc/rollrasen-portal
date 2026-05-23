require('dotenv').config({ override: true });
const express    = require('express');
const cors       = require('cors');
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

// Findet die 3 nächsten aktiven Betriebe aus der hersteller-Tabelle.
// Sortierung: ABS(PLZ-Differenz) aufsteigend, Einträge ohne PLZ kommen zuletzt.
function findNearestHaendler(plz) {
  const plzNum = parseInt((plz || '').replace(/\D/g, ''), 10) || 0;
  return db.prepare(`
    SELECT id, name, typ, strasse, plz, ort, region,
           telefon, email, website, google_bewertung, google_bewertungen_anzahl
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
  halbschatten: 'Halbschattenrasen (6,50 €/m²)',
  premium:      'Premium-Fertigrasen (9,00 €/m²)',
  sport:        'Sportrasen (10,50 €/m²)',
  boeschung:    'Böschungsrasen (11,50 €/m²)',
};

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

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'rollrasen-portal.html')));

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
  <a class="back" href="/">← Zurück zur Startseite</a>
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
  <a class="back" href="/">← Zurück zur Startseite</a>
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

// ─── ADMIN ────────────────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Rollrasen Admin"');
    return res.status(401).send('Anmeldung erforderlich');
  }
  const [, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
  if (pass !== (process.env.ADMIN_PASSWORD || 'rollrasen2025')) {
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

  const haendlerRows = haendler.map(h => `
    <tr>
      <td><strong>${esc(h.name)}</strong><br><small style="color:#888">${esc(h.typ || '')}</small></td>
      <td>${h.plz ? h.plz + ' ' : ''}${esc(h.ort || '')}${h.region ? '<br><small style="color:#888">'+esc(h.region)+'</small>' : ''}</td>
      <td style="white-space:nowrap">${h.google_bewertung ? '⭐ ' + h.google_bewertung.toFixed(1) + '<br><small>' + h.google_bewertungen_anzahl + ' Bew.</small>' : '–'}</td>
      <td>${h.email ? '<a href="mailto:'+esc(h.email)+'">'+esc(h.email)+'</a>' : '–'}</td>
      <td style="white-space:nowrap">${esc(h.telefon || '–')}</td>
      <td>${esc(h.website || '–')}</td>
      <td><span class="badge ${h.aktiv ? 'badge-on' : 'badge-off'}">${h.aktiv ? 'Aktiv' : 'Inaktiv'}</span></td>
      <td>
        <form method="POST" action="/admin/haendler/${h.id}/toggle">
          <button class="btn-toggle ${h.aktiv ? 'btn-off' : 'btn-on'}" type="submit">
            ${h.aktiv ? 'Deaktivieren' : 'Aktivieren'}
          </button>
        </form>
      </td>
    </tr>`).join('');

  res.send(`<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
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
          <th>E-Mail</th><th>Telefon</th><th>Website</th><th>Status</th><th>Aktion</th>
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

// ─── HÄNDLER ENDPOINT ─────────────────────────────────────────────────────────

app.get('/haendler', (req, res) => {
  const plz  = (req.query.plz || '').replace(/\D/g, '');
  const top3 = findNearestHaendler(plz);
  res.json({
    count:    top3.length,
    region:   top3[0]?.region || 'Bayern',
    haendler: top3.map(h => h.name),
  });
});

// ─── ANFRAGE ENDPOINT ─────────────────────────────────────────────────────────

app.post('/anfrage', async (req, res) => {
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
        <p>Hallo ${name},</p>
        <p>wir haben Ihre Anfrage erhalten und <strong>${top3.length} Fachbetrieb${top3.length !== 1 ? 'e' : ''}</strong> in Ihrer Region kontaktiert.
           Diese melden sich in der Regel <strong>innerhalb von 24 Stunden</strong> direkt bei Ihnen.</p>

        <table style="border-collapse:collapse;width:100%;margin:1.2rem 0;font-size:0.9rem">
          <tr style="background:#f0f4f0">
            <td style="padding:8px 16px;color:#666">Fläche</td>
            <td style="padding:8px 16px;font-weight:600">${m2Display}</td>
          </tr>
          <tr>
            <td style="padding:8px 16px;color:#666">Sorte</td>
            <td style="padding:8px 16px;font-weight:600">${produktLabel}</td>
          </tr>
          ${plzClean ? `<tr style="background:#f0f4f0"><td style="padding:8px 16px;color:#666">Ihre PLZ</td><td style="padding:8px 16px;font-weight:600">${plzClean}</td></tr>` : ''}
          ${message ? `<tr><td style="padding:8px 16px;color:#666;vertical-align:top">Ihre Nachricht</td><td style="padding:8px 16px">${message}</td></tr>` : ''}
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
          <a href="https://rollrasen.gartenbau-kosten.de" style="color:#2d6a2d">rollrasen.gartenbau-kosten.de</a>
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
        <p>über <a href="https://rollrasen.gartenbau-kosten.de" style="color:#2d6a2d">rollrasen.gartenbau-kosten.de</a> ist eine neue Anfrage eingegangen, die wir Ihnen als nächstgelegenem Fachbetrieb weiterleiten.</p>
        <div style="background:#f4f8f4;border-left:4px solid #2d6a2d;border-radius:4px;padding:16px 20px;margin:20px 0">
          <div style="font-size:0.75rem;color:#2d6a2d;text-transform:uppercase;letter-spacing:.08em;font-weight:700;margin-bottom:12px">Anfrage-Details</div>
          <table style="border-collapse:collapse;width:100%;font-size:0.92rem">
            <tr><td style="padding:5px 0;color:#555;width:130px">Name</td><td style="padding:5px 0;font-weight:600">${name}</td></tr>
            <tr><td style="padding:5px 0;color:#555">E-Mail</td><td style="padding:5px 0"><a href="mailto:${email}" style="color:#2d6a2d">${email}</a></td></tr>
            ${phone ? `<tr><td style="padding:5px 0;color:#555">Telefon</td><td style="padding:5px 0">${phone}</td></tr>` : ''}
            <tr><td style="padding:5px 0;color:#555">PLZ / Ort</td><td style="padding:5px 0">${plzClean || '–'}</td></tr>
            <tr><td style="padding:5px 0;color:#555">Fläche</td><td style="padding:5px 0;font-weight:600">${m2Display}</td></tr>
            <tr><td style="padding:5px 0;color:#555">Sorte</td><td style="padding:5px 0;font-weight:600">${produktLabel}</td></tr>
            ${message ? `<tr><td style="padding:5px 0;color:#555;vertical-align:top">Nachricht</td><td style="padding:5px 0;font-style:italic;color:#444">${message}</td></tr>` : ''}
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
          Diese Anfrage wurde automatisch über <a href="https://rollrasen.gartenbau-kosten.de" style="color:#2d6a2d">rollrasen.gartenbau-kosten.de</a> weitergeleitet.
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

app.post('/partner-anfrage', async (req, res) => {
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
      <p style="color:#666;font-size:0.9rem">Eingegangen über rollrasen.gartenbau-kosten.de</p>
    </div>`;

  try {
    await sendMail(ADMIN_EMAIL || 'info@gartenbau-kosten.de', `Partner-Anfrage: ${name} (${type || 'unbekannt'})`, adminMail);
    res.json({ ok: true });
  } catch (err) {
    console.error('Mail-Fehler:', err.message);
    res.json({ ok: true });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────

const haendlerCount = db.prepare('SELECT COUNT(*) as c FROM hersteller WHERE aktiv = 1').get().c;
app.listen(PORT, () => {
  console.log(`\nRollrasen-Portal läuft auf http://localhost:${PORT}`);
  console.log(`E-Mail:    ${transporter ? '✓ ' + SMTP_USER : '✗ nicht konfiguriert (nur Logging)'}`);
  console.log(`Händler:   ${haendlerCount} aktive Betriebe in der DB\n`);
});
