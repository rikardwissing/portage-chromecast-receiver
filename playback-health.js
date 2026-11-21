// Advisory only: this observer never controls playback or selects a format.
(function (root) {
  'use strict';
  class Monitor {
    constructor() { this.reset(); }
    reset() {
      this.reported = false;
      this.started = false;
      this.previous = null;
      this.until = 0;
      this.window = [];
      this.baseline = 0;
    }
    suspend(now, seconds = 8) {
      this.previous = null;
      this.window = [];
      this.until = now + seconds;
    }
    sample(s) {
      if (this.reported) return null;
      const active = s.state === 'PLAYING' || s.state === 'BUFFERING';
      if (!active || s.paused || s.ended || s.hidden || !Number.isFinite(s.position)) {
        this.suspend(s.at, 3);
        return null;
      }
      // A brief automatic gap jump can be included in the next interval.
      // A long seek discards evidence and gets grace after it settles.
      if (s.seeking) {
        if (!this.previous || s.at - this.previous.at > 4) this.suspend(s.at);
        return null;
      }
      const p = this.previous;
      this.previous = s;
      if (!p) return null;
      const dt = s.at - p.at, advance = s.position - p.position;
      const rate = s.rate > 0 ? s.rate : 1;
      // A delayed timer/counter reset or an unannounced seek is not a stall.
      if (dt < 0.4 || dt > 4 || advance < -0.25 || advance > dt * rate + 2) {
        this.suspend(s.at);
        return null;
      }
      if (!this.started) {
        if (advance > 0.1 && !s.seeking) {
          this.started = true;
          this.until = s.at + 8;
        }
        return null;
      }
      if (s.at < this.until) return null;
      const frames = Number.isFinite(s.frames) && Number.isFinite(p.frames) ? s.frames - p.frames : null;
      if (frames !== null && frames < 0) { this.suspend(s.at); return null; }
      const dropped = Number.isFinite(s.dropped) && Number.isFinite(p.dropped) ? s.dropped - p.dropped : 0;
      if (dropped < 0) { this.suspend(s.at); return null; }
      const stalled = advance < dt * rate * 0.15;
      this.window.push({at: s.at, dt, advance, frames, dropped, stalled});
      this.window = this.window.filter(v => s.at - v.at < 30);
      // Learn normal cadence only from sustained moving video. A reported
      // stream frame rate takes precedence, including deliberately low fps.
      const recent = this.window.filter(v => s.at - v.at < 4);
      const movingTime = recent.reduce((n, v) => n + v.advance, 0);
      if (recent.length >= 4 && movingTime > 3 && recent.every(v => v.frames !== null && !v.stalled)) {
        const fps = Math.min(...recent.map(v => v.frames / Math.max(v.advance, 0.01)));
        if (fps >= 8) this.baseline = Math.max(this.baseline, fps);
      }
      const expected = Number.isFinite(s.expectedFPS) && s.expectedFPS > 0 ? s.expectedFPS : this.baseline;
      const last = this.window.filter(v => s.at - v.at < 12);
      const seconds = last.reduce((n, v) => n + v.dt, 0);
      let reason = null;
      if (seconds >= 10 && last.every(v => v.frames !== null)) {
        const progress = last.reduce((n, v) => n + v.advance, 0);
        const shown = last.reduce((n, v) => n + v.frames, 0);
        const lost = last.reduce((n, v) => n + v.dropped, 0);
        if (progress >= seconds * rate * 0.7 && expected >= 8 && shown / progress < expected * 0.25) reason = 'sparseVideo';
        else if (shown + lost >= 60 && lost / (shown + lost) > 0.3) reason = 'droppedVideo';
      }
      let continuous = 0, total = 0, episodes = 0, inStall = false;
      for (const v of this.window) {
        if (v.stalled) {
          continuous += v.dt; total += v.dt;
          if (!inStall) episodes++;
        } else continuous = 0;
        inStall = v.stalled;
      }
      if (continuous >= 8) reason = 'stalled';
      else if (episodes >= 3 && total >= 6) reason = 'repeatedStalls';
      if (reason) this.reported = true;
      return reason;
    }
  }

  class Observer {
    constructor({video, state, notify, expectedFPS = () => null, now = () => performance.now() / 1000}) {
      this.video = video; this.state = state; this.notify = notify;
      this.expectedFPS = expectedFPS; this.now = now;
      this.monitor = new Monitor();
      this.element = null; this.callback = null; this.presented = null; this.generation = 0;
    }
    reset() { this.detach(); this.monitor.reset(); }
    seek() { this.monitor.suspend(this.now()); }
    detach() {
      this.generation++;
      if (this.element && this.callback !== null && this.element.cancelVideoFrameCallback) this.element.cancelVideoFrameCallback(this.callback);
      this.element = null; this.callback = null; this.presented = null;
    }
    tick() {
      const video = this.video();
      if (video !== this.element) {
        this.detach(); this.element = video; this.monitor.suspend(this.now());
        if (video && video.requestVideoFrameCallback) {
          const generation = this.generation;
          const frame = (_, metadata) => {
            if (this.element !== video || this.generation !== generation) return;
            this.presented = metadata.presentedFrames;
            this.callback = video.requestVideoFrameCallback(frame);
          };
          this.callback = video.requestVideoFrameCallback(frame);
        }
      }
      if (!video) return;
      const quality = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
      const total = quality ? quality.totalVideoFrames : video.webkitDecodedFrameCount;
      const dropped = quality ? quality.droppedVideoFrames : video.webkitDroppedFrameCount;
      // Presentation callbacks catch video stuck behind advancing audio even
      // when the decoder reports zero dropped frames. Older platforms use
      // total minus dropped; unsupported counters remain unknown, never zero.
      const frames = video.videoWidth > 0 ? (video.requestVideoFrameCallback ? this.presented :
        (Number.isFinite(total) && Number.isFinite(dropped) ? total - dropped : null)) : null;
      const reason = this.monitor.sample({at: this.now(), position: video.currentTime, state: this.state(),
        paused: video.paused, ended: video.ended, seeking: video.seeking,
        hidden: typeof document !== 'undefined' && document.hidden, rate: video.playbackRate,
        frames, dropped, expectedFPS: this.expectedFPS()});
      if (reason) this.notify(reason);
    }
  }
  const api = {Monitor, Observer};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PortagePlaybackHealth = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
