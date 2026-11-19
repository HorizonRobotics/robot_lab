export const mountViewer = (() => {
  const scriptUrl = new URL(import.meta.url);
  const rendererUrl = new URL('point-cloud.js', scriptUrl);
  rendererUrl.search = scriptUrl.search;
  const npzUrl = new URL('npz.js', rendererUrl);
  npzUrl.search = scriptUrl.search;
  const icon = id => `<svg class="icon" aria-hidden="true"><use href="#${id}"/></svg>`;

  const gestureHint = 'Drag to orbit · <span class="lv-wheel">Scroll</span><span class="lv-pinch">Pinch</span> to zoom';

  function mount(root) {
    root.innerHTML = `
      <div class="lv-layout">
        <figure class="lv-cloud-panel">
          <figcaption class="lv-panel-heading">
            <span class="player-caption">Point cloud</span>
            <span class="lv-view-controls">
              <button class="lv-global player-button" type="button" aria-haspopup="dialog" aria-expanded="false" hidden>Global point cloud</button>
              <button class="lv-reset player-button player-icon-button" type="button" title="Reset view" aria-label="Reset view" disabled>${icon('reset-view')}</button>
            </span>
          </figcaption>
          <div class="lv-stage">
            <canvas class="lv-canvas" tabindex="0" aria-label="3D point cloud. Use arrow keys to rotate, plus or minus to zoom, and R to reset." hidden></canvas>
            <div class="lv-placeholder" role="status">
              <span class="lv-message">Loading point cloud…</span>
              <button class="lv-retry player-button" type="button" hidden>Try again</button>
            </div>
          </div>
          <p class="lv-hint" hidden><span class="lv-camera-mode" hidden></span>${gestureHint}</p>
        </figure>
        <aside class="lv-media" aria-label="Synchronized frame images" hidden>
          <figure><figcaption class="player-caption">RGB</figcaption><canvas class="lv-rgb" aria-label="RGB image of the current frame"></canvas></figure>
          <figure><figcaption class="player-caption">Depth</figcaption><canvas class="lv-depth" aria-label="Grayscale depth of the current frame"></canvas></figure>
        </aside>
      </div>
      <div class="lv-transport player-toolbar" role="group" aria-label="Point cloud playback">
        <button class="lv-play player-button player-play" type="button" title="Play sequence" aria-label="Play sequence" disabled>Play</button>
        <input class="lv-timeline player-seek" type="range" min="0" max="1" step="1" value="0" aria-label="Frame" disabled>
        <span class="lv-counter player-label" aria-label="Frame count">— / —</span>
        <div class="lv-scenes player-switcher" role="group" aria-label="Point cloud scenes" hidden>
          <button type="button" class="lv-prev player-button player-icon-button" title="Previous scene" aria-label="Previous scene">${icon('previous')}</button>
          <span class="lv-scene-name player-label" aria-live="polite" aria-atomic="true"></span>
          <button type="button" class="lv-next player-button player-icon-button" title="Next scene" aria-label="Next scene">${icon('next')}</button>
        </div>
        <button class="lv-expand player-button player-icon-button" type="button" title="Full screen" aria-label="Full screen" disabled>${icon('expand')}</button>
      </div>
      <dialog class="lv-global-dialog" aria-label="Global point cloud">
        <div class="dialog-tools">
          <h2>Global point cloud</h2>
          <button class="lv-global-reset player-button" type="button" disabled>Reset view</button>
          <button class="lv-global-close player-button player-icon-button" type="button" aria-label="Close global point cloud" autofocus>${icon('close')}</button>
        </div>
        <div class="lv-global-stage">
          <canvas class="lv-global-canvas" tabindex="0" aria-label="Full scene point cloud. Drag or use the arrow keys to orbit. Scroll or use plus and minus to zoom." hidden></canvas>
          <div class="lv-global-status lv-placeholder" role="status">
            <span class="lv-global-message"></span>
            <button type="button" class="lv-global-retry lv-retry player-button" hidden>Try again</button>
          </div>
        </div>
        <p class="lv-global-hint lv-hint" hidden>${gestureHint}</p>
      </dialog>`;
    const get = name => root.querySelector('.lv-' + name);
    const canvas = get('canvas'), timeline = get('timeline'), play = get('play'), expand = get('expand');
    const scenesControl = get('scenes'), retry = get('retry');
    const manifest = new URL(root.dataset.manifest || 'data/demos/manifest.json', document.baseURI);
    const rgbPanel = get('rgb'), depthPanel = get('depth'), modeLabel = get('camera-mode');
    const rgbContext = rgbPanel.getContext('2d'), depthContext = depthPanel.getContext('2d');
    // Prefetching colors must never draw the next RGB frame into the visible panel.
    const colorCanvas = document.createElement('canvas');
    const colorContext = colorCanvas.getContext('2d', {willReadFrequently: true});
    const globalButton = get('global'), dialog = get('global-dialog'), overview = get('global-canvas');
    const globalStatus = get('global-status'), globalRetry = get('global-retry');
    let globalSource, globalCloud, globalRenderer, globalRequest, createRenderer, resumePlayback = false;
    let sequences = [], frames = [], sharedCloud = null, fps = 8, renderer, parsePly, retryAction, sceneRequest;
    let sceneIndex = 0;
    let generation = 0, index = 0, displayedIndex = -1, fit = true, timer, playing = false, pending = false;
    let pointSettings = {};
    const cache = new Map();
    if (!root.requestFullscreen || !document.fullscreenEnabled) expand.hidden = true;

    function status(text, action) {
      get('placeholder').hidden = !text;
      get('message').textContent = text || '';
      retry.hidden = !action;
      retryAction = action;
    }
    function cameraMode(mode) {
      modeLabel.dataset.mode = mode;
      modeLabel.textContent = mode === 'follow' ? 'Following camera' : 'Free view';
      modeLabel.hidden = mode === 'free';
    }
    function setPlaying(value) {
      playing = value;
      clearTimeout(timer);
      play.textContent = value ? 'Pause' : 'Play';
      play.title = value ? 'Pause sequence' : 'Play sequence';
      play.setAttribute('aria-label', play.title);
      updateFrameWindow(value);
    }
    function discard(key) {
      cache.get(key).controller.abort();
      cache.delete(key);
    }
    async function fetchAsset(url, options) {
      const response = await fetch(url, options);
      if (!response.ok) throw Error('Could not load ' + url.pathname.split('/').pop() + ' (' + response.status + ').');
      return response;
    }
    async function readBuffer(url, options) {
      return (await fetchAsset(url, options)).arrayBuffer();
    }
    async function decodeCloud(url, buffer, readConfidence, confidenceBuffer) {
      if (url.pathname.toLowerCase().endsWith('.npz')) {
        const {parseNpz} = await import(npzUrl.href);
        return parseNpz(buffer, {readConfidence, confidenceBuffer});
      }
      return parsePly(buffer);
    }
    async function readCloud(url, options) {
      const readConfidence = pointSettings.confidenceThresh != null;
      const buffer = await readBuffer(url, options);
      return decodeCloud(url, buffer, readConfidence, null);
    }
    async function showGlobal(reload = false) {
      globalRequest?.abort();
      const request = new AbortController();
      globalRequest = request;
      globalStatus.hidden = false;
      overview.hidden = get('global-hint').hidden = true;
      get('global-reset').disabled = globalRetry.hidden = true;
      get('global-message').textContent = 'Loading global point cloud…';
      try {
        const cloud = globalCloud ?? await readCloud(globalSource, {
          signal: request.signal, cache: reload ? 'reload' : 'no-cache'
        });
        if (request.signal.aborted || !dialog.open) return;
        globalCloud = cloud;
        overview.hidden = false;
        globalRenderer ??= createRenderer(overview, undefined, {overview: true});
        const count = globalRenderer.show(cloud, true, null, pointSettings);
        globalStatus.hidden = count > 0;
        if (!count) get('global-message').textContent = 'No points meet the confidence threshold.';
        get('global-reset').disabled = get('global-hint').hidden = count === 0;
      } catch (error) {
        if (request.signal.aborted || !dialog.open) return;
        overview.hidden = true;
        get('global-message').textContent = 'Could not display the global point cloud. ' + error.message;
        globalRetry.hidden = false;
      }
    }
    async function decodeImage(blob) {
      const src = URL.createObjectURL(blob);
      try {
        const image = new Image();
        image.src = src;
        await image.decode();
        return image;
      } finally {
        URL.revokeObjectURL(src);
      }
    }
    function fetchFrame(i, reload = false) {
      if (cache.has(i)) return cache.get(i);
      const controller = new AbortController();
      const options = {signal: controller.signal, cache: reload ? 'reload' : 'default'};
      const frame = frames[i];
      const geometry = frame.rgbd || frame.cloud;
      const fetchImage = url => url && fetchAsset(url, options).then(response => response.blob());
      const raw = Promise.all([
        geometry && readBuffer(geometry, options),
        pointSettings.confidenceThresh != null && frame.confidence ? readBuffer(frame.confidence, options) : null,
        fetchImage(frame.rgb), fetchImage(frame.depth)
      ]);
      const entry = {controller, raw, decoded: null};
      cache.set(i, entry);
      return entry;
    }
    function readFrame(i, reload = false) {
      const entry = fetchFrame(i, reload);
      if (entry.decoded) return entry.decoded;
      const frame = frames[i], camera = frame.camera, shared = sharedCloud;
      const signal = entry.controller.signal;
      const readConfidence = pointSettings.confidenceThresh != null;
      entry.decoded = entry.raw.then(async ([buffer, scores, colorBlob, depthBlob]) => {
        signal.throwIfAborted();
        const [geometry, rgb, depth] = await Promise.all([
          frame.cloud ? decodeCloud(frame.cloud, buffer, readConfidence, scores) : shared,
          colorBlob && decodeImage(colorBlob), depthBlob && decodeImage(depthBlob)
        ]);
        signal.throwIfAborted();
        if (camera && [rgb, depth].some(image => image.naturalWidth !== camera.width || image.naturalHeight !== camera.height)) {
          throw Error('Image dimensions do not match the camera calibration.');
        }
        if (!frame.rgbd) return [geometry, rgb, depth];
        const {parseRgbd} = await import(npzUrl.href);
        signal.throwIfAborted();
        if (colorCanvas.width !== camera.width) colorCanvas.width = camera.width;
        if (colorCanvas.height !== camera.height) colorCanvas.height = camera.height;
        colorContext.drawImage(rgb, 0, 0);
        const pixels = colorContext.getImageData(0, 0, camera.width, camera.height).data;
        return [await parseRgbd(buffer, camera, pixels, readConfidence), rgb, depth];
      });
      entry.raw = null;
      return entry.decoded;
    }
    function updateFrameWindow(warm = false) {
      if (!frames.length) return;
      const frame = frames[index];
      const remote = [frame.rgbd, frame.cloud, frame.rgb, frame.depth].some(url => url && url.origin !== location.origin);
      const ahead = dialog.open || document.hidden ? 0 : playing && remote ? 6 : 1;
      const length = Math.min(ahead + 1, frames.length);
      const offsetOf = key => (key - index + frames.length) % frames.length;
      for (const key of cache.keys()) if (offsetOf(key) >= length) discard(key);
      if (!warm) return;
      // Decode only the immediate successor. More distant frames retain compressed assets.
      for (let offset = 1; offset < length; offset++) {
        const i = (index + offset) % frames.length;
        if (offset === 1) readFrame(i).catch(() => {});
        else if (!cache.has(i)) fetchFrame(i).raw.catch(() => {});
      }
    }
    async function show(i, reload = false) {
      clearTimeout(timer);
      const id = ++generation;
      index = i;
      updateFrameWindow();
      pending = true;
      timeline.value = String(i);
      timeline.setAttribute('aria-valuetext', 'Frame ' + (i + 1) + ' of ' + frames.length);
      try {
        const [cloud, rgb, depth] = await readFrame(i, reload);
        if (id !== generation) return;
        const camera = frames[i].camera;
        canvas.hidden = false;
        const count = renderer.show(cloud, fit, camera, pointSettings);
        if (camera) {
          rgbContext.drawImage(rgb, 0, 0);
          depthContext.drawImage(depth, 0, 0);
          get('media').classList.add('lv-ready');
        }
        status(count ? '' : 'No points meet the confidence threshold.');
        displayedIndex = i;
        fit = fit && count === 0;
        pending = false;
        get('hint').hidden = count === 0;
        get('reset').disabled = expand.disabled = false;
        get('counter').textContent = (i + 1) + ' / ' + frames.length;
        updateFrameWindow(true);
        if (playing) schedule();
      } catch (error) {
        if (id !== generation) return;
        if (cache.has(i)) discard(i);
        pending = false;
        setPlaying(false);
        canvas.hidden = true;
        get('media').classList.remove('lv-ready');
        get('hint').hidden = true;
        get('counter').textContent = '— / ' + frames.length;
        get('reset').disabled = true;
        const reason = error instanceof Error ? ' ' + error.message : '';
        status('Frame ' + (i + 1) + ' could not be loaded.' + reason, () => show(i, true));
      }
    }
    function schedule() {
      clearTimeout(timer);
      if (!pending) timer = setTimeout(() => show((index + 1) % frames.length), 1000 / fps);
    }

    async function readScene(entry, signal, reload) {
      if (!entry.source) {
        return {frames: entry.frames.map(path => ({cloud: new URL(path, manifest)})),
          sharedCloud: null, globalSource: entry.globalCloud ? new URL(entry.globalCloud, manifest) : null};
      }
      const source = new URL(entry.source, manifest);
      const response = await fetchAsset(source, {signal, cache: reload ? 'reload' : 'no-cache'});
      const clip = await response.json();
      const {width, height, coordinateScale = 1} = clip;
      if (![width, height].every(v => Number.isInteger(v) && v > 0) ||
          !Number.isFinite(coordinateScale) || coordinateScale <= 0 ||
          !Array.isArray(clip.frames) || !clip.frames.length) throw Error('Invalid calibrated scene index.');
      const isPath = value => typeof value === 'string' && value.trim().length > 0;
      if (clip.cloud != null && !isPath(clip.cloud)) throw Error('Invalid scene point cloud path.');
      const overviewPath = clip.globalCloud ?? clip.cloud;
      const frames = clip.frames.map(({cloud, rgbd, rgb, depth, confidence, intrinsics, extrinsics}) => {
        if (rgbd != null && (!isPath(rgbd) || cloud || clip.cloud)) throw Error('Invalid RGB-D geometry source.');
        if ((!clip.cloud && !rgbd && !isPath(cloud)) || !isPath(rgb) || !isPath(depth) ||
            !Array.isArray(intrinsics) || intrinsics.length !== 9 || !intrinsics.every(Number.isFinite) ||
            !Array.isArray(extrinsics) || ![12,16].includes(extrinsics.length) || !extrinsics.every(Number.isFinite)) {
          throw Error('Missing frame images or camera calibration.');
        }
        return {
          cloud: !rgbd && !clip.cloud ? new URL(cloud, source) : null,
          rgbd: rgbd ? new URL(rgbd, source) : null,
          confidence: isPath(confidence) ? new URL(confidence, source) : null,
          rgb: new URL(rgb, source), depth: new URL(depth, source),
          camera: {intrinsics, extrinsics, width, height, coordinateScale}
        };
      });
      // A shared cloud belongs to the scene so scrubbing or evicting a frame cannot cancel it.
      const sharedCloud = clip.cloud
        ? await readCloud(new URL(clip.cloud, source), {signal, cache: reload ? 'reload' : 'no-cache'})
        : null;
      return {frames, sharedCloud, globalSource: isPath(overviewPath) ? new URL(overviewPath, source) : null,
        globalCloud: overviewPath === clip.cloud ? sharedCloud : null};
    }
    async function selectScene(n, reload = false) {
      sceneIndex = n;
      get('scene-name').textContent = 'Scene ' + (n + 1);
      setPlaying(false);
      resumePlayback = false;
      globalRequest?.abort();
      if (dialog.open) dialog.close();
      globalSource = globalCloud = null;
      globalButton.hidden = true;
      ++generation;
      sceneRequest?.abort();
      const request = new AbortController();
      sceneRequest = request;
      for (const key of cache.keys()) discard(key);
      const entry = sequences[n];
      frames = [];
      sharedCloud = null;
      displayedIndex = -1;
      fit = true;
      pending = true;
      status('Loading point cloud…');
      canvas.hidden = get('hint').hidden = true;
      get('media').classList.remove('lv-ready');
      play.disabled = timeline.disabled = get('reset').disabled = expand.disabled = true;
      get('counter').textContent = '— / —';
      try {
        const {
          confidence_thresh: confidenceThresh, point_size: pointSize,
          follow_setback_ratio: followSetbackRatio, follow_tilt_degrees: followTiltDegrees
        } = entry;
        if (confidenceThresh != null && !Number.isFinite(confidenceThresh)) {
          throw Error('confidence_thresh must be a finite number or null.');
        }
        if (pointSize != null && !(Number.isFinite(pointSize) && pointSize > 0)) {
          throw Error('point_size must be a positive number.');
        }
        if (followSetbackRatio != null && !(Number.isFinite(followSetbackRatio) && followSetbackRatio >= 0)) {
          throw Error('follow_setback_ratio must be a non-negative number.');
        }
        if (followTiltDegrees != null && !(Number.isFinite(followTiltDegrees) && Math.abs(followTiltDegrees) < 90)) {
          throw Error('follow_tilt_degrees must be a number strictly between -90 and 90.');
        }
        pointSettings = {confidenceThresh, pointSize, followSetbackRatio, followTiltDegrees};
        const result = await readScene(entry, request.signal, reload);
        if (request.signal.aborted) return;
        frames = result.frames;
        sharedCloud = result.sharedCloud;
        globalSource = result.globalSource;
        globalCloud = result.globalCloud;
        globalButton.hidden = !globalSource;
        fps = entry.fps;
        const camera = frames[0].camera;
        get('media').hidden = !camera;
        root.classList.toggle('lv-has-media', Boolean(camera));
        if (camera) {
          rgbPanel.width = depthPanel.width = camera.width;
          rgbPanel.height = depthPanel.height = camera.height;
        }
        timeline.max = String(frames.length - 1);
        play.disabled = timeline.disabled = frames.length < 2;
        await show(0, reload);
      } catch (error) {
        if (!request.signal.aborted) status('Could not load scene. ' + error.message, () => selectScene(n, true));
      }
    }
    async function load() {
      if (location.protocol === 'file:') return;
      status('Loading point cloud…');
      try {
        const response = await fetchAsset(manifest, {cache: 'no-cache'});
        const payload = await response.json();
        if (!Array.isArray(payload.sequences)) throw Error('Invalid demo list.');
        sequences = payload.sequences.map(entry => {
          if (!(typeof entry.source === 'string' && entry.source.trim()) &&
              !(Array.isArray(entry.frames) && entry.frames.length && entry.frames.every(p => typeof p === 'string' && p.trim()))) {
            throw Error('Invalid scene source or frame list.');
          }
          const fps = Number(entry.fps ?? 8);
          if (!Number.isFinite(fps) || fps < 1 || fps > 60) throw Error('Invalid playback frame rate.');
          return {...entry, fps};
        });
        if (!sequences.length) { status('Demo coming soon'); return; }
        const module = await import(rendererUrl.href);
        parsePly = module.parsePly;
        createRenderer = module.createRenderer;
        renderer = createRenderer(canvas, cameraMode);
        get('prev').hidden = get('next').hidden = sequences.length < 2;
        scenesControl.hidden = false;
        selectScene(0);
      } catch (error) {
        status('Could not load point cloud viewer. ' + error.message, load);
      }
    }
    play.addEventListener('click', () => {
      setPlaying(!playing);
      if (playing) schedule();
    });
    timeline.addEventListener('input', () => {
      index = Number(timeline.value);
      setPlaying(false);
      show(index);
    });
    get('reset').addEventListener('click', () => renderer.reset());
    globalButton.addEventListener('click', () => {
      if (!globalSource || dialog.open) return;
      resumePlayback = playing;
      setPlaying(false);
      if (pending && displayedIndex >= 0) {
        // A prefetched frame can finish decoding while the overview is open.
        ++generation;
        pending = false;
        index = displayedIndex;
        timeline.value = String(index);
        timeline.setAttribute('aria-valuetext', 'Frame ' + (index + 1) + ' of ' + frames.length);
      }
      dialog.showModal();
      updateFrameWindow();
      globalButton.setAttribute('aria-expanded', 'true');
      showGlobal();
    });
    get('global-reset').addEventListener('click', () => globalRenderer?.reset());
    get('global-close').addEventListener('click', () => dialog.close());
    globalRetry.addEventListener('click', () => showGlobal(true));
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right ||
          event.clientY < box.top || event.clientY > box.bottom) dialog.close();
    });
    dialog.addEventListener('close', () => {
      if (dialog.open) return;
      globalRequest?.abort();
      globalButton.setAttribute('aria-expanded', 'false');
      if (resumePlayback && !document.hidden && !play.disabled) {
        setPlaying(true);
        schedule();
      } else {
        updateFrameWindow(true);
      }
      resumePlayback = false;
    });
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
    function stepScene(direction) {
      selectScene((sceneIndex + direction + sequences.length) % sequences.length);
    }
    get('prev').addEventListener('click', () => stepScene(-1));
    get('next').addEventListener('click', () => stepScene(1));
    root.addEventListener('keydown', event => {
      if (sequences.length < 2 || event.target.closest('canvas, input, dialog') ||
          event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      if (!event.repeat) stepScene(event.key === 'ArrowLeft' ? -1 : 1);
    });
    load();
  }
  return mount;
})();
