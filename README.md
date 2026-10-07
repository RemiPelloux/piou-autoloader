<p align="center">
  <img src="assets/icon.svg" width="160" height="160" alt="PiouAutoLoader — a bird taking flight" />
</p>
<h1 align="center">PiouAutoLoader</h1>
<p align="center">Your PS5 homebrew launch routine, one homescreen shortcut.</p>
<p align="center">
  <a href="#install">Install</a> · <a href="#payloads">Payloads</a> ·
  <a href="#troubleshooting">Troubleshooting</a> · <a href="#development">Development</a>
</p>

PiouAutoLoader installs a homescreen shortcut, caches the launch pages on your console, and loads your configured ELF payloads. It brings firmware selection, progress, logs, and retry controls into one lightweight interface.

The PC host is needed only for initial setup when you are not already jailbroken. After installation, the shortcut uses the console's cache. Network requirements depend on the selected chain.

## Compatibility

| Firmware | Chain | Network requirement after installation |
|---|---|---|
| 1.00–5.50 | umtx2 | Offline |
| 7.00–12.00 | Poops | Offline |
| 7.00–13.60, except 9.05 and 11.40 | Relapse | Active Wi-Fi or Ethernet interface |

Firmware 6.xx and versions outside these ranges are unsupported. Where both Poops and Relapse are available, the installer offers a choice. Relapse is the default if no saved choice exists. These ranges describe the routing implemented here; success still depends on upstream chain support and the console's state.

## Install

Use release artifacts from your repository's **Releases** page when available. A source checkout is not a ready-to-run installer.

### Already jailbroken

1. Send `piou-autoloader-installer_vX.Y.Z.elf` with elfldr, or launch it through Payload Manager.
2. Let the browser finish caching. The installer creates or updates the **PiouAutoLoader** homescreen app after caching succeeds.
3. Reboot once, then launch **PiouAutoLoader** from the homescreen.

### First installation from a PC

1. Run the bundled `piou-autoloader-host_vX.Y.Z.py` or Windows `.exe` on a PC on the same network.
2. Set the PS5's DNS server to the PC address shown by the host. Allow DNS/UDP 53 and HTTPS/TCP 443 through the PC firewall. Binding these ports may require administrator privileges.
3. Open **Settings → User's Guide** on the PS5 and let installation finish.
4. Restore the console's DNS setting to automatic, reboot, and launch **PiouAutoLoader**.

While running, the host resolves the guide domain to your PC and returns NXDOMAIN for other domains. Restore DNS before using the console's normal internet services. The host's “Installer served” message only confirms delivery of the page; it does not confirm successful installation.

### Update

Repeat installation with the new release. This refreshes the cached pages and homescreen app. Payload files and `autoload.txt` in your USB or internal payload directory are preserved.

## Payloads

### Payload Manager

Without an `autoload.txt`, the unified autoloader starts **Payload Manager**, where you can configure and send payloads through its web interface. Its own autoload feature is separate from the file-based configuration below.

### A fixed sequence

Create `ps5_autoloader/` at the root of a USB drive, or use `/data/ps5_autoloader` on the internal drive. USB takes priority. Place payloads and `autoload.txt` together:

```text
ps5_autoloader/
├── autoload.txt
├── elfldr.elf
└── etaHEN.elf
```

Example `autoload.txt`:

```text
# Filenames are case-sensitive.
elfldr.elf
# Wait four seconds for the custom loader to start.
!4000
etaHEN.elf
```

Each filename loads a payload; `!1000` waits one second. When a config exists, Payload Manager does not start automatically. Add `pldmgr.elf` and list it explicitly if you want it in the sequence.

The bundled loader used by Poops and Relapse accepts localhost connections. To send payloads from another device, load your preferred network-accessible ELF loader through Payload Manager or `autoload.txt`. umtx2 uses its stock loader.

## Progress and recovery

- **Five checkpoints:** Boot → WebKit → Kernel → elfldr → Payload, with stage timings.
- **Live logs:** a bounded 200-line view, severity styling, and a **New output** button when reading earlier output.
- **Stall detection:** a warning after 30 seconds without initial output, followed by a stalled state after two minutes without observed activity. This is a UI heuristic, not proof that the chain has stopped.
- **Retry and Restart:** start a fresh page session and clear stale Poops session flags. Press `R` or use the buttons.
- **Details:** firmware, chain, state, elapsed time, and user agent for troubleshooting. Terminal states freeze the elapsed time.
- **Bounded installer:** the temporary native HTTP server binds to localhost, limits connections, and exits after ten minutes if installation never completes.

## Troubleshooting

| Symptom | What to check |
|---|---|
| User's Guide cannot connect | Same network, PC firewall, correct DNS address, and host ports available. |
| Host reports “address already in use” | Another DNS or web service may own port 53 or 443. Custom ports are useful for desktop testing; the console normally expects the defaults. |
| Unsupported firmware | Check the compatibility table. Forcing a chain does not add firmware support. |
| No output / Stalled | Read the last log lines and Details. Retry once; follow the upstream chain's reboot guidance if it remains stuck. |
| Cached app fails after updating | Run the installer again and wait for caching and installation to finish. |
| Payload Manager does not open | Check for an existing `autoload.txt`; it replaces the default behavior. |

## Development

The native installer is C, the console UI is framework-free JavaScript, and the PC host uses Python's standard library. UI changes must remain compatible with the PS5's older WebKit; keep controller code ES5-compatible.

```bash
git clone --recurse-submodules <your-private-repository-url>
cd piou-autoloader
make check
make icons
```

Desktop checks require Python 3.10+, Node.js 18+, a C compiler (`cc`), and GNU Make 4.3+. Icon generation uses `rsvg-convert` on Linux or QuickLook on macOS. macOS's default Make is too old for the grouped icon rule; use a current GNU Make.

Build the PS5 SDK image and installer:

```bash
docker build -f Dockerfile.sdk -t piou-autoloader-sdk .
docker run --rm -v "$PWD:/src" piou-autoloader-sdk make all host
```

Other entry points:

| Command | Purpose |
|---|---|
| `make check` | Host, generated-registry, native log, and UI regression tests |
| `make icons` | Generate PS5/Windows icons, favicons, and page logos from `assets/icon.svg` |
| `make dev` | Prepare dependencies and serve a local frontend preview |
| `make all` | Cross-compile `installer.elf` (SDK required) |
| `make host` | Embed the installer and frontend into the standalone Python host |
| `./build_release.sh` | Build versioned release artifacts |

`make dev` fetches and prepares third-party dependencies. For an isolated static preview, serve the frontend without running a chain. Desktop checks do not validate actual PS5 execution; firmware, AppCache, installation, and reboot behavior need console testing.

See [ARCHITECTURE.md](ARCHITECTURE.md) for internals and [AUDIT.md](AUDIT.md) for the audit findings, checks, and remaining limitations.

## Credits and license

PiouAutoLoader integrates work from the PS5 homebrew community:

- [idlesauce/umtx2](https://github.com/idlesauce/umtx2) — umtx2.
- [jordyidk/slopkit](https://github.com/jordyidk/slopkit) and [soniciso1/relapse](https://github.com/soniciso1/relapse) — Poops and lower-firmware support.
- [ntfargo/Relapse-Exploit](https://github.com/ntfargo/Relapse-Exploit) — Relapse.
- [ufm42/kexp](https://github.com/ufm42/kexp) — kernel payload work.
- [john-tornblom](https://github.com/john-tornblom) and [ps5-payload-dev](https://github.com/ps5-payload-dev) — SDK and ELF loader.
- [itsPLK](https://github.com/itsPLK) and contributors — pinned loader, unified autoloader, and Payload Manager dependencies.
- [madler/zlib](https://github.com/madler/zlib/tree/master/contrib/puff) — the vendored DEFLATE decompressor.

Licensed under [GPL-3.0](LICENSE). Third-party components retain their respective licenses. Provided as-is for research and development; use on hardware you own or are authorized to test.
