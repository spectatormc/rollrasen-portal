"""
Batch-Mail an alle Rollrasen-Händler mit Google-Bewertung >= 4.5 Sterne und bekannter E-Mail.
Sendet eine Kaltakquise-/Partner-Einladungsmail via IONOS SMTP vom Server.
"""
import paramiko, sys

HOST, USER, PASS = "88.198.151.84", "root", "g+h$l}e{}-^G"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASS, timeout=15)
print("Verbunden mit Server.\n")

script = r"""
node -e "
require('dotenv').config({ override: true });
const nodemailer = require('nodemailer');
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'rollrasen.db'));
const haendler = db.prepare(
  'SELECT * FROM hersteller WHERE google_bewertung >= 4.5 AND email IS NOT NULL AND aktiv = 1 ORDER BY google_bewertung DESC'
).all();

console.log('Gefundene Händler:', haendler.length);

const t = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

async function sendAll() {
  for (const h of haendler) {
    const adresse = [h.strasse, h.plz && h.ort ? h.plz + ' ' + h.ort : h.ort].filter(Boolean).join(', ');
    const sterne = h.google_bewertung ? h.google_bewertung.toFixed(1) + ' Sterne (' + h.google_bewertungen_anzahl + ' Bewertungen)' : '';

    const html = \`
<div style="font-family:sans-serif;max-width:600px;color:#222;margin:0 auto">
  <div style="background:#2d6a2d;padding:24px 28px;border-radius:8px 8px 0 0">
    <div style="color:#a8d5a8;font-size:0.78rem;letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px">Partnereinladung</div>
    <h2 style="color:#fff;margin:0;font-size:1.2rem">Kostenlose Kundenanfragen für Ihren Betrieb</h2>
  </div>
  <div style="background:#fff;padding:28px;border:1px solid #dde8dd;border-top:none;border-radius:0 0 8px 8px">
    <p style="margin-top:0">Sehr geehrte Damen und Herren,</p>
    <p>wir betreiben das Portal <a href="https://rollrasen.gartenbau-kosten.de" style="color:#2d6a2d"><strong>rollrasen.gartenbau-kosten.de</strong></a> – einen kostenlosen Vergleichs- und Vermittlungsdienst für Rollrasen-Kunden in Bayern.</p>
    <p>Kunden aus Ihrer Region geben ihre PLZ ein, erhalten eine Kostenschätzung und können danach direkt kostenlose Angebote von Fachbetrieben in ihrer Nähe anfragen. Wir leiten diese Anfragen automatisch an die jeweils nächstgelegenen Betriebe weiter.</p>

    <div style="background:#f4f8f4;border-left:4px solid #2d6a2d;border-radius:4px;padding:14px 18px;margin:20px 0;font-size:0.9rem">
      <strong style="color:#2d6a2d">Ihr Betrieb ist bereits in unserer Datenbank:</strong><br>
      <strong>\${h.name}</strong>\${adresse ? ' · ' + adresse : ''}\${sterne ? '<br><span style="color:#888">' + sterne + '</span>' : ''}
    </div>

    <p>Aktuell erhalten Sie Anfragen noch über uns als Zwischenstelle. <strong>Als offizieller Partner bekommen Sie Kundenanfragen direkt</strong> – ohne Umweg, ohne Provision, vollständig kostenlos.</p>

    <h3 style="color:#2d6a2d;font-size:0.95rem;margin:1.5rem 0 0.5rem">Was ändert sich als Partner?</h3>
    <ul style="margin:0;padding-left:1.25rem;font-size:0.9rem;color:#555;line-height:1.8">
      <li>Kundenanfragen aus Ihrer PLZ-Region landen direkt in Ihrem Postfach</li>
      <li>Ihr Betrieb wird mit Logo, Bewertung und Kontaktdaten prominent hervorgehoben</li>
      <li>Kostenlos – keine Provision, kein Abo</li>
    </ul>

    <div style="text-align:center;margin:28px 0 8px">
      <a href="https://rollrasen.gartenbau-kosten.de/#partner-werden"
         style="background:#2d6a2d;color:#fff;text-decoration:none;padding:12px 28px;border-radius:5px;font-weight:600;font-size:0.95rem;display:inline-block">
        Jetzt kostenlos Partner werden
      </a>
    </div>
    <p style="text-align:center;font-size:0.85rem;color:#888">Oder antworten Sie einfach auf diese E-Mail – wir melden uns umgehend.</p>

    <hr style="border:none;border-top:1px solid #e0e8e0;margin:24px 0">
    <p style="color:#999;font-size:0.78rem;margin:0">
      rollrasen.gartenbau-kosten.de · Ein Service von gartenbau-kosten.de<br>
      Bei Fragen: <a href="mailto:info@gartenbau-kosten.de" style="color:#2d6a2d">info@gartenbau-kosten.de</a>
    </p>
  </div>
</div>
\`;

    try {
      const r = await t.sendMail({
        from: '"Rollrasen-Portal Bayern" <info@gartenbau-kosten.de>',
        to: h.email,
        replyTo: 'info@gartenbau-kosten.de',
        subject: 'Kostenlose Kundenanfragen für Ihren Betrieb – rollrasen.gartenbau-kosten.de',
        html
      });
      console.log('OK ' + h.name + ' (' + h.email + ') -> ' + r.messageId);
    } catch(e) {
      console.error('FEHLER ' + h.name + ': ' + e.message);
    }
    // kurze Pause zwischen Mails
    await new Promise(r => setTimeout(r, 1500));
  }
  console.log('Fertig.');
}
sendAll();
" 2>&1
"""

_, out, err = client.exec_command(f"cd /var/www/rollrasen-portal && {script}", timeout=120)
print(out.read().decode("utf-8", errors="replace").strip())
err_output = err.read().decode("utf-8", errors="replace").strip()
if err_output:
    print("STDERR:", err_output)

client.close()
