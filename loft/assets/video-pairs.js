(() => {
  const root = document.querySelector(".video-pairs");
  const input = document.querySelector("#pair-input");
  const point = document.querySelector("#pair-point");
  const videos = [input, point];
  const play = document.querySelector("#pair-play");
  const seek = document.querySelector("#pair-seek");
  const clock = document.querySelector("#pair-time");
  const navigation = root.querySelector(".pair-navigation");
  const previous = document.querySelector("#pair-prev");
  const next = document.querySelector("#pair-next");
  const name = document.querySelector("#pair-name");
  const status = document.querySelector("#pair-status");
  const fullscreen = document.querySelector("#pair-fullscreen");
  const pairs = window.loftVideoPairs || [];
  let currentIndex = 0;
  let playing = false;
  let revision = 0;
  let failed = false;

  function message(text) {
    status.textContent = text;
    status.hidden = !text;
  }

  function duration() {
    const length = Math.min(input.duration, point.duration);
    return Number.isFinite(length) ? length : 0;
  }

  function timestamp(seconds) {
    return Math.floor(seconds / 60) + ":" + String(Math.floor(seconds % 60)).padStart(2, "0");
  }

  function updateTime() {
    const length = duration();
    const current = Math.min(input.currentTime, length);
    seek.max = length;
    seek.value = current;
    seek.disabled = failed || !length;
    clock.textContent = timestamp(current) + " / " + timestamp(length);
    seek.setAttribute("aria-valuetext", clock.textContent);
  }

  function pause() {
    playing = false;
    revision++;
    videos.forEach(video => video.pause());
    play.textContent = "Play";
  }

  function setTime(seconds) {
    for (const video of videos) {
      if (video.readyState >= HTMLMediaElement.HAVE_METADATA) video.currentTime = seconds;
    }
    updateTime();
  }

  function playbackError() {
    pause();
    failed = true;
    seek.disabled = true;
    play.textContent = "Retry";
    message("The video pair could not be played. Retry to reload both videos.");
  }

  function playBoth() {
    const request = revision;
    for (const video of videos) {
      if (!video.paused) continue;
      video.play().catch(error => {
        if (request === revision && playing && error.name !== "AbortError") playbackError();
      });
    }
  }

  function choose(index) {
    pause();
    failed = false;
    const pair = pairs[index];
    videos.forEach((video, i) => {
      const key = i === 0 ? "input" : "point";
      if (pair[key + "Poster"]) video.poster = pair[key + "Poster"];
      else video.removeAttribute("poster");
      video.src = pair[key];
      video.load();
    });
    currentIndex = index;
    name.textContent = pair.name;
    play.disabled = false;
    message("");
    updateTime();
  }

  function finish() {
    if (!playing) return;
    pause();
    setTime(duration());
  }

  for (const video of videos) {
    video.addEventListener("durationchange", updateTime);
    video.addEventListener("loadedmetadata", updateTime);
    video.addEventListener("ended", finish);
    video.addEventListener("error", () => { if (video.error) playbackError(); });
    video.addEventListener("waiting", () => {
      if (playing && video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
        videos.find(other => other !== video).pause();
      }
    });
    video.addEventListener("canplay", () => {
      if (playing && videos.every(v => v.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA)) {
        playBoth();
      }
    });
  }

  input.addEventListener("timeupdate", () => {
    updateTime();
    if (!playing || !duration()) return;
    if (input.currentTime >= duration()) { finish(); return; }
    if (!input.paused && !point.paused && !input.seeking && !point.seeking &&
        Math.abs(input.currentTime - point.currentTime) > 0.12) {
      point.currentTime = input.currentTime;
    }
  });

  play.addEventListener("click", () => {
    if (failed) choose(currentIndex);
    if (playing) { pause(); return; }
    if (duration() && input.currentTime >= duration() - 0.03) setTime(0);
    playing = true;
    play.textContent = "Pause";
    playBoth();
  });
  seek.addEventListener("input", () => setTime(Number(seek.value)));
  function step(direction) {
    choose((currentIndex + direction + pairs.length) % pairs.length);
  }
  previous.addEventListener("click", () => step(-1));
  next.addEventListener("click", () => step(1));
  root.addEventListener("keydown", event => {
    if (pairs.length < 2 || event.target === seek || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    if (!event.repeat) step(event.key === "ArrowLeft" ? -1 : 1);
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden && playing) pause(); });

  if (document.fullscreenEnabled && root.requestFullscreen) {
    fullscreen.hidden = false;
    fullscreen.addEventListener("click", async () => {
      try {
        if (document.fullscreenElement === root) await document.exitFullscreen();
        else await root.requestFullscreen();
      } catch {
        message("Full screen is unavailable in this browser.");
      }
    });
    document.addEventListener("fullscreenchange", () => {
      fullscreen.title = document.fullscreenElement === root ? "Exit full screen" : "Full screen";
      fullscreen.setAttribute("aria-label", fullscreen.title);
    });
  }

  navigation.hidden = pairs.length === 0;
  previous.hidden = next.hidden = pairs.length < 2;
  if (pairs.length) choose(0);
  else message("Video pairs are coming soon.");
})();
