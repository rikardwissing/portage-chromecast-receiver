# Pinned Shaka build

CAF loads `shaka-player.portage.js` through its `shakaUrl` receiver option,
so its own library-ready promise completes before playback. This option is
implemented by CAF but is not listed in its public reference; the CAF startup
integration test checks that the framework loads and uses our player.
Do not preload Shaka with `skipShakaLoad`: CAF then waits forever for its loader,
even when `window.shaka` already exists. Upstream remains **4.16.45**,
commit `889d6b76de168e75bb306c5ad442d7a79ee09e68`.

The source patch adds bounded appends inside Shaka's MediaSourceEngine operation
queue. Each native `updateend` completes one slice. A rejected quota slice is
retried at a smaller size (4 MiB down to 64 KiB), then held until playback frees
capacity. Accepted bytes are never retried within an append. There are no fake
SourceBuffer events, timestamp changes, codec substitutions, quality reductions
or automatic stream reloads.

While an append waits for space, it asks StreamingEngine to reclaim already
played media through Shaka's existing removal queue. It keeps at least the
manifest's maximum segment duration behind the playhead to protect keyframe
dependencies. The usual eviction ran only before each complete segment, so a
pending partial append could otherwise wait forever with played data retained.

Seeking, clearing, resetting and destroying cancel pending appends. A cancelled
partial MP4 append aborts its native parser through the same operation queue
before Shaka retries or clears it. Quota pressure cancels the receiver's startup
fallback watchdog. If playing makes no progress for 15 seconds, the player sends
one notice and retains the stream. It preserves the user's play/pause intent,
so seeking out of the blocked range resumes normally without a pause/play toggle.
An ordinary user pause can retain the pending append indefinitely.

This helps large segments fit incrementally. It cannot make an undecodable
sample decodable or make a single unplayable GOP fit every device's memory.
The full compressed segment is still held by Shaka while it is appended; slices
are views into that data, avoiding another segment-sized allocation.

## Rebuild

Requirements: Git, Python 3, Node/npm and Java 21+ (Closure compiler).
Use a dedicated checkout; the script deliberately refuses unrelated edits.

```sh
git clone --depth 1 --branch v4.16.45 https://github.com/shaka-project/shaka-player.git /tmp/portage-shaka
npm ci --ignore-scripts --prefix vendor/shaka/build-tools
python3 scripts/build-shaka.py /tmp/portage-shaka vendor/shaka/build-tools
```

`bounded-append.patch` is the complete upstream diff. `append_budget.js` is the
additional source compiled with it. `build-tools/package-lock.json` pins the
small compiler dependency set, matching upstream's compiler and Closure library.
`build.json` records source and output hashes. The source map is omitted to avoid
shipping developer checkout paths. Both the patch/helper and Shaka are Apache-2.0;
see `LICENSE` and the notices retained in the compiled bundle.

## Tests

```sh
npm ci
npm test
npm run test:browser
```

The browser test requires installed Chrome and ffmpeg (`CHROME` and `FFMPEG` can
set their executable paths). It generates H.264/AAC media with large GOPs, limits
Chrome's video SourceBuffer to 30 MB, and exercises actual quota failures,
pause/resume, four forward/backward seeks, and unload/reload while an append is
waiting. It checks frame progress, A/V buffered coverage, unchanged codecs,
resolution, bandwidth and MediaSource URL. Temporary generated media is removed.
The Node tests cover exact byte preservation, partial views, genuine errors,
paused quota waits, cancellation and the receiver's no-fallback message path.

`caf-startup.browser.js` also loads the actual Google Cast framework and the
receiver page, sends LOAD while the pinned player is still downloading, and
checks decoded frames on both that load and a repeat load. It fetches the current
CAF SDK, or reads `CAF_SCRIPT` when set to a saved SDK file. This catches loader
integration failures that direct Shaka tests cannot detect.

`quota-eviction.browser.js` models a renderer that needs explicit removal of
played data before accepting more bytes. It verifies actual MSE removal and
frame progress, then forces an unrecoverable quota wait and checks that a seek
recovers without an extra play command. An intentional user pause stays paused.

A separate local replay of the original Moomin segments reproduced stock
4.16.45 failing at 65.38 seconds with MEDIA.QUOTA_EXCEEDED_ERROR (3017). This build
advanced beyond 109 seconds with 1,661 decoded frames using the same H.264 bytes.
That replay was video-only: desktop Chrome does not expose the TV's AC-3 decoder.
Neither this test nor the synthetic AAC test substitutes for TV validation.
