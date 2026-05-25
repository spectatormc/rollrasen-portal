import paramiko
HOST, USER, PASS = "88.198.151.84", "root", "g+h$l}e{}-^G"
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASS, timeout=15)

script = r"""
node -e "
require('dotenv').config({ override: true });
const nodemailer = require('nodemailer');
const t = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

const html = \`
<div style='font-family:sans-serif;max-width:600px;color:#222;margin:0 auto'>

  <div style='background:#2d6a2d;padding:24px 28px;border-radius:8px 8px 0 0;display:flex;align-items:center;gap:12px'>
    <div>
      <div style='color:#a8d5a8;font-size:0.8rem;letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px'>Neue Kundenanfrage</div>
      <h2 style='color:#fff;margin:0;font-size:1.25rem'>Rollrasen-Anfrage in Ihrer Region</h2>
    </div>
  </div>

  <div style='background:#fff;padding:28px;border:1px solid #dde8dd;border-top:none;border-radius:0 0 8px 8px'>

    <p style='margin-top:0'>Guten Tag,</p>
    <p>über <a href='https://rollrasen.gartenbau-kosten.de' style='color:#2d6a2d'>rollrasen.gartenbau-kosten.de</a> ist eine neue Anfrage eingegangen, die wir Ihnen als nächstgelegenem Fachbetrieb weiterleiten.</p>

    <div style='background:#f4f8f4;border-left:4px solid #2d6a2d;border-radius:4px;padding:16px 20px;margin:20px 0'>
      <div style='font-size:0.75rem;color:#2d6a2d;text-transform:uppercase;letter-spacing:.08em;font-weight:700;margin-bottom:12px'>Anfrage-Details</div>
      <table style='border-collapse:collapse;width:100%;font-size:0.92rem'>
        <tr>
          <td style='padding:5px 0;color:#555;width:130px'>Name</td>
          <td style='padding:5px 0;font-weight:600'>Max Mustermann</td>
        </tr>
        <tr>
          <td style='padding:5px 0;color:#555'>E-Mail</td>
          <td style='padding:5px 0'><a href='mailto:max@mustermann.de' style='color:#2d6a2d'>max@mustermann.de</a></td>
        </tr>
        <tr>
          <td style='padding:5px 0;color:#555'>Telefon</td>
          <td style='padding:5px 0'>0815 12345678</td>
        </tr>
        <tr>
          <td style='padding:5px 0;color:#555'>PLZ / Ort</td>
          <td style='padding:5px 0'>85051 Ingolstadt</td>
        </tr>
        <tr>
          <td style='padding:5px 0;color:#555'>Fläche</td>
          <td style='padding:5px 0;font-weight:600'>120 m²</td>
        </tr>
        <tr>
          <td style='padding:5px 0;color:#555'>Sorte</td>
          <td style='padding:5px 0;font-weight:600'>Premium-Fertigrasen (9,00 €/m²)</td>
        </tr>
        <tr>
          <td style='padding:5px 0;color:#555;vertical-align:top'>Nachricht</td>
          <td style='padding:5px 0;font-style:italic;color:#444'>Wir möchten unseren Garten neu anlegen und benötigen ein Angebot inklusive Verlegung.</td>
        </tr>
      </table>
    </div>

    <p>Bitte nehmen Sie direkt per E-Mail oder Telefon Kontakt auf.</p>

    <div style='text-align:center;margin:28px 0 8px'>
      <a href='mailto:max@mustermann.de?subject=Ihr%20Rollrasen-Angebot'
         style='background:#2d6a2d;color:#fff;text-decoration:none;padding:12px 28px;border-radius:5px;font-weight:600;font-size:0.95rem;display:inline-block'>
        Jetzt Angebot senden
      </a>
    </div>

    <hr style='border:none;border-top:1px solid #e0e8e0;margin:24px 0'>
    <p style='color:#999;font-size:0.78rem;margin:0'>
      Diese Anfrage wurde automatisch über <a href='https://rollrasen.gartenbau-kosten.de' style='color:#2d6a2d'>rollrasen.gartenbau-kosten.de</a> weitergeleitet.
      Sie erhalten diese E-Mail, weil Ihr Betrieb als regionaler Fachpartner registriert ist.<br>
      Bei Fragen: <a href='mailto:info@gartenbau-kosten.de' style='color:#2d6a2d'>info@gartenbau-kosten.de</a>
    </p>
  </div>
</div>
\`;

t.sendMail({
  from: '"Rollrasen-Portal" <info@gartenbau-kosten.de>',
  to: 'rohrhuberbastian@gmail.com',
  subject: 'Neue Rollrasen-Anfrage – 120 m², PLZ 85051 Ingolstadt',
  html
}).then(r => console.log('OK:', r.messageId)).catch(e => console.error('FEHLER:', e.message));
" 2>&1
"""

_, out, err = client.exec_command(f"cd /var/www/rollrasen-portal && {script}")
print(out.read().decode("utf-8", errors="replace").strip())
client.close()
