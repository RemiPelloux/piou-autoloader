# Optional payload packs

PiouAutoLoader keeps Payload Manager as its default. This builder prepares a separate USB/internal-drive folder containing only the payloads you select. It does not send payloads to a console, install a TV package, enable content sources, or change an existing configuration.

Download and extract `piou-autoloader-payload-tools_v0.5.4.zip` from Releases, or use this repository. Python 3.10+ is required; no pip packages are needed. Run commands from the extracted folder/repository root.

## Choose a profile

| Profile | Launch order | When to choose it |
|---|---|---|
| `manager` | Payload Manager | Interactive selection; default |
| `arsenal` | ELF Arsenal | Let Arsenal manage its bundled services |
| `modular` | kstuff-lite → ShadowMountPlus → CheatRunner | Configure services individually |
| `orbit` | kstuff-lite → ShadowMountPlus → Orbit Store | Orbit browser service and its library dependency |
| `custom` | Your `--add` selections plus required dependencies | A smaller custom setup |

ELF Arsenal already bundles kstuff-lite, ShadowMountPlus and CheatRunner. The builder rejects combinations that duplicate those services. Orbit can be added to Arsenal separately. Avoid running another HEN/kstuff stack alongside these presets.

## Preview before downloading

```bash
python3 tools/payload_pack.py --list
python3 tools/payload_pack.py --profile modular --firmware 9.00 --plan
```

The firmware argument checks PiouAutoLoader's supported routing ranges. It is **not certification that every selected payload works on that firmware**. The plan prints upstream notes, including beta status. Read each project's release notes for your firmware.

## Download without automatic startup

```bash
python3 tools/payload_pack.py --profile arsenal --firmware 9.00
```

This creates `payload-pack/ps5_autoloader/` with verified ELF files, a `pack.json` provenance manifest, instructions, and an **inactive** `autoload.example.txt`. Rename the example to `autoload.txt` only when you want automatic startup.

## Opt in to automatic startup

```bash
python3 tools/payload_pack.py --profile arsenal --add orbit-store --firmware 9.00 \
  --autoload --output payload-pack/arsenal/ps5_autoloader

python3 tools/payload_pack.py --profile modular --add payload-manager --firmware 11.60 \
  --autoload --output payload-pack/modular/ps5_autoloader
```

Copy the resulting `ps5_autoloader` directory to the **root of a USB drive**, or to **`/data/ps5_autoloader`** on the console. USB takes priority. The builder can also write directly to a new USB directory using `--output /path/to/USB/ps5_autoloader`. Existing output directories are refused to preserve files and configurations.

An active `autoload.txt` replaces the default Payload Manager launch. Add `--add payload-manager` if you want it in your sequence. To revert, rename or remove that config; the ELF files can stay.

Dependencies load before their consumers. Default waits are 5 seconds after kstuff and ShadowMountPlus, 10 seconds after Arsenal, and 1–2 seconds for other services. These are conservative scheduling defaults, **not readiness probes**. Use `--delay 10000` to override every inter-payload wait if testing on your console shows more time is needed.

## Included projects

| Project | Pinned release | Interface / notes |
|---|---|---|
| [ELF Arsenal](https://git.etawen.dev/soniciso/elf-arsenal) | 1.6.23 | `http://<PS5-IP>:6969`; bundled services, upstream first-run settings apply |
| [Orbit Store](https://github.com/saawant12/orbit-store-ps5) | 0.8.0 beta | `http://<PS5-IP>:34177`; pairing and source selection remain opt-in upstream |
| [ShadowMountPlus](https://github.com/drakmor/ShadowMountPlus) | 1.7beta3 | The ShadowMount variant used here; requires kstuff-lite 1.07+ |
| [CheatRunner](https://github.com/notmaj0r/CheatRunner) | 0.17.2 | `http://<PS5-IP>:9999`; do not enable competing cheat engines |
| [kstuff-lite](https://github.com/EchoStretch/kstuff-lite) | 1.11 beta | Upstream advertises FW 1.00–13.60; features vary by firmware |
| [Payload Manager](https://github.com/itsPLK/ps5-payload-manager) | 0.5.2 | Interactive management and its separate autoload configuration |

Orbit's native TV app is a separate upstream installation; this tool prepares its browser-service ELF only. Orbit's source choices remain off until configured in Orbit. ShadowMountPlus documents potential shutdown/data-corruption issues on some firmware; read its upstream notes before enabling it. No firmware or service settings are silently changed by the pack builder.

## Integrity and performance

- Versioned HTTPS URLs, byte sizes, and SHA-256 digests are pinned in `payloads/catalog.json`; no moving “latest” download at startup.
- GitHub digests come from release-asset metadata. Arsenal's digest was measured from its official release download; it is a reproducibility pin, not a publisher signature.
- Files stream in 1 MiB chunks. Verified downloads are reused from `~/.cache/piou-autoloader/payloads`, avoiding repeated downloads and large memory buffers.
- Dependencies are deduplicated. A failed or mismatched download cannot publish an active pack; `autoload.txt` is copied last.
- A manifest records the exact source and version of every payload. Upstream binaries are downloaded on demand, not committed or redistributed in this repository.
- Payload versions update only when the catalog is reviewed. Verify current upstream compatibility before updating a working console.

These packs are generated and integrity-tested on desktop. End-to-end console execution and the suggested delays still require hardware validation.
