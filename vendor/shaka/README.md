# Pinned Shaka build

CAF loads `shaka-player.portage.js` from this receiver before startup, using the
public `CastReceiverOptions.skipShakaLoad` option. Upstream remains **4.16.45**,
commit `889d6b76de168e75bb306c5ad442d7a79ee09e68`.

The source patch adds bounded appends inside Shaka's MediaSourceEngine operation
queue. Each native `updateend` completes one slice. A rejected quota slice is
retried at a smaller size (4 MiB down to 64 KiB), then held until playback frees
capacity. Accepted bytes are never retried within an append. There are no fake
SourceBuffer events, timestamp changes, codec substitutions, quality reductions,
manual buffer eviction or automatic stream reloads.

Seeking, clearing, resetting and destroying cancel pending appends. A cancelled
partial MP4 append aborts its native parser through the same operation queue
before Shaka retries or clears it. Quota pressure cancels the receiver's startup
fallback watchdog. If playing makes no progress for 15 seconds, the player pauses
and sends a notice; it retains the current stream for an explicit resume or seek.
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

A separate local replay of the original Moomin segments reproduced stock
4.16.45 failing at 65.38 seconds with MEDIA.QUOTA_EXCEEDED_ERROR (3017). This build
advanced beyond 109 seconds with 1,661 decoded frames using the same H.264 bytes.
That replay was video-only: desktop Chrome does not expose the TV's AC-3 decoder.
Neither this test nor the synthetic AAC test substitutes for TV validation.
