# Fishing

Fishing-App mit aktuellen Pegel- und Wasserqualitätsdaten für den deutschen Rhein.

## Live-Test

Die Seite wird nach jedem Push auf `main`, bei manueller Ausführung und automatisch
alle sechs Stunden über GitHub Pages veröffentlicht:

https://degeneuropean.github.io/Fishing.emil.dev1/

## Bedienung

- Angelbereich direkt auf der Karte wählen – ohne Standortfreigabe.
- Alternativ über eine Pegelstation und den Rhein-km zum gewünschten Abschnitt springen.
- Pegel- und Gütestation werden automatisch zugeordnet, können aber unabhängig
  überschrieben werden.
- Angelbereiche lassen sich lokal als Favoriten speichern.
- Die Fangort-Markierung bleibt vom ausgewählten Angelbereich getrennt.

## Daten

`update_data.py` erstellt einen gemeinsamen Stationskatalog in `data/stations.json`
und je Gütestation eine kompakte Datei unter `data/quality/`. Enthalten sind:

- alle deutschen Rheinpegel von PEGELONLINE,
- Rhein-Gütestationen des baden-württembergischen NIZ,
- Mainz-Wiesbaden und Worms aus dem Gewässergüteportal Rheinland-Pfalz,
- Bad Honnef, Düsseldorf-Flehe und Bimmen aus dem Hochwasserportal NRW.

Der Abruf verwendet nur die Python-Standardbibliothek. Einzelne ausgefallene Quellen
stoppen die Aktualisierung nicht: Für die betroffene Station bleibt der letzte
gültige Datenstand erhalten.

Lokal aktualisieren und prüfen:

```bash
python3 update_data.py
python3 update_data.py --validate-only
```

Der GitHub-Workflow aktualisiert die Messdaten alle sechs Stunden, sichert den letzten
gültigen Stand im Repository und veröffentlicht anschließend die komplette statische
Seite auf GitHub Pages.
