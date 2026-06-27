from __future__ import annotations

import argparse
import json
import random
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote_plus, urljoin, urlparse

import requests
from bs4 import BeautifulSoup, Comment

BASE = "https://fbref.com"
TEAMS = ("Croatia", "Ghana")
OUTPUT = Path("data/croatia_ghana_test.json")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"


class Client:
    def __init__(self, delay_min: float, delay_max: float):
        self.delay_min = delay_min
        self.delay_max = delay_max
        self.first = True
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": UA,
            "Accept-Language": "en-US,en;q=0.9",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        })

    def get(self, url: str) -> requests.Response:
        if not self.first:
            time.sleep(random.uniform(self.delay_min, self.delay_max))
        self.first = False
        response = self.session.get(url, timeout=25, allow_redirects=True)
        if response.status_code in (401, 403, 429):
            raise RuntimeError(f"FBRef bloqueó la petición (HTTP {response.status_code}): {url}")
        response.raise_for_status()
        return response


def soup(html: str) -> BeautifulSoup:
    parsed = BeautifulSoup(html, "lxml")
    for comment in parsed.find_all(string=lambda value: isinstance(value, Comment)):
        if "<table" in comment:
            fragment = BeautifulSoup(str(comment), "lxml")
            for table in fragment.find_all("table"):
                parsed.append(table)
    return parsed


def name(value: str | None) -> str:
    cleaned = re.sub(r"\s+", " ", value or "").strip().casefold()
    return cleaned.replace(" men", "").replace(" national team", "")


def integer(value: str | None) -> int | None:
    match = re.search(r"-?\d+", value or "")
    return int(match.group()) if match else None


def decimal(value: str | None) -> float | None:
    match = re.search(r"-?\d+(?:\.\d+)?", (value or "").replace(",", "."))
    return float(match.group()) if match else None


def cell(row, stat: str) -> str | None:
    node = row.find(["td", "th"], attrs={"data-stat": stat})
    return node.get_text(" ", strip=True) if node else None


def resolve_team(client: Client, team: str, explicit: str | None) -> str:
    if explicit:
        return explicit
    response = client.get(f"{BASE}/en/search/search.fcgi?search={quote_plus(team + ' national team')}")
    if "/squads/" in urlparse(response.url).path or "/national/" in urlparse(response.url).path:
        return response.url
    candidates = []
    for link in soup(response.text).find_all("a", href=True):
        href, text = link["href"], name(link.get_text(" ", strip=True))
        if ("/squads/" in href or "/national/" in href) and name(team) in text:
            candidates.append(urljoin(BASE, href))
    if not candidates:
        raise RuntimeError(f"No se encontró la página de {team} en FBRef")
    return candidates[0]


def schedule_pages(team_url: str, page: BeautifulSoup) -> list[str]:
    result = [team_url]
    for link in page.find_all("a", href=True):
        href = link["href"]
        if "matchlogs" in href and ("schedule" in href or "Scores & Fixtures" in link.get_text(" ", strip=True)):
            result.append(urljoin(BASE, href))
    return list(dict.fromkeys(result))


def match_links(team: str, page: BeautifulSoup) -> list[dict]:
    matches = {}
    for table in page.find_all("table"):
        table_id = table.get("id", "")
        if "sched" not in table_id and "matchlogs" not in table_id:
            continue
        for row in (table.find("tbody") or table).find_all("tr"):
            report_cell = row.find(["td", "th"], attrs={"data-stat": "match_report"})
            report = report_cell.find("a", href=True) if report_cell else None
            report = report or row.find("a", href=True, string=re.compile("Match Report", re.I))
            date = cell(row, "date")
            if not report or not date or not re.match(r"\d{4}-\d{2}-\d{2}", date):
                continue
            url = urljoin(BASE, report["href"])
            matches[url] = {
                "team": team,
                "date": date[:10],
                "competition": cell(row, "comp"),
                "round": cell(row, "round"),
                "venue": cell(row, "venue"),
                "opponent": cell(row, "opponent"),
                "goals_for": integer(cell(row, "goals_for")),
                "goals_against": integer(cell(row, "goals_against")),
                "source_url": url,
            }
    return sorted(matches.values(), key=lambda item: item["date"], reverse=True)


def recent_reports(client: Client, team: str, team_url: str, limit: int) -> list[dict]:
    response = client.get(team_url)
    first_page = soup(response.text)
    found = {}
    for url in schedule_pages(team_url, first_page):
        current = first_page if url == team_url else soup(client.get(url).text)
        for item in match_links(team, current):
            found[item["source_url"]] = item
    return sorted(found.values(), key=lambda item: item["date"], reverse=True)[:limit]


def apply_stat(stats: dict, label: str, home: str, away: str) -> None:
    label = label.casefold()
    if "possession" in label:
        stats["home_possession"], stats["away_possession"] = decimal(home), decimal(away)
    elif "shots on target" in label:
        hm, am = re.search(r"(\d+)\s+of\s+(\d+)", home), re.search(r"(\d+)\s+of\s+(\d+)", away)
        stats["home_shots_on_target"] = int(hm.group(1)) if hm else integer(home)
        stats["away_shots_on_target"] = int(am.group(1)) if am else integer(away)
        if hm:
            stats["home_shots"] = int(hm.group(2))
        if am:
            stats["away_shots"] = int(am.group(2))
    elif "corner" in label:
        stats["home_corners"], stats["away_corners"] = integer(home), integer(away)
    elif "foul" in label:
        stats["home_fouls"], stats["away_fouls"] = integer(home), integer(away)
    elif "yellow" in label:
        stats["home_yellows"], stats["away_yellows"] = integer(home), integer(away)
    elif "red" in label:
        stats["home_reds"], stats["away_reds"] = integer(home), integer(away)


def report(client: Client, match: dict) -> dict:
    page = soup(client.get(match["source_url"]).text)
    result = dict(match)
    scorebox = page.find("div", class_="scorebox")
    if scorebox:
        teams = []
        for link in scorebox.find_all("a", href=True):
            if "/squads/" in link["href"] or "/national/" in link["href"]:
                label = link.get_text(" ", strip=True)
                if label and name(label) not in map(name, teams):
                    teams.append(label)
        scores = [integer(node.get_text(" ", strip=True)) for node in scorebox.find_all("div", class_="score")]
        if len(teams) >= 2:
            result["home_team"], result["away_team"] = teams[:2]
        if len(scores) >= 2:
            result["home_score"], result["away_score"] = scores[:2]

    main = page.find("div", id="team_stats") or page.find("table", id="team_stats")
    if main:
        for row in main.find_all("tr"):
            header, values = row.find("th"), row.find_all("td")
            if header and len(values) >= 2:
                apply_stat(result, header.get_text(" ", strip=True), values[0].get_text(" ", strip=True), values[1].get_text(" ", strip=True))
    extra = page.find("div", id="team_stats_extra") or page.find("table", id="team_stats_extra")
    if extra:
        for row in extra.find_all("tr"):
            values = row.find_all("td")
            if len(values) >= 3:
                apply_stat(result, values[1].get_text(" ", strip=True), values[0].get_text(" ", strip=True), values[2].get_text(" ", strip=True))
    return result


def perspective(team: str, match: dict) -> dict:
    is_home = name(team) == name(match.get("home_team"))
    is_away = name(team) == name(match.get("away_team"))
    prefix = "home" if is_home else "away" if is_away else None
    other = "away" if prefix == "home" else "home" if prefix == "away" else None
    take = lambda field: match.get(f"{prefix}_{field}") if prefix else None
    take_other = lambda field: match.get(f"{other}_{field}") if other else None
    return {
        "team": team,
        "date": match.get("date"),
        "competition": match.get("competition"),
        "round": match.get("round"),
        "opponent": match.get(f"{other}_team") if other else match.get("opponent"),
        "venue_role": prefix or match.get("venue") or "unknown",
        "goals_for": take("score") if take("score") is not None else match.get("goals_for"),
        "goals_against": take_other("score") if take_other("score") is not None else match.get("goals_against"),
        "shots": take("shots"),
        "shots_on_target": take("shots_on_target"),
        "possession": take("possession"),
        "corners": take("corners"),
        "fouls": take("fouls"),
        "yellow_cards": take("yellows"),
        "red_cards": take("reds"),
        "source_url": match.get("source_url"),
    }


def summary(matches: list[dict]) -> dict:
    fields = ("goals_for", "goals_against", "shots", "shots_on_target", "possession", "corners", "fouls", "yellow_cards", "red_cards")
    averages = {}
    completeness = {}
    for field in fields:
        values = [float(item[field]) for item in matches if isinstance(item.get(field), (int, float))]
        averages[field] = round(sum(values) / len(values), 3) if values else None
        completeness[field] = len(values)
    return {"matches_found": len(matches), "averages": averages, "data_completeness": completeness}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--delay-min", type=float, default=5)
    parser.add_argument("--delay-max", type=float, default=8)
    parser.add_argument("--croatia-url")
    parser.add_argument("--ghana-url")
    args = parser.parse_args()
    if args.delay_min < 3 or args.delay_max < args.delay_min:
        raise SystemExit("Usa un retraso mínimo de 3 segundos")

    client = Client(args.delay_min, args.delay_max)
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "status": "partial_or_failed",
        "test_fixture": {
            "home_team": "Croatia",
            "away_team": "Ghana",
            "kickoff": "2026-06-27T23:00:00+02:00",
            "competition": "FIFA World Cup 2026",
            "group": "L",
            "status": "scheduled",
            "note": "El informe de este partido solo existirá después del encuentro."
        },
        "teams": {},
        "diagnostics": []
    }
    explicit = {"Croatia": args.croatia_url, "Ghana": args.ghana_url}
    for team in TEAMS:
        result = {"status": "pending", "matches": []}
        payload["teams"][team] = result
        try:
            team_url = resolve_team(client, team, explicit[team])
            result["team_url"] = team_url
            links = recent_reports(client, team, team_url, args.limit)
            result["reports_discovered"] = len(links)
            for item in links:
                try:
                    result["matches"].append(perspective(team, report(client, item)))
                except Exception as error:
                    payload["diagnostics"].append({"team": team, "url": item["source_url"], "error": str(error)})
            result["summary"] = summary(result["matches"])
            result["status"] = "complete" if len(result["matches"]) >= args.limit else "partial"
        except Exception as error:
            result["status"] = "blocked_or_error"
            result["error"] = str(error)
            payload["diagnostics"].append({"team": team, "error": str(error)})

    if all(item["status"] == "complete" for item in payload["teams"].values()):
        payload["status"] = "complete"
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({team: {"status": data["status"], "matches": len(data["matches"]), "error": data.get("error")} for team, data in payload["teams"].items()}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
