(function () {
  'use strict';
  var ns = 'urn:x-cast:dev.rikard.portage';
  var running = false;
  window.PortageSubtitleBenchmark = function (context, event) {
    if (!event.data || event.data.type !== 'scope0Overlay' || running) return;
    var video = document.querySelector('video');
    var shell = document.querySelector('cast-media-player');
    if (!video && shell && shell.shadowRoot) video = shell.shadowRoot.querySelector('video');
    if (!video) { context.sendCustomMessage(ns, event.senderId, {type:'scope0Result', error:'No video element'}); return; }
    var imageURL = String(event.data.imageURL || '');
    if (!/^https?:\/\//.test(imageURL)) return;
    running = true;
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:15%;bottom:12%;width:70%;height:15%;z-index:10000;pointer-events:none';
    document.body.appendChild(box);
    var rates = [0, 1, 4, 10];
    var results = [];
    var phase = 0;
    function quality() {
      var q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : {};
      return {total:q.totalVideoFrames || video.webkitDecodedFrameCount || 0,
        dropped:q.droppedVideoFrames || video.webkitDroppedFrameCount || 0};
    }
    function step() {
      var rate = rates[phase];
      var before = quality();
      var startTime = video.currentTime;
      var paints = 0;
      var requested = 0;
      var failed = 0;
      var latest = 0;
      var stopped = false;
      var displayed = null;
      var timer = rate ? setInterval(function () {
        var sequence = ++requested;
        fetch(imageURL + (imageURL.indexOf('?') < 0 ? '?' : '&') + 'phase=' + phase + '&frame=' + sequence)
          .then(function (r) { if (!r.ok) throw new Error(r.status); return r.blob(); })
          .then(function (blob) {
            var url = URL.createObjectURL(blob);
            var img = new Image();
            img.style.cssText = 'width:100%;height:100%;object-fit:contain';
            img.onload = function () {
              if (stopped || sequence < latest) { URL.revokeObjectURL(url); return; }
              latest = sequence;
              while (box.firstChild) box.removeChild(box.firstChild);
              box.appendChild(img);
              if (displayed) URL.revokeObjectURL(displayed);
              displayed = url;
              paints++;
            };
            img.onerror = function () { failed++; URL.revokeObjectURL(url); };
            img.src = url;
          }).catch(function () { failed++; });
      }, 1000 / rate) : null;
      setTimeout(function () {
        stopped = true;
        if (timer) clearInterval(timer);
        if (displayed) URL.revokeObjectURL(displayed);
        var after = quality();
        results.push({rate:rate, requested:requested, painted:paints, failed:failed, elapsedMedia:video.currentTime-startTime,
          decoded:after.total-before.total, dropped:after.dropped-before.dropped,
          videoWidth:video.videoWidth, videoHeight:video.videoHeight});
        phase++;
        if (phase < rates.length) step();
        else {
          box.remove(); running = false;
          context.sendCustomMessage(ns, event.senderId, {type:'scope0Result', results:results,
            limitation:'Repeated synthetic static PNG transferred and decoded per frame; excludes phone rendering cost.'});
        }
      }, 4000);
    }
    step();
  };
})();
