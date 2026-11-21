# Playback advice

`playback-health.js` observes the active media element once per second. It emits
one `notice` with code `playbackTrouble` per LOAD. This is separate from load
failure, recovery and codec support. It never controls playback or changes a
format, quality, source or track.

The sender offers a dismissible message and its existing playback settings:
“Video or audio not playing smoothly? Try adjusting quality settings.” Opening
or dismissing the sheet does not apply settings.

Signals:
- Video presentation below a quarter of the stream cadence while the media
  clock keeps advancing, sustained over at least ten seconds.
- More than 30% dropped video frames over the same window.
- Eight seconds without clock progress, or three interruptions totalling at
  least six seconds in a thirty-second window.

Presentation uses `requestVideoFrameCallback` when available, otherwise total
frames minus dropped frames. Missing counters stay unknown. Frame rate comes
from the selected encoder output or the player; otherwise it must first be
learned from sustained healthy playback. Low-frame-rate media does not use the
sparse-video rule. Future buffered gaps alone are not evidence of trouble.

Startup gets eight seconds after the clock first advances. Explicit seeks,
large clock jumps and counter resets discard old evidence; pauses, hidden pages,
idle and ended states do not accumulate it. Long seeks and delayed timers also
get a fresh grace period. Short automatic gap jumps can still contribute to
sustained trouble without being mistaken for user seeks.

These are symptoms, not a codec diagnosis. A receiver without usable video
counters may only expose stalls. Smooth counters cannot prove audible audio or
smooth physical display output. No device-family or codec exclusions are used.

Tests include a scrubbed counter trace from Portage's local H.264 + copied Opus
HLS/fMP4 output on a Cast receiver (2026-11-21). It has an advancing media clock,
sparse video frames and zero dropped frames. The real CAF browser test injects
sparse presentation telemetry into otherwise normal playback and checks that
only the advisory is sent: the URL, codecs and play intent remain unchanged.
