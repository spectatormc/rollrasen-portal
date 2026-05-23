"""
Personalisierte Outreach-Mails an alle Händler in der DB.
Erstellt je nach Lückenprofil (google_status, webseite_status) eine individuelle Mail.

Nutzung:
  python outreach_haendler.py              # Alle mailen (mit Bestätigung)
  python outreach_haendler.py --test       # Nur an eigene Mail (Test)
  python outreach_haendler.py --id 3       # Nur Händler mit ID 3
"""

import sqlite3, smtplib, ssl, argparse, os, sys
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from datetime import datetime

# ── Config ──────────────────────────────────────────────────────────────────
DB_PATH   = Path(__file__).parent / "rollrasen.db"
FROM_ADDR = "info@gartenbau-kosten.de"
FROM_NAME = "Bastian Rohrhuber · rasenrechner.de"
TEST_ADDR = "rohrhuberbastian@gmail.com"
PORTAL_URL = "https://www.rasenrechner.de"

# SMTP aus Umgebungsvariablen (gleiche wie .env)
SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.ionos.de")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", FROM_ADDR)
SMTP_PASS = os.environ.get("SMTP_PASS", "")

# ── Lückenanalyse → individuelle Text-Bausteine ──────────────────────────────
def analyse_haendler(h):
    punkte = []
    angebote = []

    g = (h["google_status"] or "").lower()
    w = (h["webseite_status"] or "").lower()

    if g in ("kein", ""):
        punkte.append("Ihr Betrieb hat noch keinen oder keinen vollständigen Google Business-Eintrag.")
        angebote.append(("📍 Google Business einrichten", "190 €",
                         "Wir erstellen und optimieren Ihren Eintrag – damit Kunden Sie auf Google Maps finden."))
    elif g in ("schlecht", "mittel"):
        punkte.append("Ihre Google-Bewertungsbasis ist noch ausbaufähig.")
        angebote.append(("⭐ Bewertungsmanagement", "im Pro-Paket enthalten",
                         "Wir helfen dabei, mehr positive Kundenstimmen zu gewinnen und professionell auf Bewertungen zu reagieren."))

    if w in ("keine", "schlecht", ""):
        punkte.append("Ihre Webpräsenz lässt sich digital noch besser aufstellen.")
        angebote.append(("🌐 Neue Webseite", "1.290 € einmalig (im Premium-Abo inkl.)",
                         "Schnell, mobil, Google-optimiert – fertig in 2 Wochen."))

    return punkte, angebote


def build_html(h, punkte, extra_angebote, test_mode=False):
    name    = h["name"]
    ort     = h["ort"] or "Bayern"
    region  = h["region"] or "Ihrer Region"

    punkte_html = "".join(
        f'<li style="margin:.4rem 0;color:#444">{p}</li>' for p in punkte
    ) if punkte else ""
    findings_block = f"""
      <p style="margin:.5rem 0 .25rem;font-weight:600;color:#1a3d1a">Was wir festgestellt haben:</p>
      <ul style="padding-left:1.2rem;margin:.5rem 0 1rem">{punkte_html}</ul>
    """ if punkte_html else ""

    angebote_rows = ""
    for label, preis, beschr in extra_angebote:
        angebote_rows += f"""
          <tr>
            <td style="padding:8px 14px;font-weight:600;color:#1a3d1a">{label}</td>
            <td style="padding:8px 14px;white-space:nowrap;color:#2d6a2d;font-weight:700">{preis}</td>
            <td style="padding:8px 14px;color:#555;font-size:.87rem">{beschr}</td>
          </tr>"""

    test_banner = '<div style="background:#fef3c7;border:2px solid #f59e0b;border-radius:6px;padding:.5rem 1rem;margin-bottom:1rem;font-weight:700;color:#92400e">⚠️ TEST-MAIL – wird nicht an Händler gesendet</div>' if test_mode else ""

    return f"""<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8"></head><body style="font-family:sans-serif;background:#f7f9f7;margin:0;padding:0">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">

  <div style="background:#2d6a2d;padding:28px 28px 24px">
    <div style="color:#a8d5a8;font-size:.75rem;letter-spacing:.1em;text-transform:uppercase;margin-bottom:6px">Partnerangebot · rasenrechner.de</div>
    <h1 style="color:#fff;font-size:1.3rem;margin:0;line-height:1.3">Mehr Kunden für {name} – kostenlos & ohne Risiko</h1>
  </div>

  <div style="padding:28px">
    {test_banner}

    <p style="margin-top:0">Sehr geehrte Damen und Herren,</p>

    <p>wir betreiben <a href="{PORTAL_URL}" style="color:#2d6a2d">{PORTAL_URL}</a> – ein regionaler Anfrage-Kanal für Rollrasen in Bayern.
    Kunden aus {region} geben dort ihre PLZ ein und erhalten automatisch die Kontaktdaten von Fachbetrieben in ihrer Nähe.
    <strong>{name}</strong> ist bei uns bereits als regionaler Fachbetrieb gelistet.</p>

    {findings_block}

    <div style="background:#f4f8f4;border-left:4px solid #2d6a2d;border-radius:4px;padding:16px 20px;margin:20px 0">
      <p style="margin:0 0 8px;font-weight:700;color:#1a3d1a">Unser Angebot an Sie:</p>
      <table style="border-collapse:collapse;width:100%;font-size:.9rem">
        <tr style="background:#e8f5e8">
          <th style="padding:8px 14px;text-align:left;color:#2d6a2d;font-size:.78rem;text-transform:uppercase">Leistung</th>
          <th style="padding:8px 14px;text-align:left;color:#2d6a2d;font-size:.78rem;text-transform:uppercase">Preis</th>
          <th style="padding:8px 14px;text-align:left;color:#2d6a2d;font-size:.78rem;text-transform:uppercase">Nutzen für Sie</th>
        </tr>
        <tr>
          <td style="padding:8px 14px;font-weight:600;color:#1a3d1a">✓ Geprüfter-Händler-Badge</td>
          <td style="padding:8px 14px;white-space:nowrap;color:#2d6a2d;font-weight:700">49 €/Mo</td>
          <td style="padding:8px 14px;color:#555;font-size:.87rem">Ihr Betrieb wird als „Geprüfter Händler" angezeigt – mit Profilseite und Vorrang bei PLZ-Treffern.</td>
        </tr>
        <tr style="background:#f9fbf9">
          <td style="padding:8px 14px;font-weight:600;color:#1a3d1a">⭐ Professional Partner</td>
          <td style="padding:8px 14px;white-space:nowrap;color:#2d6a2d;font-weight:700">99 €/Mo</td>
          <td style="padding:8px 14px;color:#555;font-size:.87rem">Zusätzlich: Video auf Ihrer Profilseite, Google Business Optimierung, monatliche Anfrage-Statistik.</td>
        </tr>
        {angebote_rows}
      </table>
    </div>

    <div style="background:#dcfce7;border-radius:8px;padding:14px 18px;margin:20px 0">
      <strong style="color:#166534">🎬 Betriebsvideo auf rasenrechner.de</strong><br>
      <span style="color:#166534;font-size:.9rem">Wir kommen zu Ihnen und drehen einen 2–3 Minuten Betriebsfilm (Drohne, Ernte, Team).
      Das Video erscheint dauerhaft auf Ihrer Profilseite und gehört Ihnen für alle Kanäle – 490 € einmalig.</span>
    </div>

    <p style="font-size:.9rem;color:#555">
      <strong>So funktioniert es:</strong> Solange Ihr Abo aktiv ist, ist Ihr Listing auf rasenrechner.de kostenlos enthalten
      und Sie erhalten bevorzugt Anfragen aus {region}. Kein Jahresvertrag – monatlich kündbar.
    </p>

    <p>Interesse? Eine kurze Antwort auf diese Mail genügt – wir melden uns mit allen Details und einem individuellen Angebot.</p>

    <p>Mit freundlichen Grüßen<br><strong>Bastian Rohrhuber</strong><br>
    Gartenschmiede GmbH · <a href="{PORTAL_URL}" style="color:#2d6a2d">rasenrechner.de</a><br>
    <a href="mailto:{FROM_ADDR}" style="color:#2d6a2d">{FROM_ADDR}</a></p>

    <hr style="border:none;border-top:1px solid #e0eee0;margin:1.5rem 0">
    <p style="color:#999;font-size:.75rem;margin:0">
      Sie erhalten diese E-Mail, weil {name} auf rasenrechner.de als regionaler Fachbetrieb gelistet ist.
      Wenn Sie kein Interesse an einer Partnerschaft haben, antworten Sie kurz – wir entfernen Sie dann aus unserem Verteiler.
    </p>
  </div>
</div>
</body></html>"""


def send_mail(to_addr, subject, html_body, dry_run=False):
    if dry_run:
        print(f"  [DRY RUN] Würde senden an: {to_addr}")
        return True
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"]    = f"{FROM_NAME} <{SMTP_USER}>"
    msg["To"]      = to_addr
    msg.attach(MIMEText(html_body, "html", "utf-8"))
    ctx = ssl.create_default_context()
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as s:
        s.ehlo()
        s.starttls(context=ctx)
        s.login(SMTP_USER, SMTP_PASS)
        s.sendmail(SMTP_USER, to_addr, msg.as_string())
    return True


def main():
    parser = argparse.ArgumentParser(description="Händler Outreach-Mails")
    parser.add_argument("--test",    action="store_true", help="Nur Test-Mail an eigene Adresse")
    parser.add_argument("--dry-run", action="store_true", help="Kein echter Versand")
    parser.add_argument("--id",      type=int,            help="Nur Händler mit dieser ID")
    args = parser.parse_args()

    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row

    query = "SELECT * FROM hersteller WHERE email IS NOT NULL AND email != ''"
    if args.id:
        query += f" AND id = {args.id}"
    haendler = con.execute(query).fetchall()

    if not haendler:
        print("Keine Händler mit E-Mail gefunden.")
        return

    print(f"\n{'TEST-MODUS' if args.test else 'LIVE-MODUS'} · {len(haendler)} Händler\n{'─'*50}")
    for h in haendler:
        punkte, extra = analyse_haendler(h)
        subject = f"Mehr Kunden für {h['name']} – kostenlose Anfragen + optionale digitale Services"
        html    = build_html(h, punkte, extra, test_mode=args.test)
        to      = TEST_ADDR if args.test else h["email"]

        print(f"\nHändler: {h['name']} ({h['email']})")
        print(f"Empfänger: {to}")
        print(f"Lücken erkannt: {len(punkte)}")

        if not args.dry_run and not args.test:
            antwort = input("Senden? [j/N] ").strip().lower()
            if antwort != "j":
                print("  Übersprungen.")
                continue

        try:
            ok = send_mail(to, subject, html, dry_run=args.dry_run)
            if ok:
                print(f"  ✓ Gesendet{' (dry-run)' if args.dry_run else ''}")
                if not args.dry_run:
                    con.execute("UPDATE hersteller SET kontakt_status = 'kontaktiert' WHERE id = ?", (h["id"],))
                    con.commit()
        except Exception as e:
            print(f"  ✗ Fehler: {e}")

    print(f"\n{'─'*50}\nFertig · {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    con.close()


if __name__ == "__main__":
    main()
