#!/usr/bin/env python3
"""Refresh payload catalog versions and assets from upstream latest releases."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "payloads" / "catalog.json"
CHUNK = 1024 * 1024
MAX_DOWNLOAD = 512 * CHUNK
USER_AGENT = "PiouAutoLoader-catalog-updater"


def request_json(url):
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def source_path(source):
    match = re.search(r"(?:github\.com|git\.etawen\.dev)/([^/]+/[^/#]+)", source)
    if not match:
        raise ValueError("Cannot identify release provider: " + source)
    return match.group(1).removesuffix(".git")


def latest_release(source):
    repo = source_path(source)
    if "git.etawen.dev" in source:
        url = f"https://git.etawen.dev/api/v1/repos/{repo}/releases/latest"
    else:
        url = f"https://api.github.com/repos/{repo}/releases/latest"
    return request_json(url)


def asset_matches(asset, payload):
    expected = payload.get("asset")
    if expected:
        return asset.get("name") == expected
    filename = payload["filename"]
    return asset.get("name") == filename or asset.get("name", "").endswith(filename)


def digest_download(url, expected_size=None):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    digest = hashlib.sha256()
    total = 0
    chunks = []
    with urllib.request.urlopen(request, timeout=60) as response:
        if not response.geturl().startswith("https://"):
            raise ValueError("Refusing insecure redirect: " + response.geturl())
        while chunk := response.read(CHUNK):
            total += len(chunk)
            if total > MAX_DOWNLOAD:
                raise ValueError("Asset exceeds safety limit: " + url)
            digest.update(chunk)
            chunks.append(chunk)
    if expected_size is not None and total != expected_size:
        raise ValueError(f"Size changed for {url}: expected {expected_size}, got {total}")
    return digest.hexdigest(), total, b"".join(chunks)


def asset_digest(asset, payload):
    digest = (asset.get("digest") or "").removeprefix("sha256:")
    size = asset.get("size")
    if re.fullmatch(r"[a-f0-9]{64}", digest):
        return digest, size, None
    return digest_download(asset["browser_download_url"], size)


def refresh_payload(payload, release):
    assets = [asset for asset in release.get("assets", []) if asset_matches(asset, payload)]
    if len(assets) != 1:
        raise ValueError(f"Expected one asset named {payload.get('asset', payload['filename'])} in {payload['source']}")
    asset = assets[0]
    archive_bytes = None
    digest, size, archive_bytes = asset_digest(asset, payload)
    if payload.get("archive_member"):
        if archive_bytes is None:
            _, _, archive_bytes = digest_download(asset["browser_download_url"], size)
        with zipfile.ZipFile(__import__("io").BytesIO(archive_bytes)) as archive:
            data = archive.read(payload["archive_member"])
        payload["archive_sha256"] = digest
        payload["archive_size"] = size
        payload["sha256"] = hashlib.sha256(data).hexdigest()
        payload["size"] = len(data)
    else:
        payload["sha256"] = digest
        payload["size"] = size
    payload["url"] = asset["browser_download_url"]
    payload["version"] = release.get("tag_name", release.get("tag_name", "latest")).lstrip("v")
    payload["release_url"] = release.get("html_url", "")


def refresh(path=CATALOG, selected=None):
    catalog = json.loads(path.read_text(encoding="utf-8"))
    keys = selected or list(catalog["payloads"])
    for key in keys:
        payload = catalog["payloads"][key]
        print(f"Checking {payload['name']} ({payload['source']})")
        refresh_payload(payload, latest_release(payload["source"]))
    content = json.dumps(catalog, indent=2) + "\n"
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(content, encoding="utf-8")
    os.replace(temporary, path)
    print(f"Updated {len(keys)} catalog entries in {path}")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=CATALOG)
    parser.add_argument("--only", action="append", help="Refresh only this catalog key; repeatable")
    parser.add_argument("--check", action="store_true", help="Show latest assets without changing the catalog")
    args = parser.parse_args(argv)
    if args.check:
        catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
        for key in args.only or catalog["payloads"]:
            payload = catalog["payloads"][key]
            release = latest_release(payload["source"])
            print(f"{key}: {release.get('tag_name')} ({release.get('html_url', '')})")
        return 0
    refresh(args.catalog, args.only)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
