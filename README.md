<p align="center">
 <img src="./assets/icon.svg" width="128" alt="PiouAutoLoader" />
</p>
<h1 align="center">PiouAutoLoader</h1>
&nbsp;
<p align="center">Automatically loads a WebKit exploit and your ELF payloads on the PS5.<br>Supports firmwares <b>1.00&ndash;5.50</b> and <b>7.00&ndash;13.60</b>.</p>

---

## What is this?

PiouAutoLoader turns "run a WebKit exploit" into a single homescreen shortcut. After a one-time install, the exploit page is cached on the console itself, so nothing depends on a third-party website or DNS server staying online.

- **Fully offline on FW 1.00&ndash;12.00** with the **Poops** chain: everything is served from the console once installed, so there is no third-party server to go down or change behind your back. Firmwares **7.00&ndash;13.60** can instead run **Relapse**, which needs an active network interface (Wi-Fi or Ethernet).
- **One-time setup, then a homescreen shortcut.** Launch **PiouAutoLoader** from the homescreen and it does the rest &mdash; no PC required afterwards.
- **Payloads load the usual way.** After the exploit chain runs, payloads are sent through the standard unified-autoloader flow: **Payload Manager** by default, or a fixed `autoload.txt` chain.
- **Designed to be readable and resilient.** A staged progress tracker, a live mirror of the exploit's own log, a stall watchdog, and a tolerant native log pipeline. See [Quality of life](#quality-of-life).

## Setup

There are two ways to get started, depending on whether you are already jailbroken.

### Already jailbroken &mdash; load the installer ELF

1. Download `piou-autoloader-installer_vX.Y.Z.elf` from the Releases page.
2. Send it with `elfldr`, or launch it from Payload Manager.
3. The installer opens the browser once to cache the autoloader, then creates the **PiouAutoLoader** homescreen app and exits.
4. **Reboot once**, then launch **PiouAutoLoader** from the homescreen.

### Not jailbroken yet &mdash; host the exploit from a PC

1. Download `piou-autoloader-host.py` (or the `.exe`) and run it on a PC on the same network.
2. On the PS5, set your network's DNS server to the PC's IP address.
3. Open the **User's Guide** from Settings to run the installer, which adds the **PiouAutoLoader** app to the homescreen.
4. Launch **PiouAutoLoader** from the homescreen.

> Set your DNS back to automatic once the install is done.

## How to use

There are two ways to configure payloads.

### Option 1 &mdash; Payload Manager (default)

If no `autoload.txt` config is found, the autoloader launches **Payload Manager**, a web-UI payload manager, so you can configure and send payloads from your browser without preparing files ahead of time. Just run the autoloader &mdash; if nothing is configured, Payload Manager starts automatically.

> Payload Manager also has its own built-in autoload feature, managed through its web UI. That is separate from the `autoload.txt` mechanism below.

### Option 2 &mdash; Manual config (`autoload.txt`)

For a fixed, automated payload chain:

- Create a directory named `ps5_autoloader`.
- Inside it, place your `.elf` / `.bin` files and an `autoload.txt`.
  - List the files to load, one filename per line (case-sensitive).
  - Add lines like `!1000` to wait 1000 ms before sending the next payload.
- Put the `ps5_autoloader` directory in one of these locations (highest priority first):
  - Root of a USB drive
  - Internal drive: `/data/ps5_autoloader`

> When an `autoload.txt` config is found, Payload Manager is **not** launched automatically. To keep it available, add `pldmgr.elf` to your `ps5_autoloader` directory and list it in `autoload.txt`.

## Quality of life

This build focuses on making the run easier to follow and harder to wedge:

- **Staged progress tracker** &mdash; five checkpoints (Boot &rarr; WebKit &rarr; Kernel &rarr; elfldr &rarr; Payload) light up as the chain advances, driven by the exploit's own output.
- **Live log mirror** &mdash; the chain's internal log is streamed into the page, classified by severity instead of hidden inside a hidden iframe.
- **Stall watchdog + Retry** &mdash; if nothing progresses for two minutes the UI says so and offers a one-click clean retry (which also clears the slopkit latch, so a retry never no-ops).
- **Animated, lightweight UI** &mdash; transform/opacity-only animations, no frameworks, ES5 JavaScript for the console's older WebKit.
- **Native log ring buffer** &mdash; the on-console log no longer dead-ends when it fills up, so long installs keep streaming and waiters never block forever.
- **Thread-safe exploit selection** &mdash; the session's chosen exploit is guarded by a mutex across the HTTP server's connection threads.

## Additional info

<details>
<summary><i>How do I update the autoloader?</i></summary>

The autoloader content is cached on the console, so updating is the same as the initial install: follow the [Setup](#setup) steps with the new release files. The latest installer re-creates the homescreen app and refreshes the cached page. Your payloads and `autoload.txt` on USB / internal storage are never touched.

</details>

<details>
<summary><i>How do I use a custom ELF loader?</i></summary>

On firmwares 7.00&ndash;13.60 (Relapse / Poops), the autoloader boots a custom **elfldr** that only accepts connections from localhost, so other devices on your network cannot push payloads to the console. On firmwares 1.00&ndash;5.50 (umtx2) the stock elfldr is used.

To use a normal ELF loader, load it through **Payload Manager**. With a manual `autoload.txt`:

1. Place your custom loader (e.g. `elfldr.elf`) in `ps5_autoloader`.
2. Add `elfldr.elf` to `autoload.txt`.
3. If other payloads follow it, add a sleep immediately after (e.g. `!4000`) so the new loader is listening before they are sent.

```text
# Load custom ELF loader
elfldr.elf
# Give it 4 seconds to start up (only needed if more payloads follow)
!4000
# Send other payloads
etaHEN.elf
```

</details>

## For developers

Technical internals live in **[ARCHITECTURE.md](ARCHITECTURE.md)**.

Common Make targets (the native ELF is cross-built with the PS5 payload SDK, usually inside Docker):

```bash
make dev        # rebuild + serve the frontend locally for UI work
make icons      # regenerate icon0.png / icon.ico / favicons / logos from assets/icon.svg
make all        # build installer.elf
make host       # build piou-autoloader-host.py with the frontend embedded
```

`./build_release.sh` builds the versioned release artifacts in one step.

## Third-party components

PiouAutoLoader is a front-end and installer around exploit chains and loaders maintained by others. These are pinned as submodules / downloaded at build time and are **not** modified beyond small integration patches:

- **[idlesauce/umtx2](https://github.com/idlesauce/umtx2)** &mdash; umtx2 exploit chain (FW 1.00&ndash;5.50).
- **[slopkit](https://github.com/jordyidk/slopkit)** &mdash; Poops chain (FW 7.00&ndash;12.00).
- **[ntfargo/Relapse-Exploit](https://github.com/ntfargo/Relapse-Exploit)** &mdash; Relapse chain (FW 7.00&ndash;13.60).
- **[ps5-payload-dev/sdk](https://github.com/ps5-payload-dev/sdk)** and **[elfldr](https://github.com/ps5-payload-dev/elfldr)** &mdash; the payload SDK and ELF loader.
- **`ps5-elfldr`, `ps5-kexp`, `ps5-unified-autoloader`** (pinned submodules) &mdash; the localhost-only loader and the unified payload autoloader embedded into the installer.
- **[madler/zlib `puff`](https://github.com/madler/zlib/tree/master/contrib/puff)** &mdash; vendored DEFLATE decompressor.

## Credits

* **[idlesauce](https://github.com/idlesauce)** &amp; contributors &mdash; [umtx2](https://github.com/idlesauce/umtx2)
* **[jordyidk](https://github.com/jordyidk)** &amp; contributors &mdash; [slopkit (Poops)](https://github.com/jordyidk/slopkit)
* **[soniciso1](https://github.com/soniciso1)** &mdash; [Relapse](https://github.com/soniciso1/relapse), bringing Poops support down to lower firmwares (7.00&ndash;8.60)
* **[ntfargo](https://github.com/ntfargo)** &amp; contributors &mdash; [Relapse](https://github.com/ntfargo/Relapse-Exploit)
* **[ufm42](https://github.com/ufm42)** &mdash; [kexp](https://github.com/ufm42/kexp)
* **[john-tornblom](https://github.com/john-tornblom)** &mdash; [ps5-payload-sdk](https://github.com/ps5-payload-dev/sdk/) and [elfldr](https://github.com/ps5-payload-dev/elfldr)
* **[madler](https://github.com/madler)** &mdash; [puff](https://github.com/madler/zlib/tree/master/contrib/puff)
* Everyone else contributing to the PS5 homebrew scene.

## Disclaimer

This tool is provided as-is for research and development purposes only. Use at your own risk. The developers are not responsible for any damage, data loss, or consequences resulting from the use of this software.

## License

GPL-3.0. See [LICENSE](LICENSE).
