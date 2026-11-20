// Portage's bounded MSE appends, compiled into the pinned Shaka build.
// SPDX-License-Identifier: Apache-2.0
goog.provide('shaka.media.AppendBudget');
goog.require('shaka.util.BufferUtils');
goog.require('shaka.util.Error');
goog.require('shaka.util.Timer');

/** @final */
shaka.media.AppendBudget = class {
  /** @param {?HTMLMediaElement} video */
  constructor(video) {
    /** @private {?HTMLMediaElement} */
    this.video_ = video;
    /** @private {number} */
    this.generation_ = 0;
    /** @private {!Set<function()>} */
    this.waiters_ = new Set();
  }

  /** @return {number} */
  generation() { return this.generation_; }

  /** Wake quota waits immediately on seek, clear, reset or unload. */
  cancel() {
    this.generation_++;
    for (const wake of Array.from(this.waiters_)) { wake(); }
  }

  /** @param {number} generation */
  check(generation) {
    if (generation != this.generation_) {
      throw new shaka.util.Error(shaka.util.Error.Severity.RECOVERABLE,
          shaka.util.Error.Category.PLAYER,
          shaka.util.Error.Code.OPERATION_ABORTED);
    }
  }

  /**
   * Each piece completes through Shaka's real SourceBuffer operation queue.
   * Rejected pieces have not been consumed by MSE; retry only those bytes.
   * No synthetic updateend events, timestamp edits, eviction or codec changes.
   *
   * @param {!BufferSource} data
   * @param {function(!Uint8Array):!Promise} append
   * @param {number} generation
   * @return {!Promise}
   */
  async append(data, append, generation) {
    const bytes = shaka.util.BufferUtils.toUint8(data);
    let offset = 0;
    let size = 4 * 1024 * 1024;
    let stalled = 0;
    let reportedQuota = false;
    while (offset < bytes.byteLength) {
      this.check(generation);
      const end = Math.min(offset + size, bytes.byteLength);
      try {
        await append(bytes.subarray(offset, end));
        offset = end;
        stalled = 0;
      } catch (error) {
        this.check(generation);
        if (!this.video_ ||
            error.code != shaka.util.Error.Code.QUOTA_EXCEEDED_ERROR) {
          throw error;
        }
        if (!reportedQuota) {
          reportedQuota = true;
          this.video_.dispatchEvent(new CustomEvent('portagebufferpressure',
              {bubbles: true, composed: true}));
        }
        if (end - offset > 64 * 1024) {
          size = Math.max(64 * 1024, Math.floor((end - offset) / 2));
          continue;
        }
        const position = this.video_.currentTime;
        const paused = this.video_.paused;
        const began = Date.now();
        await this.wait_();
        this.check(generation);
        if (Math.abs(this.video_.currentTime - position) > 0.01) {
          stalled = 0;
        } else if (!paused && !this.video_.paused) {
          stalled += Date.now() - began;
        }
        if (stalled >= 15000) {
          // Retain this stream and its pending bytes. Pausing lets the user
          // choose a seek or explicit resume; never invoke Shaka's quota
          // adaptation or the sender's format-reload recovery.
          this.video_.pause();
          this.video_.dispatchEvent(new CustomEvent('portagebufferfull',
              {bubbles: true, composed: true}));
          stalled = 0;
        }
      }
    }
    this.check(generation);
  }

  /** @return {!Promise} @private */
  wait_() {
    return new Promise((resolve) => {
      const wake = () => {
        timer.stop();
        this.waiters_.delete(wake);
        resolve();
      };
      const timer = new shaka.util.Timer(wake).tickAfter(0.15);
      this.waiters_.add(wake);
    });
  }
};
