#!/usr/bin/env python3
"""Aktualisiert Rheinpegel und amtliche Wasserqualitätsdaten.

Die Pipeline verwendet ausschließlich Python-Standardbibliothek. Jede
Gütestation wird getrennt geschrieben. Schlägt eine Quelle fehl, bleibt die
zuletzt erfolgreich erzeugte Stationsdatei unverändert erhalten.
"""

from __future__ import annotations

import argparse
import csv
import html
import io
import json
import os
import re
import sys
import tempfile
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
QUALITY_DIR = DATA_DIR / "quality"
CATALOG_FILE = DATA_DIR / "stations.json"
LEGACY_FILE = BASE_DIR / "wasserwerte.json"
BERLIN = ZoneInfo("Europe/Berlin")

USER_AGENT = (
    "RheinCheck/2.0 "
    "(+https://github.com/degeneuropean/Fishing.emil.dev1)"
)
PEGELONLINE_URL = (
    "https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations.json?"
    "waters=RHEIN&includeTimeseries=true&includeCurrentMeasurement=true"
    "&includeCharacteristicValues=true&prettyprint=false"
)
NIZ_STATIONS_URL = "https://inovum-services.de/niz-app/quality-stations"
NIZ_STATION_URL = "https://inovum-services.de/niz-app/quality-station"
NIZ_SOURCE_PAGE = (
    "https://niz.baden-wuerttemberg.de/de/oberflaechengewaesser/"
    "gueteparameter"
)
GUS_BASE = "https://geodaten-wasser.rlp-umwelt.de"

FOREIGN_GAUGE_AGENCIES = {
    "BUNDESAMT FÜR UMWELT CH",
    "RIJKSWATERSTAAT",
}

# NIZ liefert keine Flusskilometer. Diese amtlichen Werte stammen aus den
# Stationssteckbriefen der BfG-Plattform Undine.
NIZ_RIVER_KM = {
    "2827": 146.1,    # Rheinfelden
    "2829": 171.37,   # Weil
    "2838": 333.9,    # Iffezheim
    "33633": 340.2,   # Plittersdorf
    "2839": 359.17,   # Karlsruhe
    "88575": 443.3,   # Worms (wird durch GUS ersetzt)
}

GUS_STATIONS = (
    {
        "id": "quality-rlp-2511510500",
        "slug": "mainz-wiesbaden",
        "sourceId": "2511510500",
        "line": 23,
        "name": "Mainz-Wiesbaden",
        "latitude": 50.0068,
        "longitude": 8.2795,
        "riverKm": 498.5,
        "provider": "LfU RLP / HLNUG",
    },
    {
        "id": "quality-rlp-2391566500",
        "slug": "worms",
        "sourceId": "2391566500",
        "line": 1,
        "name": "Worms",
        "latitude": 49.63083642538217,
        "longitude": 8.380517699021,
        "riverKm": 443.3,
        "provider": "LfU RLP / HLNUG / LUBW",
    },
)

NRW_SOURCE_PAGE = "https://www.hochwasserportal.nrw/"
NRW_STATIONS = (
    {
        "id": "quality-nrw-104",
        "slug": "nrw-104-bad-honnef",
        "sourceId": "104",
        "name": "Bad Honnef",
        "latitude": 50.63007647,
        "longitude": 7.21543977,
        "riverKm": 640.0,
        "provider": "LANUV NRW",
    },
    {
        "id": "quality-nrw-43",
        "slug": "nrw-43-duesseldorf-flehe",
        "sourceId": "43",
        "name": "Düsseldorf-Flehe",
        "latitude": 51.18721099,
        "longitude": 6.77632924,
        "riverKm": 732.2,
        "provider": "LANUV NRW",
    },
    {
        "id": "quality-nrw-000504",
        "slug": "nrw-000504-bimmen",
        "sourceId": "000504",
        "name": "Bimmen",
        "latitude": 51.86001537,
        "longitude": 6.06702354,
        "riverKm": 865.0,
        "provider": "LANUV NRW",
    },
)

MEASUREMENTS = {
    "water_temperature": {
        "label": "Wassertemperatur",
        "icon": "🌡️",
        "decimals": 1,
    },
    "oxygen": {"label": "Sauerstoff", "icon": "🫧", "decimals": 1},
    "oxygen_saturation": {
        "label": "O₂-Sättigung",
        "icon": "🫧",
        "decimals": 0,
    },
    "turbidity": {"label": "Trübung", "icon": "🌫️", "decimals": 1},
    "ph": {"label": "pH-Wert", "icon": "⚗️", "decimals": 2},
    "conductivity": {
        "label": "Leitfähigkeit",
        "icon": "⚡",
        "decimals": 0,
    },
    "chlorophyll": {"label": "Chlorophyll a", "icon": "🌿", "decimals": 1},
}
ITEM_ORDER = {cfg["label"]: pos for pos, cfg in enumerate(MEASUREMENTS.values())}


def now_local() -> datetime:
    return datetime.now(timezone.utc).astimezone(BERLIN)


def iso_local(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=BERLIN)
    return dt.astimezone(BERLIN).isoformat(timespec="seconds")


def legacy_time(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=BERLIN)
    return dt.astimezone(BERLIN).strftime("%d.%m.%Y %H:%M")


def epoch_ms_to_dt(value) -> datetime:
    return datetime.fromtimestamp(float(value) / 1000.0, tz=timezone.utc).astimezone(BERLIN)


def parse_iso(value: str) -> datetime:
    value = str(value).strip().replace("Z", "+00:00")
    return datetime.fromisoformat(value).astimezone(BERLIN)


def parse_local_date(value: str) -> datetime:
    return datetime.strptime(value.strip(), "%d.%m.%Y %H:%M").replace(tzinfo=BERLIN)


def number(value):
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace("\xa0", "").replace(" ", "")
    if "," in text:
        text = text.replace(".", "").replace(",", ".")
    try:
        return float(text)
    except (TypeError, ValueError):
        return None


def de_value(value: float, decimals: int) -> str:
    return f"{float(value):.{decimals}f}".replace(".", ",")


def slugify(value: str) -> str:
    text = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    return re.sub(r"(^-|-$)", "", re.sub(r"[^a-z0-9]+", "-", text.lower()))


def load_json(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return default


def atomic_write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = (
        json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        + "\n"
    )
    tmp_name = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            tmp_name = handle.name
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
    finally:
        if tmp_name:
            try:
                os.unlink(tmp_name)
            except FileNotFoundError:
                pass


def request_bytes(url: str, *, timeout: int = 75, headers=None, attempts: int = 3) -> bytes:
    merged = {
        "Accept": "application/json, text/csv;q=0.9, */*;q=0.5",
        "User-Agent": USER_AGENT,
    }
    if headers:
        merged.update(headers)
    last_error = None
    for attempt in range(attempts):
        try:
            with urlopen(Request(url, headers=merged), timeout=timeout) as response:
                return response.read()
        except HTTPError as exc:
            last_error = exc
            if exc.code not in (408, 425, 429, 500, 502, 503, 504):
                raise
        except (URLError, TimeoutError, OSError) as exc:
            last_error = exc
        if attempt + 1 < attempts:
            time.sleep(1.5 * (2**attempt))
    raise RuntimeError(f"Abruf fehlgeschlagen: {url}: {last_error}")


def request_json(url: str, **kwargs):
    return json.loads(request_bytes(url, **kwargs).decode("utf-8-sig"))


def canonical_key(label: str):
    label = html.unescape(re.sub(r"<[^>]+>", " ", str(label))).lower()
    if "sättigung" in label or "saettigung" in label:
        return "oxygen_saturation"
    if "temperatur" in label:
        return "water_temperature"
    if "sauerstoff" in label:
        return "oxygen"
    if "trüb" in label or "trueb" in label:
        return "turbidity"
    if re.search(r"(^|\W)ph(\W|$)", label):
        return "ph"
    if "leitf" in label:
        return "conductivity"
    if "chlorophyll" in label:
        return "chlorophyll"
    return None


def make_item(key: str, value: float, unit: str, observed: datetime):
    cfg = MEASUREMENTS[key]
    return {
        "key": key,
        "label": cfg["label"],
        "value": de_value(value, cfg["decimals"]),
        "numericValue": round(float(value), 4),
        "unit": unit or "",
        "icon": cfg["icon"],
        "time": legacy_time(observed),
        "observedAt": iso_local(observed),
    }


def quality_payload(meta: dict, items: list, history: dict, fetched_at: datetime):
    items.sort(key=lambda item: ITEM_ORDER.get(item["label"], 99))
    observed_values = [
        parse_iso(item["observedAt"]) for item in items if item.get("observedAt")
    ]
    observed_at = max(observed_values) if observed_values else None
    return {
        "schemaVersion": 2,
        "id": meta["id"],
        "slug": meta["slug"],
        "updated": legacy_time(fetched_at),
        "generatedAt": iso_local(fetched_at),
        "observedAt": iso_local(observed_at) if observed_at else None,
        "station": f"Rhein {meta['name']}",
        "provider": meta["provider"],
        "latitude": meta["latitude"],
        "longitude": meta["longitude"],
        "riverKm": meta.get("riverKm"),
        "items": items,
        "history": history,
        "stationMeta": {
            "name": meta["name"],
            "river": "RHEIN",
            "riverKm": meta.get("riverKm"),
            "latitude": meta["latitude"],
            "longitude": meta["longitude"],
            "provider": meta["provider"],
            "providerStationId": meta["sourceId"],
        },
        "fetch": {
            "state": "ok",
            "lastAttemptAt": iso_local(fetched_at),
            "lastSuccessAt": iso_local(fetched_at),
            "errorCode": None,
        },
        "freshness": {
            "freshForSeconds": 12 * 60 * 60,
            "maxUsableAgeSeconds": 3 * 24 * 60 * 60,
        },
    }


def compact_characteristics(values) -> dict:
    result = {}
    for item in values or []:
        key = str(item.get("shortname") or "").strip()
        value = number(item.get("value"))
        if key and value is not None:
            result[key] = value
    return result


def fetch_gauges() -> list:
    raw = request_json(PEGELONLINE_URL)
    gauges = []
    for station in raw:
        if (station.get("water") or {}).get("shortname") != "RHEIN":
            continue
        if str(station.get("agency") or "").upper() in FOREIGN_GAUGE_AGENCIES:
            continue
        if not station.get("uuid"):
            continue
        series = {}
        characteristics = {}
        for source_series in station.get("timeseries") or []:
            shortname = source_series.get("shortname")
            if shortname not in {"W", "Q"}:
                continue
            target = {
                "unit": source_series.get("unit"),
                "equidistanceMinutes": source_series.get("equidistance"),
            }
            current = source_series.get("currentMeasurement")
            if current:
                target["currentMeasurement"] = current
            if source_series.get("gaugeZero"):
                target["gaugeZero"] = source_series["gaugeZero"]
            values = source_series.get("characteristicValues") or []
            if values:
                target["characteristicValues"] = values
            series[shortname] = target
            if shortname == "W":
                characteristics = compact_characteristics(values)
        if "W" not in series:
            continue
        gauges.append(
            {
                "type": "gauge",
                "id": station["uuid"],
                "uuid": station["uuid"],
                "number": station.get("number"),
                "name": station.get("longname") or station.get("shortname"),
                "shortname": station.get("shortname"),
                "latitude": station.get("latitude"),
                "longitude": station.get("longitude"),
                "riverKm": station.get("km"),
                "agency": station.get("agency"),
                "series": series,
                "characteristicValues": characteristics,
                "sourceUrl": (
                    "https://www.pegelonline.wsv.de/webservices/rest-api/v2/"
                    f"stations/{station['uuid']}.json"
                ),
            }
        )
    gauges.sort(key=lambda station: station.get("riverKm") or 9999)
    if len(gauges) < 20:
        raise ValueError(f"PEGELONLINE lieferte nur {len(gauges)} deutsche Rheinpegel")
    return gauges


def niz_meta(station: dict) -> dict:
    source_id = str(station["id"])
    name = str(station.get("label") or station.get("title") or source_id)
    if "/" in name:
        name = name.split("/", 1)[1].strip()
    slug = f"niz-{source_id}-{slugify(name)}"
    provider = "NIZ / LUBW"
    return {
        "type": "quality",
        "id": f"quality-niz-{source_id}",
        "slug": slug,
        "sourceId": source_id,
        "name": name,
        "latitude": float(station["lat"]),
        "longitude": float(station["lon"]),
        "riverKm": NIZ_RIVER_KM.get(source_id),
        "provider": provider,
        "dataUrl": f"data/quality/{slug}.json",
        "sourceUrl": NIZ_SOURCE_PAGE,
        "apiUrl": (
            f"{NIZ_STATION_URL}?id={source_id}"
            "&component=guete-temp&from=8d-ago"
        ),
    }


def fetch_niz_catalog() -> list:
    raw = request_json(NIZ_STATIONS_URL)
    items = ((raw or {}).get("selectorStations") or {}).get("items") or []
    result = []
    for station in items:
        label = str(station.get("label") or "")
        if not label.lower().startswith("rhein /"):
            continue
        # Worms ist auch über die generische NIZ-API verfügbar, wird hier aber
        # durch den zuständigen GUS-Datensatz des LfU RLP ersetzt.
        if str(station.get("id")) == "88575":
            continue
        result.append(niz_meta(station))
    if len(result) < 5:
        raise ValueError(f"NIZ lieferte nur {len(result)} Rhein-Gütestationen")
    return result


def niz_header_key(label: str):
    text = html.unescape(re.sub(r"<[^>]+>", " ", str(label))).lower()
    if "datum" in text or "zeit" in text:
        return "timestamp"
    return canonical_key(text)


def fetch_niz_quality(meta: dict) -> dict:
    fetched_at = now_local()
    raw = request_json(meta["apiUrl"])
    station = ((raw or {}).get("infoPanel") or {}).get("station") or {}
    rows = ((raw or {}).get("table") or {}).get("data") or []
    headers = ((raw or {}).get("table") or {}).get("header") or []
    header_keys = [niz_header_key(item.get("label", "")) for item in headers]
    history_buckets = {}
    for row in rows:
        if not row:
            continue
        try:
            observed = epoch_ms_to_dt(row[0])
        except (TypeError, ValueError, OSError):
            continue
        for index, key in enumerate(header_keys):
            if key in (None, "timestamp") or index >= len(row):
                continue
            value = number(row[index])
            if value is None:
                continue
            hour = observed.replace(minute=0, second=0, microsecond=0)
            history_buckets.setdefault(key, {})[hour] = value

    latest = station.get("messreihen") or {}
    niz_keys = {
        "temp": "water_temperature",
        "o2": "oxygen",
        "pH": "ph",
        "lf": "conductivity",
        "tr": "turbidity",
        "chl": "chlorophyll",
    }
    items = []
    for source_key, key in niz_keys.items():
        measurement = latest.get(source_key) or {}
        values = measurement.get("values") or {}
        value = number(values.get("latest"))
        timestamp = values.get("latest-ts")
        if value is None or timestamp is None:
            continue
        items.append(
            make_item(key, value, measurement.get("dimension") or "", epoch_ms_to_dt(timestamp))
        )
    if not items:
        raise ValueError(f"NIZ {meta['name']}: keine aktuellen Messwerte")

    history = {}
    for key, buckets in history_buckets.items():
        label = MEASUREMENTS[key]["label"]
        history[label] = [
            {"t": iso_local(timestamp), "v": round(value, 3)}
            for timestamp, value in sorted(buckets.items())
        ][-192:]
    payload = quality_payload(meta, items, history, fetched_at)
    payload["operator"] = station.get("betreiber")
    return payload


def gus_headers(meta: dict) -> dict:
    return {
        "Referer": f"{GUS_BASE}/gus/{meta['sourceId']}/messwerte",
        "Accept": "application/json, text/csv;q=0.9, */*;q=0.5",
    }


def gus_url(dataset: str, filters: list[tuple[str, str]], export=False) -> str:
    section = "export" if export else "data"
    return f"{GUS_BASE}/api/{section}/{dataset}?{urlencode(filters)}"


def decode_csv(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ValueError("GUS-CSV hat eine unbekannte Zeichenkodierung")


def fetch_gus_quality(meta: dict, previous: dict | None) -> dict:
    fetched_at = now_local()
    filters = [
        ("w", f"MESSST_NR=number:{meta['sourceId']}"),
        ("w", f"leitung_nr=number:{meta['line']}"),
    ]
    current_url = gus_url("gus_messwerte_messwerteaktuell", filters)
    current = request_json(current_url, headers=gus_headers(meta))
    items = []
    for measurement in current:
        key = canonical_key(measurement.get("stoff_bezeichnung", ""))
        value = number(measurement.get("messwert"))
        if key is None or value is None or not measurement.get("datum"):
            continue
        items.append(
            make_item(
                key,
                value,
                measurement.get("stoff_einheit") or "",
                parse_iso(measurement["datum"]),
            )
        )
    if not items:
        raise ValueError(f"GUS {meta['name']}: keine aktuellen Messwerte")

    history = (previous or {}).get("history") or {}
    try:
        export_filters = [
            ("w", f"messst_nr={meta['sourceId']}"),
            ("w", f"leitung_nr=number:{meta['line']}"),
        ]
        export_url = gus_url("gus_ganglinie.csv", export_filters, export=True)
        raw_csv = request_bytes(
            export_url,
            timeout=120,
            headers={
                **gus_headers(meta),
                "Accept": "text/csv, text/plain;q=0.9, */*;q=0.5",
            },
        )
        reader = csv.DictReader(io.StringIO(decode_csv(raw_csv)), delimiter=";")
        cutoff = fetched_at - timedelta(days=8)
        buckets = {}
        for row in reader:
            key = canonical_key(row.get("Bezeichnung", ""))
            value = number(row.get("Wert"))
            try:
                observed = parse_local_date(row.get("Datum", ""))
            except (TypeError, ValueError):
                continue
            if key is None or value is None or observed < cutoff:
                continue
            hour = observed.replace(minute=0, second=0, microsecond=0)
            bucket = buckets.setdefault(key, {})
            previous_point = bucket.get(hour)
            if previous_point is None or observed >= previous_point[0]:
                bucket[hour] = (observed, value)
        history = {}
        for key, by_hour in buckets.items():
            history[MEASUREMENTS[key]["label"]] = [
                {"t": iso_local(hour), "v": round(pair[1], 3)}
                for hour, pair in sorted(by_hour.items())
            ][-192:]
    except Exception as exc:
        print(f"WARNUNG: GUS-Historie {meta['name']} bleibt erhalten: {exc}")

    return quality_payload(meta, items, history, fetched_at)


def fetch_nrw_quality(meta: dict) -> dict:
    """Liest den stündlichen Wassertemperatur-Verlauf des NRW-Hochwasserportals."""
    fetched_at = now_local()
    raw = request_json(meta["apiUrl"])
    series = raw[0] if isinstance(raw, list) and raw else {}
    points = []
    for row in series.get("data") or []:
        if not isinstance(row, list) or len(row) < 2:
            continue
        value = number(row[1])
        if value is None:
            continue
        try:
            observed = parse_iso(row[0])
        except (TypeError, ValueError):
            continue
        points.append((observed, value))
    points.sort(key=lambda point: point[0])
    if not points:
        raise ValueError(f"NRW {meta['name']}: keine aktuellen Messwerte")
    latest_time, latest_value = points[-1]
    unit = series.get("ts_unitsymbol") or "°C"
    items = [make_item("water_temperature", latest_value, unit, latest_time)]
    history = {
        MEASUREMENTS["water_temperature"]["label"]: [
            {"t": iso_local(observed), "v": round(value, 3)}
            for observed, value in points[-192:]
        ]
    }
    payload = quality_payload(meta, items, history, fetched_at)
    payload["operator"] = series.get("BODY_RESPONSIBLE") or "LANUV"
    return payload


def unavailable_payload(meta: dict, error: Exception) -> dict:
    attempted = now_local()
    return {
        "schemaVersion": 2,
        "id": meta["id"],
        "slug": meta["slug"],
        "updated": "",
        "generatedAt": iso_local(attempted),
        "observedAt": None,
        "station": f"Rhein {meta['name']}",
        "provider": meta["provider"],
        "latitude": meta["latitude"],
        "longitude": meta["longitude"],
        "riverKm": meta.get("riverKm"),
        "items": [],
        "history": {},
        "fetch": {
            "state": "unavailable",
            "lastAttemptAt": iso_local(attempted),
            "lastSuccessAt": None,
            "errorCode": type(error).__name__,
        },
    }


def usable_quality_payload(payload) -> bool:
    return (
        isinstance(payload, dict)
        and isinstance(payload.get("items"), list)
        and bool(payload["items"])
        and payload.get("fetch", {}).get("state") != "unavailable"
    )


def public_quality_entry(meta: dict, state: str) -> dict:
    return {
        key: meta.get(key)
        for key in (
            "type",
            "id",
            "slug",
            "name",
            "latitude",
            "longitude",
            "riverKm",
            "provider",
            "dataUrl",
            "sourceUrl",
            "apiUrl",
        )
        if meta.get(key) is not None
    } | {"fetchState": state}


def validate_catalog(catalog: dict) -> list[str]:
    errors = []
    gauges = catalog.get("gauges")
    quality = catalog.get("qualityStations")
    if not isinstance(gauges, list) or not gauges:
        errors.append("keine Rheinpegel im Katalog")
    if not isinstance(quality, list) or not quality:
        errors.append("keine Gütestationen im Katalog")
    gauge_ids = [item.get("id") for item in gauges or []]
    if len(gauge_ids) != len(set(gauge_ids)):
        errors.append("doppelte Pegel-IDs")
    quality_ids = [item.get("id") for item in quality or []]
    if len(quality_ids) != len(set(quality_ids)):
        errors.append("doppelte Gütestations-IDs")
    return errors


def validate_files() -> int:
    catalog = load_json(CATALOG_FILE)
    if not isinstance(catalog, dict):
        print("FEHLER: data/stations.json fehlt oder ist ungültig")
        return 1
    errors = validate_catalog(catalog)
    for station in catalog.get("qualityStations") or []:
        relative = station.get("dataUrl")
        if not relative:
            errors.append(f"{station.get('id')}: dataUrl fehlt")
            continue
        payload = load_json(BASE_DIR / relative)
        if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
            errors.append(f"{station.get('id')}: Stationsdatei ungültig")
    legacy = load_json(LEGACY_FILE)
    if not isinstance(legacy, dict) or not isinstance(legacy.get("items"), list):
        errors.append("wasserwerte.json ist ungültig")
    for error in errors:
        print(f"FEHLER: {error}")
    if not errors:
        print(
            f"OK: {len(catalog['gauges'])} Pegel, "
            f"{len(catalog['qualityStations'])} Gütestationen"
        )
    return 1 if errors else 0


def update_all() -> int:
    DATA_DIR.mkdir(exist_ok=True)
    QUALITY_DIR.mkdir(parents=True, exist_ok=True)
    previous_catalog = load_json(CATALOG_FILE, {}) or {}
    source_status = {}

    try:
        gauges = fetch_gauges()
        source_status["pegelonline"] = "ok"
        print(f"PEGELONLINE: {len(gauges)} deutsche Rheinpegel")
    except Exception as exc:
        gauges = previous_catalog.get("gauges") or []
        source_status["pegelonline"] = "fallback" if gauges else "unavailable"
        print(f"WARNUNG: PEGELONLINE: {exc}")

    try:
        niz_stations = fetch_niz_catalog()
        source_status["niz"] = "ok"
    except Exception as exc:
        niz_stations = [
            item
            for item in previous_catalog.get("qualityStations") or []
            if str(item.get("id", "")).startswith("quality-niz-")
        ]
        source_status["niz"] = "fallback" if niz_stations else "unavailable"
        print(f"WARNUNG: NIZ-Stationskatalog: {exc}")

    quality_meta = list(niz_stations) + [
        {
            **station,
            "type": "quality",
            "dataUrl": f"data/quality/{station['slug']}.json",
            "sourceUrl": f"{GUS_BASE}/gus/{station['sourceId']}/messwerte",
            "apiUrl": (
                f"{GUS_BASE}/api/data/gus_messwerte_messwerteaktuell"
                f"?w=MESSST_NR=number:{station['sourceId']}"
                f"&w=leitung_nr=number:{station['line']}"
            ),
        }
        for station in GUS_STATIONS
    ] + [
        {
            **station,
            "type": "quality",
            "dataUrl": f"data/quality/{station['slug']}.json",
            "sourceUrl": NRW_SOURCE_PAGE,
            "apiUrl": (
                "https://www.hochwasserportal.nrw/data/internet/stations/"
                f"100/{station['sourceId']}/WT/week.json"
            ),
        }
        for station in NRW_STATIONS
    ]
    quality_meta.sort(key=lambda station: station.get("riverKm") or 9999)

    results = {}

    def update_one(meta):
        path = BASE_DIR / meta["dataUrl"]
        previous_candidate = load_json(path)
        if (
            not usable_quality_payload(previous_candidate)
            and meta["id"] == "quality-rlp-2511510500"
        ):
            previous_candidate = load_json(LEGACY_FILE)
        previous = (
            previous_candidate if usable_quality_payload(previous_candidate) else None
        )
        try:
            if meta["id"].startswith("quality-niz-"):
                payload = fetch_niz_quality(meta)
            elif meta["id"].startswith("quality-nrw-"):
                payload = fetch_nrw_quality(meta)
            else:
                payload = fetch_gus_quality(meta, previous)
            atomic_write_json(path, payload)
            return meta["id"], "ok", None
        except Exception as exc:
            if previous is not None:
                return meta["id"], "fallback", exc
            atomic_write_json(path, unavailable_payload(meta, exc))
            return meta["id"], "unavailable", exc

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(update_one, meta): meta for meta in quality_meta}
        for future in as_completed(futures):
            station_id, state, error = future.result()
            results[station_id] = state
            if error:
                print(f"WARNUNG: {station_id}: {error}")
            else:
                print(f"Gütestation aktualisiert: {station_id}")

    for source_name, prefix in (
        ("rlp-gus", "quality-rlp-"),
        ("nrw", "quality-nrw-"),
    ):
        states = [
            state for station_id, state in results.items() if station_id.startswith(prefix)
        ]
        if states and all(state == "ok" for state in states):
            source_status[source_name] = "ok"
        elif any(state == "ok" for state in states):
            source_status[source_name] = "partial"
        elif any(state == "fallback" for state in states):
            source_status[source_name] = "fallback"
        else:
            source_status[source_name] = "unavailable"

    niz_states = [
        results.get(meta["id"], "unavailable")
        for meta in quality_meta
        if meta["id"].startswith("quality-niz-")
    ]
    if source_status.get("niz") == "ok" and any(
        state != "ok" for state in niz_states
    ):
        source_status["niz"] = "partial"

    generated_at = now_local()
    catalog = {
        "schemaVersion": 2,
        "generatedAt": iso_local(generated_at),
        "updated": legacy_time(generated_at),
        "defaultGaugeId": "a37a9aa3-45e9-4d90-9df6-109f3a28a5af",
        "defaultQualityStationId": "quality-rlp-2511510500",
        "sources": source_status,
        "gauges": gauges,
        "qualityStations": [
            public_quality_entry(meta, results.get(meta["id"], "fallback"))
            for meta in quality_meta
        ],
    }
    errors = validate_catalog(catalog)
    if errors:
        for error in errors:
            print(f"FEHLER: {error}")
        return 1
    atomic_write_json(CATALOG_FILE, catalog)

    mainz_path = QUALITY_DIR / "mainz-wiesbaden.json"
    mainz = load_json(mainz_path)
    if mainz is not None:
        atomic_write_json(LEGACY_FILE, mainz)
    elif not LEGACY_FILE.exists():
        print("FEHLER: Mainz-Kompatibilitätsdatei fehlt")
        return 1

    print(
        f"Fertig: {len(gauges)} Pegel, {len(quality_meta)} Gütestationen; "
        f"Fallbacks={sum(state != 'ok' for state in results.values())}"
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="Vorhandene Ausgabedateien ohne Netzwerkzugriff prüfen",
    )
    args = parser.parse_args()
    return validate_files() if args.validate_only else update_all()


if __name__ == "__main__":
    sys.exit(main())
