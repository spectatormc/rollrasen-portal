const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const Database   = require('better-sqlite3');
const nodemailer = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 3002;

// ─── HÄNDLER LADEN ───────────────────────────────────────────────────────────

const HAENDLER = require('./haendler.json');

function matchHaendler(plz) {
  if (!plz || plz.length < 2) return HAENDLER;
  const prefix = plz.slice(0, 2);
  const matched = HAENDLER.filter(h => h.plz_prefixes.includes(prefix));
  return matched.length > 0 ? matched : HAENDLER;
}

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

// ─── E-MAIL ───────────────────────────────────────────────────────────────────

const ADMIN_EMAIL  = process.env.ADMIN_EMAIL  || null;
const SMTP_HOST    = process.env.SMTP_HOST    || null;
const SMTP_USER    = process.env.SMTP_USER    || null;
const SMTP_PASS    = process.env.SMTP_PASS    || null;
const SMTP_PORT    = parseInt(process.env.SMTP_PORT || '587');

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

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────

app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'rollrasen-portal.html')));

// ─── HÄNDLER ENDPOINT ─────────────────────────────────────────────────────────

app.get('/haendler', (req, res) => {
  const plz     = (req.query.plz || '').replace(/\D/g, '');
  const matched = matchHaendler(plz);
  const top3    = matched.slice(0, 3);
  res.json({ count: top3.length, region: top3[0]?.region || 'Bayern', haendler: top3.map(h => h.name) });
});

// ─── ANFRAGE ENDPOINT ─────────────────────────────────────────────────────────

app.post('/anfrage', async (req, res) => {
  const { name, email, phone, plz, m2, product, message } = req.body;

  if (!name?.trim() || !email?.trim())
    return res.status(400).json({ error: 'Name und E-Mail sind Pflichtfelder' });

  const plzClean  = (plz || '').replace(/\D/g, '').slice(0, 5);
  const matched   = matchHaendler(plzClean);
  const top3      = matched.slice(0, 3);
  const produktLabel = PRODUKT_LABELS[product] || product || 'nicht angegeben';
  const m2Display = m2 ? Math.round(m2) + ' m²' : 'nicht angegeben';

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

  console.log(`📋 Neue Anfrage: ${name} (${email}) – ${m2Display} ${produktLabel}, PLZ ${plzClean} → ${top3.length} Händler`);

  // Bestätigungsmail an Kunden
  const kundenMail = `
    <div style="font-family:sans-serif;max-width:560px;color:#222">
      <h2 style="color:#2d6a2d">Ihre Rollrasen-Anfrage ist eingegangen</h2>
      <p>Hallo ${name},</p>
      <p>wir haben Ihre Anfrage erhalten und <strong>${top3.length} Händler in Ihrer Region (PLZ ${plzClean || 'unbekannt'})</strong> informiert.</p>
      <table style="border-collapse:collapse;width:100%;margin:1rem 0">
        <tr><td style="padding:6px 12px;color:#666">Fläche</td><td style="padding:6px 12px;font-weight:600">${m2Display}</td></tr>
        <tr style="background:#f5f5f5"><td style="padding:6px 12px;color:#666">Sorte</td><td style="padding:6px 12px;font-weight:600">${produktLabel}</td></tr>
        ${plzClean ? `<tr><td style="padding:6px 12px;color:#666">PLZ</td><td style="padding:6px 12px;font-weight:600">${plzClean}</td></tr>` : ''}
      </table>
      <p>Die Händler melden sich in der Regel <strong>innerhalb von 24 Stunden</strong> direkt bei Ihnen per E-Mail oder Telefon.</p>
      <p style="color:#666;font-size:0.9rem">Diese E-Mail wurde automatisch versendet von rollrasen.gartenbau-kosten.de</p>
    </div>`;

  // Händler-/Admin-Mail
  const haendlerMail = `
    <div style="font-family:sans-serif;max-width:560px;color:#222">
      <h2 style="color:#2d6a2d">Neue Rollrasen-Anfrage</h2>
      <table style="border-collapse:collapse;width:100%;margin:1rem 0">
        <tr><td style="padding:6px 12px;color:#666;width:140px">Name</td><td style="padding:6px 12px;font-weight:600">${name}</td></tr>
        <tr style="background:#f5f5f5"><td style="padding:6px 12px;color:#666">E-Mail</td><td style="padding:6px 12px"><a href="mailto:${email}">${email}</a></td></tr>
        ${phone ? `<tr><td style="padding:6px 12px;color:#666">Telefon</td><td style="padding:6px 12px">${phone}</td></tr>` : ''}
        <tr style="background:#f5f5f5"><td style="padding:6px 12px;color:#666">PLZ</td><td style="padding:6px 12px">${plzClean || '–'}</td></tr>
        <tr><td style="padding:6px 12px;color:#666">Fläche</td><td style="padding:6px 12px;font-weight:600">${m2Display}</td></tr>
        <tr style="background:#f5f5f5"><td style="padding:6px 12px;color:#666">Sorte</td><td style="padding:6px 12px">${produktLabel}</td></tr>
        ${message ? `<tr><td style="padding:6px 12px;color:#666">Nachricht</td><td style="padding:6px 12px">${message}</td></tr>` : ''}
      </table>
      <p style="color:#666;font-size:0.9rem">Eingegangen über rollrasen.gartenbau-kosten.de</p>
    </div>`;

  try {
    await sendMail(email, 'Ihre Rollrasen-Anfrage ist eingegangen', kundenMail);

    // An Admin oder direkt an Händler
    const empfaenger = ADMIN_EMAIL
      ? [ADMIN_EMAIL]
      : top3.filter(h => h.email && !h.email.includes('placeholder')).map(h => h.email);

    for (const empf of empfaenger) {
      await sendMail(empf, `Neue Rollrasen-Anfrage – ${m2Display}, PLZ ${plzClean}`, haendlerMail);
    }

    res.json({ ok: true, haendler_count: top3.length, region: top3[0]?.region || 'Bayern' });
  } catch (err) {
    console.error('Mail-Fehler:', err.message);
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
    const empfaenger = ADMIN_EMAIL || 'info@gartenbau-kosten.de';
    await sendMail(empfaenger, `Partner-Anfrage: ${name} (${type || 'unbekannt'})`, adminMail);
    res.json({ ok: true });
  } catch (err) {
    console.error('Mail-Fehler:', err.message);
    res.json({ ok: true });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\nRollrasen-Portal läuft auf http://localhost:${PORT}`);
  console.log(`E-Mail:    ${transporter ? '✓ ' + SMTP_USER : '✗ nicht konfiguriert (nur Logging)'}`);
  console.log(`Händler:   ${HAENDLER.length} konfiguriert\n`);
});
