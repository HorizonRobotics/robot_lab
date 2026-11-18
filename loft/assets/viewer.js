(() => {
  const rendererUrl = new URL('point-cloud.js', document.currentScript.src);
  const svg = (paths, size = 18) => '<svg width="' + size + '" height="' + size +
    '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  const cube = svg('<path d="m12 2 9 5v10l-9 5-9-5V7l9-5Z M3 7l9 5 9-5 M12 12v10"/>', 34);
  const playIcon = svg('<path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none"/>');
  const pauseIcon = svg('<path d="M8 5v14M16 5v14" stroke-width="4"/>');
  const resetIcon = svg('<path d="M3 10a9 9 0 1 1 1.9 8.1 M3 4v6h6"/>');
  const expandIcon = svg('<path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5"/>');

  function mount(root) {
    root.innerHTML = `
      <div class="lv-stage">
        <div class="lv-top">
          <span class="lv-title"><span class="lv-dot"></span>Point cloud viewer</span>
          <select class="lv-scenes" aria-label="Point cloud scene" hidden></select>
          <span class="lv-scene" hidden></span>
        </div>
        <canvas class="lv-canvas" tabindex="0" aria-label="3D point cloud. Use arrow keys to rotate, plus or minus to zoom, and R to reset." hidden></canvas>
        <div class="lv-placeholder" role="status">
          <div class="lv-symbol">${cube}</div>
          <span class="lv-message">Demo coming soon</span>
          <button class="lv-retry" type="button" hidden>Try again</button>
        </div>
        <span class="lv-hint" hidden>Drag to orbit · Scroll or pinch to zoom</span>
      </div>
      <div class="lv-transport" role="group" aria-label="Point cloud playback">
        <button class="lv-play" type="button" title="Play sequence" aria-label="Play sequence" disabled>${playIcon}</button>
        <input class="lv-timeline" type="range" min="0" max="1" step="1" value="0" aria-label="Frame" disabled>
        <span class="lv-counter" aria-label="Frame count">— / —</span>
        <span class="lv-separator" aria-hidden="true"></span>
        <button class="lv-reset" type="button" title="Reset view" aria-label="Reset view" disabled>${resetIcon}</button>
        <button class="lv-expand" type="button" title="Full screen" aria-label="Full screen" disabled>${expandIcon}</button>
      </div>`;
    const get = name => root.querySelector('.lv-' + name);
    const canvas = get('canvas'), timeline = get('timeline'), play = get('play'), expand = get('expand');
    const scenesControl = get('scenes'), sceneLabel = get('scene'), retry = get('retry');
    const manifest = new URL(root.dataset.manifest || 'data/demos/manifest.json', document.baseURI);
    let sequences = [], scene, renderer, parsePly, retryAction;
    let generation = 0, index = 0, fit = true, timer, playing = false;
    const cache = new Map();
    if (!root.requestFullscreen || !document.fullscreenEnabled) expand.hidden = true;

    function status(text, action) {
      get('placeholder').hidden = !text;
      get('message').textContent = text || '';
      retry.hidden = !action;
      retryAction = action;
    }
    function setPlaying(value) {
      playing = value;
      clearTimeout(timer);
      play.innerHTML = value ? pauseIcon : playIcon;
      play.title = value ? 'Pause sequence' : 'Play sequence';
      play.setAttribute('aria-label', play.title);
    }
    function discard(key) {
      cache.get(key).controller.abort();
      cache.delete(key);
    }
    function readFrame(i) {
      if (cache.has(i)) return cache.get(i).promise;
      const controller = new AbortController();
      const url = new URL(scene.frames[i], manifest);
      const promise = fetch(url, {signal: controller.signal}).then(async response => {
        if (!response.ok) throw Error('Frame file unavailable.');
        return parsePly(await response.arrayBuffer());
      });
      cache.set(i, {promise, controller});
      return promise;
    }
    async function show(i) {
      clearTimeout(timer);
      const id = ++generation;
      const next = (i + 1) % scene.frames.length;
      for (const key of cache.keys()) if (key !== i && key !== next) discard(key);
      index = i;
      timeline.value = String(i);
      timeline.setAttribute('aria-valuetext', 'Frame ' + (i + 1) + ' of ' + scene.frames.length);
      try {
        const frame = await readFrame(i);
        if (id !== generation) return;
        status('');
        canvas.hidden = false;
        renderer.show(frame, fit);
        fit = false;
        get('hint').hidden = false;
        get('reset').disabled = false;
        expand.disabled = false;
        get('counter').textContent = (i + 1) + ' / ' + scene.frames.length;
        if (scene.frames.length > 1) readFrame(next).catch(() => {});
        if (playing) schedule();
      } catch (error) {
        if (id !== generation) return;
        discard(i);
        setPlaying(false);
        canvas.hidden = true;
        get('hint').hidden = true;
        get('counter').textContent = '— / ' + scene.frames.length;
        get('reset').disabled = true;
        status('Frame ' + (i + 1) + ' could not be loaded.', () => show(i));
      }
    }
    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(() => show((index + 1) % scene.frames.length), 1000 / scene.fps);
    }
    function selectScene(n) {
      setPlaying(false);
      ++generation;
      for (const key of cache.keys()) discard(key);
      scene = sequences[n];
      fit = true;
      status('Loading point cloud…');
      canvas.hidden = true;
      get('hint').hidden = true;
      get('reset').disabled = expand.disabled = true;
      timeline.max = String(scene.frames.length - 1);
      play.disabled = timeline.disabled = scene.frames.length < 2;
      sceneLabel.textContent = scene.title;
      get('counter').textContent = '— / ' + scene.frames.length;
      show(0);
    }
    async function load() {
      if (location.protocol === 'file:') return;
      try {
        const response = await fetch(manifest);
        if (!response.ok) throw Error('The demo list could not be loaded.');
        const payload = await response.json();
        if (!Array.isArray(payload.sequences)) throw Error('Invalid demo list.');
        sequences = payload.sequences.map((entry, i) => {
          if (!Array.isArray(entry.frames) || !entry.frames.length ||
              !entry.frames.every(path => typeof path === 'string' && path.trim())) throw Error('Invalid frame list.');
          const fps = Number(entry.fps ?? 8);
          if (!Number.isFinite(fps) || fps < 1 || fps > 60) throw Error('Invalid playback frame rate.');
          return {title: entry.title || 'Scene ' + (i + 1), frames: entry.frames, fps};
        });
        if (!sequences.length) { status('Demo coming soon'); return; }
        const module = await import(rendererUrl.href);
        parsePly = module.parsePly;
        renderer = module.createRenderer(canvas);
        scenesControl.replaceChildren(...sequences.map((s, i) => new Option(s.title, String(i))));
        scenesControl.hidden = sequences.length < 2;
        sceneLabel.hidden = sequences.length !== 1;
        selectScene(0);
      } catch (error) {
        status(error instanceof TypeError ? 'The demo could not be loaded.' : error.message, load);
      }
    }
    play.addEventListener('click', () => {
      setPlaying(!playing);
      if (playing) schedule();
    });
    timeline.addEventListener('input', () => {
      setPlaying(false);
      show(Number(timeline.value));
    });
    get('reset').addEventListener('click', () => renderer.reset());
    expand.addEventListener('click', async () => {
      try {
        if (document.fullscreenElement === root) await document.exitFullscreen();
        else await root.requestFullscreen();
      } catch { /* The browser can deny fullscreen in an embedded page. */ }
    });
    document.addEventListener('fullscreenchange', () => {
      expand.title = document.fullscreenElement === root ? 'Exit full screen' : 'Full screen';
      expand.setAttribute('aria-label', expand.title);
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) setPlaying(false); });
    retry.addEventListener('click', () => retryAction?.());
    scenesControl.addEventListener('change', () => selectScene(Number(scenesControl.value)));
    load();
  }
  document.querySelectorAll('[data-loft-viewer]').forEach(mount);
})();
