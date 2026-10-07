# Stability and performance audit

This review covers the first-party PC host, native installer, file-registry generator, autoloader UI, build rules, and documentation. Existing uncommitted UI and installer changes were preserved and included in the review. Upstream exploit chains were initialized at their pinned revisions and built with the existing integration patches; their exploit primitives were not audited or changed.

## Findings addressed

| Area | Observed defect | Change / verification |
|---|---|---|
| Host startup | With `GITHUB_REPO` empty, the checker creates no thread, but startup calls `None.join()` | Guard the join; startup regression exercises the default configuration |
| Host lifecycle | HTTPS setup failures return after DNS/HTTP have started, without closing them | ExitStack owns server shutdown and socket closure; regression verifies failed HTTPS setup closes both listeners |
| HTTPS availability | TLS negotiation in the accept loop lets one silent TCP peer prevent other clients from connecting | Defer negotiation to the request worker and set a ten-second socket timeout; a real TLS test keeps one silent peer connected while another request succeeds |
| Archive lookup | Every resource request builds and scans the ZIP's entire filename list | Use ZipFile's indexed `getinfo`; test rejects calls to `namelist` during requests |
| Native registry | Every resource lookup linearly scans the sorted table | Binary search; generated C is compiled and every entry plus missing keys is checked |
| Filesystem serving | Separate existence/read/stat operations race; symlinks can point outside the document root | Resolve containment, read from one open descriptor, use fstat, handle filesystem errors; HTTP regression checks symlink escape and override precedence |
| DNS | A records returned for AAAA and other question types; malformed question encodings accepted | Return NOERROR/no-data for unsupported types on the target, preserve NXDOMAIN elsewhere, validate question count and label encodings; parser/response regressions |
| DNS resources | A new thread is created for every trivial UDP query | Serve the small synchronous DNS operation in a single UDP server loop |
| Temporary files | Certificate generation leaves its temporary directory behind | TemporaryDirectory scopes generation and TLS loading |
| Shared archive | Lazy initialization can expose a partially initialized cache to another thread | Lock archive initialization |
| Native listener | Documentation claimed localhost binding, but MHD had no bind address | Explicit loopback binding, 15-second connection timeout, 32-connection limit; cross-compiled successfully |
| Process enumeration | Zero/truncated record lengths can loop forever or read beyond the sysctl buffer | Validate record size, copy fields without alignment assumptions, bound process-name reads; cross-compiled successfully |
| Native logs | A client cursor from an older process can wait until the new stream catches up | Reset future cursors to the oldest available data; native ring-wrap and stale-cursor regression |
| Native logs | Oversized internal append branch counts retained bytes instead of original input length | Count original bytes before retaining the tail; ordinary logging currently uses smaller chunks |
| Installer writes | A successful fwrite followed by a failed fclose reports success | Propagate close/flush errors; cross-compiled successfully |
| UI terminal states | Fatal errors do not set the terminal flag; Details keeps recalculating elapsed time | Central terminal-state/timestamp handling; VM tests check frozen time and persistent failure |
| UI log bursts | A large existing iframe log creates thousands of nodes that the 200-line cap immediately deletes | Process only the retained tail and access direct children; regression uses a 5,000-line burst |
| Message handling | A missing iframe source bypasses the existing sender check | Require the armed iframe's window; reject unrelated senders in regression test |
| Parallel builds | Six icon outputs each trigger the same generator under parallel make | GNU Make grouped target; `make -j8 icons` generated the set once |
| Documentation | Offline support described firmware gaps and lower firmwares as Poops; host serving priority was inaccurate | Explicit compatibility table, installation confirmation distinction, accurate archive precedence |

## N+1 / repeated work

There is no database, ORM, or database N+1 query in this application. The matching performance issue is repeated whole-collection lookup while serving N cached resources. ZIP membership now uses its existing hash index (average O(1) lookup), and the native sorted registry uses O(log N) lookup instead of O(N). Across N requests this removes the O(N²) lookup pattern. These are algorithmic changes, not measured PS5 latency claims; network transfer and decompression still have their own costs.

## Validation

- `make check`: 13 Python tests (including compiled native harnesses and real HTTP/TLS requests) and three Node UI tests passed.
- `make -j8 icons`: generated the PS5 PNG, Windows ICO, and both pages' favicons/logos; visually inspected the 512-pixel icon.
- `docker build -f Dockerfile.sdk -t piou-autoloader-sdk .`: SDK and libmicrohttpd image built successfully.
- Docker `make all host`: native PS5 ELF compiled and stripped, 160-file native registry generated, 155-file standalone host archive built. Downloaded payloads passed the existing SHA-256 checks.
- Python and JavaScript syntax checks and `git diff --check` were run during the review.
- GitHub Actions now runs the desktop regression suite on pushes and pull requests.

## Limits and follow-up risks

No PS5 was connected for this audit. Actual exploit success, firmware-specific behavior, cached/offline startup, homescreen installation, and reboot recovery remain unverified on hardware. Windows executable packaging and runtime were not exercised.

The HTTP host still uses a thread per connection, with a timeout; it is intended for a trusted local setup network, not internet exposure. Native state-changing routes retain the existing GET/CORS protocol. Loopback binding reduces network exposure but does not authenticate local callers. Concurrent installation/cache-clear requests and allocation-failure branches in the native HTTP handler warrant additional targeted testing.

The UI still has a synchronous cached selection lookup and polling-based log mirroring. These need hardware-informed changes to avoid breaking older WebKit and AppCache behavior. The SDK Dockerfile follows upstream SDK HEAD, so build reproducibility is not fully pinned.

Pelloux's execution principles were applied through concrete findings, focused edits, regression checks, and a complete build. This is not full compliance with the structural size limits: existing large files such as `host.py`, `app.js`, and `http_server.c` remain over those thresholds. A larger module split was not mixed into this stability pass. No claim of perfection or complete security coverage is made.
