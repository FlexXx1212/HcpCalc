# HcpCalc

Single Page Application auf Basis von `Vite + React`, mit der Golfspieler ihr Handicap nach den gelieferten Regeln berechnen, DGV-Scoring-Records als PDF importieren und ein neues HCP als Live-Vorschau simulieren koennen.

## Funktionen

- Google-Login über Firebase Auth
- Persistentes Benutzerprofil in Firestore
- Import von DGV-Scoring-Record-PDFs
- Live-Vorschau fuer neues HCP mit minimalen Eingaben
- Defaultwerte aus der neuesten vorhandenen Runde
- HCPI-Berechnung nach `calculation_rules.txt`

## Voraussetzungen

- Node.js 20.x
- Ein Firebase-Projekt mit aktivierter Google-Anmeldung

## Starten

```bash
npm install
npm run dev
```

Für einen Produktions-Build:

```bash
npm run build
```

## Datenmodell

Jeder Benutzer wird in Firestore unter `users/{uid}` gespeichert. Das Dokument enthält:

- `profile`
  - `displayName`
  - `email`
  - `currentHcp`
  - `lastUsedCourseDefaults`
- `rounds`
  - importierte und vorhandene Runden
- `calculationSnapshot`
  - zuletzt berechneter HCPI
  - aktuell verwendete Score Differentials

## Fachlogik

Die Berechnung folgt den Regeln in `calculation_rules.txt`:

- 18-Loch- und 9-Loch-Differentials
- kaufmännische Rundung auf eine Dezimalstelle
- Best-N-Auswahl abhängig von der Anzahl verfügbarer Scores
- maximal 20 aktive Score Differentials
- keine Exceptional Score Reduction
- keine Soft-/Hard-Caps

Die Live-Vorschau speichert keine neue Runde, sondern berechnet nur hypothetisch den naechsten HCP auf Basis der aktuellen Eingaben.

## Importformat

Die PDF-Importlogik ist auf den DGV-Scoring-Record wie in `example.pdf` ausgelegt. Dabei werden unter anderem Datum, Clubnummer, Turniername, Löcher, GBE, PCC, Par, Course Rating, Slope, HCPI, Course Handicap und Score Differential übernommen.
