const scalarTypes = {
  char: ['getInt8', 1], uchar: ['getUint8', 1],
  short: ['getInt16', 2], ushort: ['getUint16', 2],
  int: ['getInt32', 4], uint: ['getUint32', 4],
  float: ['getFloat32', 4], double: ['getFloat64', 8],
};
for (const [alias, type] of Object.entries({
  int8: 'char', uint8: 'uchar', int16: 'short', uint16: 'ushort',
  int32: 'int', uint32: 'uint', float32: 'float', float64: 'double',
})) scalarTypes[alias] = scalarTypes[type];

export function parsePly(buffer) {
  const decoder = new TextDecoder('ascii');
  const head = decoder.decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 65536)));
  const match = /^end_header[ \t]*\r?\n/m.exec(head);
  if (!head.startsWith('ply') || !match) throw Error('Invalid PLY header.');
  const offset = match.index + match[0].length;
  const lines = head.slice(0, match.index).trim().split(/\r?\n/).map(line => line.trim());
  const format = lines.find(line => line.startsWith('format '))?.split(/\s+/)[1];
  const vertexLine = lines.findIndex(line => line.startsWith('element '));
  const [, element, rawCount] = (lines[vertexLine] || '').split(/\s+/);
  const count = Number(rawCount);
  if (!['ascii', 'binary_little_endian'].includes(format) || element !== 'vertex' ||
      !Number.isSafeInteger(count) || count < 1) throw Error('Unsupported or empty PLY file.');

  let stride = 0;
  const properties = new Map();
  for (const line of lines.slice(vertexLine + 1)) {
    const [kind, type, name] = line.split(/\s+/);
    if (kind === 'element') break;
    if (kind !== 'property') continue;
    if (!Object.hasOwn(scalarTypes, type)) throw Error('Unsupported vertex property.');
    const [method, bytes] = scalarTypes[type];
    properties.set(name, {index: properties.size, offset: stride, method});
    stride += bytes;
  }

  const xyz = ['x', 'y', 'z'].map(key => properties.get(key));
  const rgb = ['red', 'green', 'blue'].map(key => properties.get(key));
  const score = properties.get('confidence');
  if (!xyz.every(Boolean)) throw Error('Missing vertex coordinates.');
  const dataBytes = buffer.byteLength - offset;
  if (dataBytes < count * (format === 'ascii' ? 1 : stride)) throw Error('Incomplete PLY data.');
  const ascii = format === 'ascii' ? decoder.decode(new Uint8Array(buffer, offset)).split(/\r?\n/) : null;
  const binary = ascii ? null : new DataView(buffer, offset);
  const data = new Float32Array(count * 6);
  const confidence = score ? new Float32Array(count) : null;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let n = 0;
  for (let i = 0; i < count; ++i) {
    const row = ascii ? ascii[i]?.trim().split(/\s+/) : null;
    if (ascii && (!row || row.length < properties.size)) throw Error('Incomplete PLY vertex.');
    const read = prop => row ? Number(row[prop.index]) : binary[prop.method](i * stride + prop.offset, true);
    const x = read(xyz[0]), y = read(xyz[1]), z = read(xyz[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    data[n] = x; data[n + 1] = y; data[n + 2] = z;
    if (score) confidence[n/6] = read(score);
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], data[n + axis]);
      max[axis] = Math.max(max[axis], data[n + axis]);
      data[n + 3 + axis] = rgb[axis] ? Math.max(0, Math.min(1, read(rgb[axis]) / 255)) : 0.86;
    }
    n += 6;
  }
  if (n === 0) throw Error('No finite points in this frame.');
  const frame = {vertices: data.subarray(0, n), min, max};
  if (confidence) frame.confidence = confidence.subarray(0, n/6);
  return frame;
}

function filterFrame(frame, threshold) {
  const {vertices, confidence} = frame;
  if (threshold == null) return frame;
  if (!confidence) throw Error('This cloud has no per-point confidence. Add confidence scores or remove confidence_thresh.');
  if (confidence.length !== vertices.length/6) throw Error('Confidence length does not match the point count.');

  let count = 0;
  for (let i = 0; i < confidence.length; i++) {
    if (Number.isFinite(confidence[i]) && confidence[i] >= threshold) count++;
  }
  if (count === confidence.length) return frame;
  const filtered = new Float32Array(6 * count);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let dest = 0;
  for (let i = 0; i < confidence.length && dest < filtered.length; i++) {
    if (!Number.isFinite(confidence[i]) || confidence[i] < threshold) continue;
    const src = i * 6;
    for (let axis = 0; axis < 3; axis++) {
      const value = vertices[src + axis];
      filtered[dest + axis] = value;
      filtered[dest + 3 + axis] = vertices[src + 3 + axis];
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
    dest += 6;
  }
  return {vertices: filtered, min: count ? min : [0,0,0], max: count ? max : [0,0,0]};
}

const vertexShader = `
  attribute vec3 aPosition;
  attribute vec3 aColor;
  varying lowp vec3 color;
  uniform vec3 uEye;
  uniform vec4 uRotation, uFocal;
  uniform vec2 uOffset;
  uniform float uNear, uPointSize;
  void main() {
    vec3 p = aPosition - uEye;
    vec3 uv = cross(uRotation.xyz, p);
    p += 2. * (uRotation.w * uv + cross(uRotation.xyz, uv));
    // OpenCV camera axes: X right, Y down, Z forward. Clip W is camera Z.
    vec2 xy = vec2(dot(uFocal.xy, p.xy), dot(uFocal.zw, p.xy));
    gl_Position = vec4(xy + uOffset * p.z, p.z - 2. * uNear, p.z);
    gl_PointSize = uPointSize;
    color = aColor;
  }
`;
const fragmentShader = `
  precision mediump float;
  varying lowp vec3 color;
  void main() { gl_FragColor = vec4(color, 1.); }
`;

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const unitQuaternion = q => {
  const length = Math.hypot(...q);
  return q.map(x => x / length);
};

function worldToCameraRotation(r) {
  // Build the quaternion from the largest diagonal term for numerical stability.
  const terms = [1+r[0]-r[5]-r[10], 1-r[0]+r[5]-r[10], 1-r[0]-r[5]+r[10], 1+r[0]+r[5]+r[10]];
  const i = terms.indexOf(Math.max(...terms));
  const t = terms[i];
  const candidates = [
    [t, r[1]+r[4], r[2]+r[8], r[9]-r[6]],
    [r[1]+r[4], t, r[6]+r[9], r[2]-r[8]],
    [r[2]+r[8], r[6]+r[9], t, r[4]-r[1]],
    [r[9]-r[6], r[2]-r[8], r[4]-r[1], t]
  ];
  return unitQuaternion(candidates[i]);
}

function quaternionProduct([x,y,z,w], [a,b,c,d]) {
  return [w*a+x*d+y*c-z*b, w*b-x*c+y*d+z*a, w*c+x*b-y*a+z*d, w*d-x*a-y*b-z*c];
}

// Third camera basis vector in world coordinates, i.e. R^T * (0,0,1).
function forward([x,y,z,w]) {
  return [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)];
}

function calibratedCamera(frame, camera, referenceDepth, settings) {
  const {intrinsics: k, extrinsics: e, width, height, coordinateScale = 1} = camera;
  if (!(width > 0 && height > 0 && coordinateScale > 0) ||
      k?.length !== 9 || ![12,16].includes(e?.length) ||
      !k.every(Number.isFinite) || !e.every(Number.isFinite) || !(k[0] > 0 && k[4] > 0)) {
    throw Error('Invalid camera calibration for this frame.');
  }
  // Cloud XYZ is in display units, so t must be scaled by the same factor.
  const tx=e[3]*coordinateScale, ty=e[7]*coordinateScale, tz=e[11]*coordinateScale;
  const points = frame.vertices, depths = [];
  const step = Math.max(1, Math.floor(points.length / (6*128))) * 6;
  for (let i = 0; i < points.length; i += step) {
    const z = e[8]*points[i] + e[9]*points[i+1] + e[10]*points[i+2] + tz;
    if (z > 0 && Number.isFinite(z)) depths.push(z);
  }
  depths.sort((a,b) => a-b);
  const medianDepth = depths[Math.floor(depths.length/2)];
  // Keep the offset rigid along the trajectory as foreground objects enter or leave the frame.
  const followDepth = referenceDepth ?? medianDepth;
  const framingDistance = followDepth ?? coordinateScale;
  const setback = framingDistance * (settings.followSetbackRatio ?? 0.10);
  const followTilt = (settings.followTiltDegrees ?? 5) * Math.PI / 180;
  const lift = (framingDistance + setback) * Math.tan(followTilt);
  // Rᵀ maps local up (−Y) and back (−Z) into world space. Pitch toward the original focus plane.
  const eye = [0,1,2].map(j => -(e[j]*tx + e[j+4]*(ty+lift) + e[j+8]*(tz+setback)));
  const tiltRotation = [Math.sin(followTilt/2), 0, 0, Math.cos(followTilt/2)];
  const rotation = quaternionProduct(tiltRotation, worldToCameraRotation(e));
  const focus = ((medianDepth ?? framingDistance) + setback) * Math.cos(followTilt) + lift * Math.sin(followTilt);
  return {
    rotation, eye, focus, followDepth,
    aspect: width/height, near: coordinateScale*0.0001,
    focal: [2*k[0]/width, 2*k[1]/width, -2*k[3]/height, -2*k[4]/height],
    offset: [(2*k[2]+1)/width-1, 1-(2*k[5]+1)/height], pan: [0,0]
  };
}

function blendCameras(from, to, t) {
  const mix = (a,b) => a.map((x,i) => x + (b[i]-x)*t);
  // Normalized shortest-arc quaternion interpolation keeps the orientation rigid.
  const dot = from.rotation.reduce((sum,x,i) => sum + x*to.rotation[i], 0);
  const end = dot < 0 ? to.rotation.map(x => -x) : to.rotation;
  return {...to, rotation: unitQuaternion(mix(from.rotation, end)), eye: mix(from.eye,to.eye),
    focal: mix(from.focal,to.focal), offset: mix(from.offset,to.offset), pan: mix(from.pan,to.pan)};
}

// Fit the populated part of a whole-scene cloud. Distant sky and isolated
// depth estimates are retained on the GPU and are still reachable by orbiting.
function overviewBounds(frame) {
  const points = frame.vertices;
  const step = 6 * Math.max(1, Math.ceil(points.length / (6 * 4096)));
  const samples = [];
  for (let i = 0; i < points.length; i += step) samples.push([points[i], points[i+1], points[i+2]]);

  const mid = Math.floor(samples.length/2);
  const median = [0,1,2].map(axis => samples.map(p => p[axis]).sort((a,b) => a-b)[mid]);
  const distances = samples.map(p => Math.hypot(p[0]-median[0], p[1]-median[1], p[2]-median[2]));
  const sorted = [...distances].sort((a,b) => a-b);
  const extent = sorted[Math.floor(samples.length * 0.66)];
  const core = samples.filter((_,i) => distances[i] <= extent);
  const center = [0,1,2].map(axis => core.reduce((sum,p) => sum+p[axis], 0) / core.length);
  return {center, radius: sorted[mid] || extent || 1};
}

export function createRenderer(canvas, onCameraMode, {overview = false} = {}) {
  const gl = canvas.getContext('webgl', {alpha: false, antialias: false});
  if (!gl) throw Error('This browser needs WebGL to display point clouds.');
  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, vertexShader], [gl.FRAGMENT_SHADER, fragmentShader]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw Error('Unable to initialize the point cloud display.');
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error('Unable to initialize the point cloud display.');
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  for (const [name, offset] of [['aPosition', 0], ['aColor', 12]]) {
    const attribute = gl.getAttribLocation(program, name);
    gl.enableVertexAttribArray(attribute);
    gl.vertexAttribPointer(attribute, 3, gl.FLOAT, false, 24, offset);
  }
  const uniform = Object.fromEntries(['Eye','Rotation','Focal','Offset','Near','PointSize']
    .map(name => [name, gl.getUniformLocation(program, 'u' + name)]));
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(1, 1, 1, 1);

  // latest always tracks the displayed frame; anchor stays fixed in world space
  // while gestures control the view. These are independent of the playback clock.
  const pointers = new Map();
  let latest = null, anchor = null, returning = null, idleTimer, animation;
  let center = [0,0,0], radius = 1, count = 0;
  let previousFrame = null, previousThreshold, visibleFrame = null;
  const defaultPointSize = overview ? 1.5 : 2.2;
  let pointSize = defaultPointSize;
  let yaw = 0, pitch = 0, zoom = 1, panX = 0, panY = 0;
  function mode(value) {
    if (canvas.dataset.cameraMode === value) return;
    canvas.dataset.cameraMode = value;
    onCameraMode?.(value);
  }
  function clearOffsets() {
    yaw = overview ? 0.68 : 0; pitch = overview ? -0.30 : 0; zoom = 1; panX = 0; panY = 0;
  }
  function freeCamera(aspect) {
    const focus = 3 * radius * Math.max(1, 1/aspect);
    return {rotation: [0,0,0,1], eye: [center[0],center[1],center[2]-focus], focus,
      aspect, near: radius*0.01, focal: [2.4/aspect,0,0,-2.4], offset: [0,0], pan: [0,0]};
  }
  function adjustedCamera(base) {
    const c = Math.cos(yaw/2), s = Math.sin(yaw/2), v = Math.sin(-pitch/2), t = Math.cos(-pitch/2);
    const rotation = quaternionProduct([v*c,t*s,v*s,t*c], base.rotation);
    const oldAxis = forward(base.rotation), newAxis = forward(rotation);
    const focus = base.focus / zoom;
    const eye = base.eye.map((x,i) => x + oldAxis[i]*base.focus - newAxis[i]*focus);
    return {...base, rotation, eye, focus, pan: [base.pan[0]+panX, base.pan[1]+panY]};
  }
  function view(aspect) {
    if (!latest) return adjustedCamera(freeCamera(aspect));
    if (anchor) return adjustedCamera(anchor);
    if (returning) {
      const t = Math.min(1,(performance.now()-returning.start)/350);
      if (t < 1) return blendCameras(returning.from, latest, t*t*(3-2*t));
      returning = null;
      mode('follow');
    }
    return latest;
  }

  function draw() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width; canvas.height = height;
    }
    const aspect = width/height;
    const camera = view(aspect);
    // Fit the calibrated image without cropping or changing pixel aspect.
    const sx = Math.min(1,camera.aspect/aspect), sy = Math.min(1,aspect/camera.aspect);
    const [fx,skew,k10,fy] = camera.focal;
    gl.viewport(0,0,width,height);
    gl.uniform3fv(uniform.Eye, camera.eye);
    gl.uniform4fv(uniform.Rotation, camera.rotation);
    gl.uniform4f(uniform.Focal, sx*fx,sx*skew,sy*k10,sy*fy);
    gl.uniform2f(uniform.Offset, sx*camera.offset[0]+camera.pan[0], sy*camera.offset[1]+camera.pan[1]);
    gl.uniform1f(uniform.Near, camera.near);
    gl.uniform1f(uniform.PointSize, pointSize*dpr);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, count);
    if (returning && animation == null) {
      animation = requestAnimationFrame(() => { animation = null; draw(); });
    }
  }

  function reset() {
    clearTimeout(idleTimer);
    anchor = null; returning = null;
    clearOffsets();
    mode(latest ? 'follow' : 'free');
    draw();
  }
  function scheduleReturn() {
    clearTimeout(idleTimer);
    if (!anchor || pointers.size) return;
    idleTimer = setTimeout(() => {
      returning = {from: adjustedCamera(anchor), start: performance.now()};
      anchor = null;
      clearOffsets();
      draw();
    }, 4000);
  }
  function takeControl() {
    if (latest && !anchor) {
      anchor = view(canvas.width/canvas.height);
      returning = null;
      clearOffsets();
      mode('manual');
    }
    scheduleReturn();
  }
  function orbit(dx,dy) {
    yaw += dx;
    pitch = clamp(pitch+dy, -Math.PI/2, Math.PI/2);
  }
  function magnify(factor) { zoom = clamp(zoom*factor,0.08,15); }

  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId,[event.clientX,event.clientY]);
    takeControl();
    canvas.focus({preventScroll:true});
  });
  canvas.addEventListener('pointermove', event => {
    const prev = pointers.get(event.pointerId);
    if (!prev) return;
    takeControl();
    const x = event.clientX, y = event.clientY;
    const dx = x-prev[0], dy = y-prev[1];
    pointers.set(event.pointerId,[x,y]);
    if (pointers.size === 2) {
      const other = [...pointers].find(([id]) => id !== event.pointerId)[1];
      const before = Math.hypot(prev[0]-other[0],prev[1]-other[1]);
      const after = Math.hypot(x-other[0],y-other[1]);
      if (before > 1 && after > 1) magnify(after/before);
      panX += dx/canvas.clientWidth;
      panY -= dy/canvas.clientHeight;
    } else if (event.shiftKey) {
      panX += 2*dx/canvas.clientWidth;
      panY -= 2*dy/canvas.clientHeight;
    } else {
      orbit(-dx*0.008,-dy*0.008);
    }
    draw();
  });
  canvas.addEventListener('lostpointercapture', event => {
    pointers.delete(event.pointerId);
    scheduleReturn();
  });
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    takeControl();
    magnify(Math.exp(-clamp(event.deltaY*(event.deltaMode === 1 ? 16 : 1),-200,200)*0.002));
    draw();
  },{passive:false});
  canvas.addEventListener('dblclick',reset);
  canvas.addEventListener('keydown', event => {
    const key = event.key;
    if (key.toLowerCase() === 'r') { event.preventDefault(); reset(); return; }
    if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-'].includes(key)) return;
    event.preventDefault();
    takeControl();
    if (key === 'ArrowLeft') orbit(-0.08,0);
    else if (key === 'ArrowRight') orbit(0.08,0);
    else if (key === 'ArrowUp') orbit(0,-0.08);
    else if (key === 'ArrowDown') orbit(0,0.08);
    else magnify(key === '-' ? 1/1.12 : 1.12);
    draw();
  });
  new ResizeObserver(draw).observe(canvas);
  return {
    reset,
    show(frame, fit, calibration = null, settings = {}) {
      const {confidenceThresh, pointSize: requestedSize} = settings;
      const threshold = Number.isFinite(confidenceThresh) ? confidenceThresh : null;
      pointSize = Number.isFinite(requestedSize) && requestedSize > 0 ? requestedSize : defaultPointSize;
      if (previousFrame?.vertices !== frame.vertices || previousFrame?.confidence !== frame.confidence ||
          previousThreshold !== threshold) {
        const filtered = filterFrame(frame, threshold);
        if (filtered.vertices !== visibleFrame?.vertices) {
          gl.bufferData(gl.ARRAY_BUFFER,filtered.vertices,gl.DYNAMIC_DRAW);
        }
        visibleFrame = filtered;
        previousFrame = frame;
        previousThreshold = threshold;
        count = filtered.vertices.length/6;
      }
      if (fit && count) {
        if (overview) {
          ({center, radius} = overviewBounds(visibleFrame));
        } else {
          center = visibleFrame.min.map((x,i) => (x+visibleFrame.max[i])/2);
          radius = Math.hypot(...visibleFrame.max.map((x,i) => x-visibleFrame.min[i]))/2 || 1;
        }
      }
      const hadCalibration = !!latest;
      latest = calibration && !overview
        ? calibratedCamera(visibleFrame, calibration, fit ? null : latest?.followDepth, settings)
        : null;
      if (fit || !!latest !== hadCalibration) reset();
      else draw();
      return count;
    }
  };
}
