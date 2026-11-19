import './vendor/jszip.min.js';

const numericTypes = {
  f2: 'getUint16', f4: 'getFloat32', f8: 'getFloat64',
  i1: 'getInt8', i2: 'getInt16', i4: 'getInt32',
  u1: 'getUint8', u2: 'getUint16', u4: 'getUint32'
};

function float16(bits) {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 31;
  const fraction = bits & 1023;
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

// A NumPy NPZ contains one NPY file per named array. Only the selected
// matrices are inflated; unrelated masks, images and metadata stay in the ZIP.
async function matrix(file, allowedColumns) {
  const buffer = await file.async('arraybuffer');
  const view = new DataView(buffer);
  if (buffer.byteLength < 12 || view.getUint32(0) !== 0x934e554d || view.getUint16(4) !== 0x5059) {
    throw Error('Invalid NPY header in ' + file.name + '.');
  }
  const version = view.getUint8(6);
  if (![1, 2, 3].includes(version)) throw Error('Unknown NPY version in ' + file.name + '.');
  const start = version === 1 ? 10 : 12;
  const size = version === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const offset = start + size;
  if (offset > buffer.byteLength) throw Error('Incomplete NPY header in ' + file.name + '.');
  const header = new TextDecoder().decode(new Uint8Array(buffer, start, size));
  const type = /['"]descr['"]\s*:\s*['"]([<>=|])([fiu][1248])['"]/.exec(header);
  const order = /['"]fortran_order['"]\s*:\s*(True|False)\b/.exec(header);
  const shape = /['"]shape['"]\s*:\s*\(\s*(\d+)\s*,\s*(?:(\d+)\s*,?\s*)?\)/.exec(header);
  if (!type || !Object.hasOwn(numericTypes, type[2]) || !order || !shape) {
    throw Error('Expected a numeric array in ' + file.name + '.');
  }
  const rows = Number(shape[1]), columns = Number(shape[2] ?? 1);
  const dtype = type[2], bytes = Number(dtype[1]);
  if (!allowedColumns.includes(columns) || rows * columns * bytes !== buffer.byteLength - offset) {
    throw Error('Unexpected matrix shape or length in ' + file.name + '.');
  }
  const columnMajor = order[1] === 'True';
  const littleEndian = type[1] !== '>';
  const read = view[numericTypes[dtype]].bind(view);
  return {
    rows, dtype,
    floating: dtype.startsWith('f'),
    at(row, column) {
      const index = columnMajor ? column * rows + row : row * columns + column;
      const value = read(offset + index * bytes, littleEndian);
      return dtype === 'f2' ? float16(value) : value;
    }
  };
}

export async function parseNpz(buffer, {readConfidence = false, confidenceBuffer = null} = {}) {
  const zip = await globalThis.JSZip.loadAsync(buffer);
  const positions = zip.file('xyz.npy') || zip.file('points.npy') || zip.file('point_cloud_points.npy');
  if (!positions) throw Error('NPZ needs a point array named xyz, points, or point_cloud_points.');
  const colors = zip.file('rgb.npy') || zip.file('colors.npy') || zip.file('point_cloud_colors.npy');
  let scores;
  if (readConfidence) {
    const archive = confidenceBuffer ? await globalThis.JSZip.loadAsync(confidenceBuffer) : zip;
    scores = archive.file('confidence.npy') || archive.file('depth_confidence.npy');
    if (confidenceBuffer && !scores) throw Error('Missing confidence scores in the frame confidence file.');
  }
  const [xyz, rgb, conf] = await Promise.all([
    matrix(positions, [3]), colors && matrix(colors, [3, 4]), scores && matrix(scores, [1])
  ]);
  if (rgb && rgb.rows !== xyz.rows) throw Error('NPZ point and color counts differ.');
  if (conf && conf.rows !== xyz.rows) throw Error('NPZ point and confidence counts differ.');

  const vertices = new Float32Array(xyz.rows * 6);
  const confidence = conf ? new Float32Array(xyz.rows) : null;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let used = 0;
  let byteColors = rgb && !rgb.floating;
  for (let i = 0; i < xyz.rows; i++) {
    const x = Math.fround(xyz.at(i, 0)), y = Math.fround(xyz.at(i, 1)), z = Math.fround(xyz.at(i, 2));
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (confidence) confidence[used / 6] = conf.at(i, 0);
    vertices[used] = x;
    vertices[used + 1] = y;
    vertices[used + 2] = z;
    for (let axis = 0; axis < 3; axis++) {
      const value = vertices[used + axis];
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
      const color = rgb ? rgb.at(i, axis) : 0.86;
      vertices[used + axis + 3] = Number.isFinite(color) ? Math.max(0, color) : 0;
      if (Number.isFinite(color) && color > 1) byteColors = true;
    }
    used += 6;
  }
  if (!used) throw Error('No finite points in this NPZ frame.');
  if (byteColors) {
    for (let i = 0; i < used; i += 6) {
      for (let j = i + 3; j < i + 6; j++) vertices[j] = Math.min(255, vertices[j]) / 255;
    }
  }
  return {vertices: vertices.subarray(0, used), confidence: confidence?.subarray(0, used / 6), min, max};
}

function inverse3([a,b,c,d,e,f,g,h,i]) {
  const adj = [
    e*i-f*h, c*h-b*i, b*f-c*e,
    f*g-d*i, a*i-c*g, c*d-a*f,
    d*h-e*g, b*g-a*h, a*e-b*d
  ];
  const det = a*adj[0] + b*adj[3] + c*adj[6];
  if (!Number.isFinite(det) || det === 0) throw Error('Singular RGB-D camera matrix.');
  return adj.map(x => x / det);
}

export async function parseRgbd(buffer, camera, pixels, readConfidence = false) {
  const {intrinsics: k, extrinsics: e, width, height, coordinateScale = 1} = camera;
  const pixelCount = width * height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      pixels?.length !== pixelCount * 4) throw Error('RGB-D color image dimensions do not match the camera.');
  if (k?.length !== 9 || ![12,16].includes(e?.length) || !k.every(Number.isFinite) ||
      !e.every(Number.isFinite) || !(Number.isFinite(coordinateScale) && coordinateScale > 0)) {
    throw Error('Invalid RGB-D camera calibration.');
  }
  const invK = inverse3(k);
  const invR = [e[0],e[4],e[8], e[1],e[5],e[9], e[2],e[6],e[10]];
  // The exporter validates a rigid W2C pose. Use the same R transpose
  // to unproject camera Z at integer pixel centers into scaled world space.
  const rays = new Float64Array(9), eye = new Float64Array(3);
  for (let axis = 0; axis < 3; axis++) {
    const row = axis * 3;
    eye[axis] = -coordinateScale * (invR[row]*e[3] + invR[row+1]*e[7] + invR[row+2]*e[11]);
    for (let col = 0; col < 3; col++) {
      rays[row+col] = coordinateScale *
        (invR[row]*invK[col] + invR[row+1]*invK[col+3] + invR[row+2]*invK[col+6]);
    }
  }

  const zip = await globalThis.JSZip.loadAsync(buffer);
  const depthFile = zip.file('depth.npy'), maskFile = zip.file('mask.npy');
  if (!depthFile || !maskFile) throw Error('RGB-D frame requires depth.npy and mask.npy.');
  const scoreFile = readConfidence && zip.file('confidence.npy');
  const [depth, mask, scores] = await Promise.all([
    matrix(depthFile, [1]), matrix(maskFile, [1]), scoreFile && matrix(scoreFile, [1])
  ]);
  if (depth.dtype !== 'f4' || mask.dtype !== 'u1' || mask.rows !== Math.ceil(pixelCount / 8) ||
      depth.rows > pixelCount || (scores && (scores.dtype !== 'f4' || scores.rows !== depth.rows))) {
    throw Error('Unexpected RGB-D depth, mask or confidence format.');
  }
  const vertices = new Float32Array(depth.rows * 6);
  const confidence = scores ? new Float32Array(depth.rows) : undefined;
  const min = [Infinity,Infinity,Infinity], max = [-Infinity,-Infinity,-Infinity];
  let point = 0, used = 0;
  for (let byte = 0; byte < mask.rows; byte++) {
    const bits = mask.at(byte, 0);
    for (let bit = 0; bit < 8; bit++) {
      if (!(bits & (1 << bit))) continue;
      const pixel = byte * 8 + bit;
      if (pixel >= pixelCount || point >= depth.rows) throw Error('RGB-D mask and depth counts differ.');
      const src = point++;
      const z = depth.at(src, 0);
      if (!(Number.isFinite(z) && z > 0)) continue;
      const u = pixel % width, v = Math.floor(pixel / width);
      const d = z / (invK[6]*u + invK[7]*v + invK[8]);
      const xw = Math.fround(eye[0] + (rays[0]*u + rays[1]*v + rays[2])*d);
      const yw = Math.fround(eye[1] + (rays[3]*u + rays[4]*v + rays[5])*d);
      const zw = Math.fround(eye[2] + (rays[6]*u + rays[7]*v + rays[8])*d);
      if (!Number.isFinite(xw) || !Number.isFinite(yw) || !Number.isFinite(zw)) continue;
      vertices[used] = xw; vertices[used+1] = yw; vertices[used+2] = zw;
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], vertices[used+axis]);
        max[axis] = Math.max(max[axis], vertices[used+axis]);
        vertices[used+3+axis] = pixels[pixel*4+axis] / 255;
      }
      if (confidence) confidence[used/6] = scores.at(src, 0);
      used += 6;
    }
  }
  if (point !== depth.rows) throw Error('RGB-D mask and depth counts differ.');
  return {vertices: vertices.subarray(0,used), confidence: confidence?.subarray(0,used/6),
    min: used ? min : [0,0,0], max: used ? max : [0,0,0]};
}
