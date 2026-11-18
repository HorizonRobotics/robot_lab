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
  if (!xyz.every(Boolean)) throw Error('Missing vertex coordinates.');
  const dataBytes = buffer.byteLength - offset;
  if (dataBytes < count * (format === 'ascii' ? 1 : stride)) throw Error('Incomplete PLY data.');
  const ascii = format === 'ascii' ? decoder.decode(new Uint8Array(buffer, offset)).split(/\r?\n/) : null;
  const binary = ascii ? null : new DataView(buffer, offset);
  const data = new Float32Array(count * 6);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let n = 0;
  for (let i = 0; i < count; ++i) {
    const row = ascii ? ascii[i]?.trim().split(/\s+/) : null;
    if (ascii && (!row || row.length < properties.size)) throw Error('Incomplete PLY vertex.');
    const read = prop => row ? Number(row[prop.index]) : binary[prop.method](i * stride + prop.offset, true);
    const x = read(xyz[0]), y = read(xyz[1]), z = read(xyz[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    data[n] = x; data[n + 1] = y; data[n + 2] = z;
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], data[n + axis]);
      max[axis] = Math.max(max[axis], data[n + axis]);
      data[n + 3 + axis] = rgb[axis] ? Math.max(0, Math.min(1, read(rgb[axis]) / 255)) : 0.86;
    }
    n += 6;
  }
  if (n === 0) throw Error('No finite points in this frame.');
  return {vertices: data.subarray(0, n), min, max};
}

const vertexShader = `
  attribute vec3 aPosition;
  attribute vec3 aColor;
  varying lowp vec3 color;
  uniform vec3 uCenter;
  uniform vec2 uAngles, uPan;
  uniform float uScale, uDistance, uAspect, uPixelRatio;
  void main() {
    vec3 p = (aPosition - uCenter) * uScale;
    float c = cos(uAngles.x), s = sin(uAngles.x);
    vec3 q = vec3(c*p.x + s*p.z, -p.y, -s*p.x + c*p.z);
    float t = cos(uAngles.y), v = sin(uAngles.y);
    float depth = uDistance + v*q.y + t*q.z;
    // Perspective projection, positive camera-space z points into the scene.
    gl_Position = vec4(2.4*q.x/uAspect, 2.4*(t*q.y-v*q.z), 1.00002*depth-0.0200002, depth);
    gl_Position.xy += uPan * depth;
    gl_PointSize = 2.2 * uPixelRatio;
    color = aColor;
  }
`;
const fragmentShader = `
  precision mediump float;
  varying lowp vec3 color;
  void main() { gl_FragColor = vec4(color, 1.); }
`;

export function createRenderer(canvas) {
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
  const uniform = Object.fromEntries(['Center','Scale','Angles','Pan','Distance','Aspect','PixelRatio']
    .map(name => [name, gl.getUniformLocation(program, 'u' + name)]));
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0.095, 0.102, 0.11, 1);
  let count = 0, yaw = 0, pitch = 0, zoom = 1, panX = 0, panY = 0;
  const clamp = (x, min, max) => Math.max(min, Math.min(x, max));

  function draw() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.uniform1f(uniform.Aspect, width / height);
    gl.uniform1f(uniform.PixelRatio, dpr);
    gl.uniform1f(uniform.Distance, 3 * Math.max(1, height / width) / zoom);
    gl.uniform2f(uniform.Angles, yaw, pitch);
    gl.uniform2f(uniform.Pan, panX, panY);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, count);
  }
  function reset() {
    zoom = 1; yaw = 0; pitch = 0; panX = 0; panY = 0;
    draw();
  }
  function orbit(dx, dy) {
    yaw += dx;
    pitch = clamp(pitch + dy, -Math.PI / 2, Math.PI / 2);
  }
  function magnify(factor) { zoom = clamp(zoom * factor, 0.08, 15); }

  const pointers = new Map();
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, [event.clientX, event.clientY]);
    canvas.focus({preventScroll: true});
  });
  canvas.addEventListener('pointermove', event => {
    const prev = pointers.get(event.pointerId);
    if (!prev) return;
    const x = event.clientX, y = event.clientY;
    const dx = x - prev[0], dy = y - prev[1];
    pointers.set(event.pointerId, [x, y]);
    if (pointers.size === 2) {
      const other = [...pointers].find(([id]) => id !== event.pointerId)[1];
      const before = Math.hypot(prev[0] - other[0], prev[1] - other[1]);
      const after = Math.hypot(x - other[0], y - other[1]);
      if (before > 1 && after > 1) magnify(after / before);
      panX += dx / canvas.clientWidth;
      panY -= dy / canvas.clientHeight;
    } else if (event.shiftKey) {
      panX += 2 * dx / canvas.clientWidth;
      panY -= 2 * dy / canvas.clientHeight;
    } else {
      orbit(dx * 0.008, dy * 0.008);
    }
    draw();
  });
  canvas.addEventListener('lostpointercapture', event => pointers.delete(event.pointerId));
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    magnify(Math.exp(-clamp(event.deltaY * (event.deltaMode === 1 ? 16 : 1), -200, 200) * 0.002));
    draw();
  }, {passive: false});
  canvas.addEventListener('dblclick', reset);
  canvas.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft') orbit(-0.08, 0);
    else if (event.key === 'ArrowRight') orbit(0.08, 0);
    else if (event.key === 'ArrowUp') orbit(0, -0.08);
    else if (event.key === 'ArrowDown') orbit(0, 0.08);
    else if (event.key === '+' || event.key === '=') magnify(1.12);
    else if (event.key === '-') magnify(1 / 1.12);
    else if (event.key.toLowerCase() === 'r') reset();
    else return;
    event.preventDefault();
    draw();
  });
  new ResizeObserver(draw).observe(canvas);
  return {
    reset,
    show(frame, fit) {
      if (fit) {
        const center = frame.min.map((v,i) => (v + frame.max[i])/2);
        const diameter = Math.hypot(...frame.max.map((v,i) => v-frame.min[i]));
        gl.uniform3fv(uniform.Center, center);
        gl.uniform1f(uniform.Scale, diameter > 0 ? 2 / diameter : 1);
      }
      gl.bufferData(gl.ARRAY_BUFFER, frame.vertices, gl.DYNAMIC_DRAW);
      count = frame.vertices.length / 6;
      if (fit) reset(); else draw();
    },
  };
}
