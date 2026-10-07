#!/usr/bin/env python3
"""Prepare an optional, verified USB/data autoload pack. Never sends payloads."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import urllib.request
import zipfile

CATALOG = Path(__file__).resolve().parents[1] / "payloads" / "catalog.json"
CHUNK_SIZE = 1024 * 1024
TIMEOUT = 30


def load_catalog(path=CATALOG):
    catalog = json.loads(path.read_text(encoding="utf-8"))
    if catalog.get("schema") != 1:
        raise ValueError("Unsupported catalog schema")
    for payload in catalog["payloads"].values():
        if not re.fullmatch(r"[A-Za-z0-9_.-]+\.elf", payload["filename"]):
            raise ValueError("Invalid payload filename")
        if payload.get("archive_member") and not payload["archive_member"].endswith(".elf"):
            raise ValueError("Archive member must be an ELF")
        if not payload["url"].startswith("https://"):
            raise ValueError("Payload URLs must use HTTPS")
        if not re.fullmatch(r"[a-f0-9]{64}", payload["sha256"]):
            raise ValueError("Invalid SHA-256 digest")
        if not 0 < payload["size"] <= 128 * CHUNK_SIZE:
            raise ValueError("Invalid payload size")
        if payload.get("archive_member"):
            if not re.fullmatch(r"[a-f0-9]{64}", payload.get("archive_sha256", "")):
                raise ValueError("Invalid archive SHA-256 digest")
            if not 0 < payload.get("archive_size", 0) <= 512 * CHUNK_SIZE:
                raise ValueError("Invalid archive size")
    return catalog


def firmware(value):
    if not re.fullmatch(r"\d{1,2}\.\d{2}", value):
        raise argparse.ArgumentTypeError("Use a firmware such as 9.00 or 11.60")
    major, minor = map(int, value.split("."))
    number = major * 100 + minor
    if not (100 <= number <= 550 or 700 <= number <= 1360):
        raise argparse.ArgumentTypeError("Firmware is outside PiouAutoLoader's supported ranges")
    return value


def select_payloads(catalog, requested):
    payloads, ordered, visiting = catalog["payloads"], [], set()

    def visit(key):
        if key not in payloads:
            raise ValueError("Unknown payload: " + key)
        if key in visiting:
            raise ValueError("Dependency cycle: " + key)
        if key in ordered:
            return
        visiting.add(key)
        for dependency in payloads[key]["requires"]:
            visit(dependency)
        visiting.remove(key)
        ordered.append(key)

    for key in requested:
        visit(key)
    for key in ordered:
        overlap = set(payloads[key]["conflicts"]) & set(ordered)
        if overlap:
            raise ValueError(key + " conflicts with " + ", ".join(sorted(overlap)))
    if not ordered:
        raise ValueError("Choose at least one payload, or use the manager profile")
    return ordered


def verified(path, payload):
    if not path.is_file() or path.stat().st_size != payload["size"]:
        return False
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest() == payload["sha256"]


def fetch(payload, cache):
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / (payload["sha256"] + ".elf")
    if payload.get("archive_member"):
        archive = cache / (payload["archive_sha256"] + ".zip")
        if not verified_archive(archive, payload):
            download(payload, archive)
        with zipfile.ZipFile(archive) as source:
            try:
                data = source.read(payload["archive_member"])
            except KeyError as error:
                raise ValueError("Missing archive member: " + payload["archive_member"]) from error
        if len(data) != payload["size"] or hashlib.sha256(data).hexdigest() != payload["sha256"]:
            raise ValueError("Extracted checksum or size mismatch: " + payload["name"])
        target.write_bytes(data)
        return target
    if verified(target, payload):
        return target
    download(payload, target)
    return target


def verified_archive(path, payload):
    return path.is_file() and path.stat().st_size == payload["archive_size"] and digest_file(path) == payload["archive_sha256"]


def digest_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(payload, target):
    request = urllib.request.Request(payload["url"], headers={"User-Agent": "PiouAutoLoader-pack"})
    with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as file:
        temporary = Path(file.name)
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
                if not response.geturl().startswith("https://"):
                    raise ValueError("Refusing an insecure download redirect")
                total = 0
                while chunk := response.read(CHUNK_SIZE):
                    total += len(chunk)
                    limit = payload.get("archive_size", payload["size"])
                    if total > limit:
                        raise ValueError("Download exceeds pinned size")
                    file.write(chunk)
            file.close()
            if payload.get("archive_member"):
                if not verified_archive(temporary, payload):
                    raise ValueError("Archive checksum or size mismatch: " + payload["name"])
            elif not verified(temporary, payload):
                raise ValueError("Checksum or size mismatch: " + payload["name"])
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
    return target


def autoload_text(payloads, delay):
    lines = ["# Generated by PiouAutoLoader; see pack.json for pinned versions."]
    for index, payload in enumerate(payloads):
        lines.append(payload["filename"])
        if index < len(payloads) - 1:
            lines.append("!" + str(delay if delay is not None else payload["delay_ms"]))
    return "\n".join(lines) + "\n"


def build_pack(payloads, options):
    output = options.output.absolute()
    if output.exists() or output.is_symlink():
        raise ValueError("Output already exists; choose a new directory to preserve its configuration")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".piou-pack-", dir=output.parent) as temporary:
        staging = Path(temporary) / "pack"
        staging.mkdir()
        for payload in payloads:
            print("Preparing " + payload["name"] + " " + payload["version"])
            shutil.copyfile(fetch(payload, options.cache), staging / payload["filename"])
        manifest = {"firmware": options.firmware, "hardware_verified": False,
                    "autoload_enabled": options.autoload, "payloads": payloads}
        (staging / "pack.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        name = "autoload.txt" if options.autoload else "autoload.example.txt"
        (staging / name).write_text(autoload_text(payloads, options.delay), encoding="utf-8")
        (staging / "README.txt").write_text(pack_instructions(options), encoding="utf-8")
        # Reserve the destination so a racing invocation cannot replace it.
        output.mkdir()
        try:
            # Publish the active configuration last, after every ELF exists.
            for file in sorted(staging.iterdir(), key=lambda item: item.name == "autoload.txt"):
                shutil.move(str(file), output / file.name)
        except BaseException:
            shutil.rmtree(output)
            raise
    print("Pack ready: " + str(output))


def pack_instructions(options):
    return (
        "PiouAutoLoader optional payload pack\n\n"
        "Copy this folder as ps5_autoloader at the USB root, or as /data/ps5_autoloader.\n"
        "Preserve any existing configuration before replacing it. USB takes priority.\n"
        + ("Autoload is enabled: autoload.txt replaces the default Payload Manager launch.\n"
           if options.autoload else
           "Autoload is OFF. Review autoload.example.txt and rename it to autoload.txt to opt in.\n")
        + "To disable this pack, rename/remove autoload.txt. Payload files may remain.\n"
        "Fixed delays allow startup time; they do not verify service readiness.\n"
        "Firmware selection validates the Piou chain range, not every upstream payload.\n"
        "Read pack.json for sources, versions, and project-specific compatibility notes.\n"
        "Do not combine ELF Arsenal with a second kstuff/ShadowMount/cheat stack.\n"
    )


def parser(catalog):
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--list", action="store_true", help="List available payloads without downloading")
    cli.add_argument("--profile", choices=catalog["profiles"], default="manager")
    cli.add_argument("--add", action="append", choices=catalog["payloads"], default=[])
    cli.add_argument("--firmware", type=firmware, help="Console firmware, e.g. 9.00")
    cli.add_argument("--output", type=Path, default=Path("payload-pack/ps5_autoloader"))
    cli.add_argument("--cache", type=Path, default=Path.home() / ".cache/piou-autoloader/payloads")
    cli.add_argument("--autoload", action="store_true", help="Opt in: create an active autoload.txt")
    cli.add_argument("--plan", action="store_true", help="Show launch order and notes without downloading")
    cli.add_argument("--delay", type=int, help="Override inter-payload waits in milliseconds (1000–60000)")
    return cli


def main(argv=None):
    try:
        argv = list(sys.argv[1:] if argv is None else argv)
        refresh = "--refresh-catalog" in argv
        if refresh:
            argv.remove("--refresh-catalog")
            from update_catalog import refresh as refresh_catalog
            refresh_catalog()
        catalog = load_catalog()
        cli = parser(catalog)
        cli.add_argument("--refresh-catalog", action="store_true", help=argparse.SUPPRESS)
        options = cli.parse_args(argv)
        if options.list:
            for key, payload in catalog["payloads"].items():
                print(f"{key:18} {payload['version']:12} {payload['note']}")
            return 0
        if options.firmware is None:
            cli.error("--firmware is required")
        if options.delay is not None and not 1000 <= options.delay <= 60000:
            cli.error("--delay must be between 1000 and 60000")
        keys = select_payloads(catalog, catalog["profiles"][options.profile] + options.add)
        payloads = [catalog["payloads"][key] for key in keys]
        for index, payload in enumerate(payloads, 1):
            print(f"{index}. {payload['name']} {payload['version']} — {payload['note']}")
        print("Autoload: " + ("ON" if options.autoload else "OFF (example only)"))
        if not options.plan:
            build_pack(payloads, options)
        return 0
    except (OSError, ValueError, KeyError) as error:
        print("Payload pack: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
