# NW7 Urlaubsplaner

Urlaub von Familie und Personal auf einen Blick, wie der Urlaubsplaner von feminin, nur für zu Hause.

**Live:** <https://d2o5zlwweig8bj.cloudfront.net/> (nur mit Anmeldung)

- **Eltern** (genehmigen): sehen alles, bestätigen oder lehnen Urlaub ab, vergeben Zugänge.
- **Organisation** (trägt ein): trägt Urlaub für alle ein, pflegt Personen und Ferien, spricht ab.
  Genehmigen kann sie nicht.
- **Personal** (z. B. Reinigung, Garten, Nanny): braucht keinen Zugang.

Was die App kann:

- **Übersicht**: ein Monat als Tabelle wie in der alten Excel-Liste. Zeilen für den
  Familienurlaub, die Ferien von Schule und Kindergarten und das Personal.
- **Freie Tage der Kinder automatisch** aus dem Kinder-Kalender (iCloud), alle 3 Stunden.
  Fehlendes kann man von Hand ergänzen.
- **Sperrzeiten** pro Person: kein Urlaub, wenn die Kinder frei haben (auch im Sommer),
  und je eine Woche vor und nach dem Familienurlaub. Eintragen geht trotzdem, aber mit roter
  Warnung, die die Eltern beim Genehmigen sehen.
- **Urlaubskonto** pro Person: Eintrittsdatum, Resturlaub laut Stand, genommen, geplant,
  beantragt, übrig. Am Eintrittstag kommt jedes Jahr der neue Urlaub dazu.
- **Anträge**: was die Organisation einträgt, bestätigen die Eltern.
- **Kalender-Abo** fürs Handy mit dem bestätigten Urlaub aller.
- Anmelden nur mit Benutzername und Passwort, ohne Authentifikator-App.

## Selbst ausprobieren, ohne AWS

```bash
cd urlaubsplaner
npm install
npm run dev
```

Dann <http://localhost:8080> öffnen und eine Person auswählen. Erfundene Testdaten.

## Auf AWS veröffentlichen (CloudShell im Browser)

Genau wie bei feminin, nur mit einem anderen Ordner. Es entsteht ein eigener, getrennter
Planer mit eigener Adresse und eigenen Zugängen.

1. <https://console.aws.amazon.com> öffnen und anmelden.
2. Oben rechts die Region **Europa (Frankfurt) eu-central-1** wählen.
3. Oben auf das Symbol **CloudShell** (`>_`) klicken.
4. Einmal am Anfang (die Zeile mit `bootstrap` braucht es nur, wenn dieses AWS-Konto noch
   nie etwas veröffentlicht hat; bei dem Konto von feminin ist das schon erledigt):
   ```bash
   git clone https://github.com/aatrmntn/home.git
   cd home/urlaubsplaner
   npm install
   npm run bootstrap
   ```
5. Veröffentlichen (beim ersten Mal etwa 10 Minuten):
   ```bash
   npm run deploy -- -c budgetEmail=DEINE-EMAIL-ADRESSE
   ```
   Bei `Do you wish to deploy these changes (y/n)?` tippst du `y`.
   Ganz am Ende steht `AppUrl = https://….cloudfront.net/`. **Das ist die Adresse des Planers.**
6. Deinen eigenen Zugang anlegen (nur diesen einen hier, alle anderen danach in der App):
   ```bash
   npm run user:add -- --username DEIN-NAME --name "DEIN NAME" --role family --approver
   ```
   Das Start-Passwort steht danach im Fenster. Beim ersten Anmelden wählst du ein eigenes.

Falls die Login-Adresse `nw7-urlaub` schon vergeben ist: beim Veröffentlichen
`-c domainPrefix=nw7-urlaub-2` dazuschreiben.

Bei einer neuen Version später nur noch:
```bash
cd home/urlaubsplaner && git pull && npm install
npm run deploy -- -c budgetEmail=DEINE-EMAIL-ADRESSE
```

## Nach dem ersten Anmelden

1. **Einstellungen → Personen → + Person hinzufügen**: den zweiten Elternteil mit
   „Bekommt einen Zugang“ und „Darf Urlaub genehmigen“, die Organisation mit „Bekommt einen
   Zugang“ und „Trägt für alle ein“. Das Start-Passwort persönlich weitergeben.
2. **Einstellungen → Startdaten übernehmen**: den Text einfügen, den Claude vorbereitet hat
   (Personal mit Eintritt, Resturlaub und Sperrzeiten). Zuerst „Prüfen“, dann „Übernehmen“.
3. **Einstellungen → Kinder-Kalender**: den Link zum Kinder-Kalender einfügen und die Wörter
   für Schule und Kindergarten ergänzen.

## Tests

```bash
npm test
```

## Wo was steht

| Ordner | Inhalt |
|---|---|
| `api/rules.js` | Alle Regeln: Feiertage, Urlaubstage zählen, Sperrzeiten, Resturlaub |
| `api/kinder-feed.js` | Kinder-Kalender lesen und freie Tage erkennen |
| `api/app.js` | Die Schnittstelle: wer darf was, speichern, Protokoll |
| `web/` | Die Seite im Browser |
| `infra/` | Bauplan für AWS (CDK) |
| `dev/` | Lokale Testversion mit erfundenen Daten |
| `test/` | Automatische Tests |
