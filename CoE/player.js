// ControlFlow player: plays a ControlFlow presentation (format 1.4, see Schema/README.md)
// in a browser, as the app's presentation mode does. It reads presentation.json next to
// the page (and text.json, the glyph outlines of its text, when there is one, math.json,
// the layouts of its formulas, when there is one, and the pictures of image shapes under
// images/), resolves each keyframe's scene, plays transitions with the same rules as
// ControlFlowCore (Interpolation.swift, VertexMerge.swift) and draws each frame as SVG
// (as SVGWriter.swift does).
//
// The scene code is ported from ControlFlowCore and checked against its test vectors by
// Schema/test_player.js. Keep the two in step: a change to how the app plays or draws
// belongs here too.
//
// In a page it starts itself on the element with id "stage". In Node it only exports
// the scene code (module.exports), for the tests.
(function (root) {
  'use strict';

  // MARK: Values

  function clamp01(v) { return Math.min(Math.max(v, 0), 1); }

  function lerpNumber(a, b, p) { return a === b ? b : a + (b - a) * p; }

  function lerpVec(a, b, p) { return [a[0] + (b[0] - a[0]) * p, a[1] + (b[1] - a[1]) * p]; }

  function sameVec(a, b) { return a[0] === b[0] && a[1] === b[1]; }

  /// `#RRGGBB` or `#RRGGBBAA` (the `#` optional) as [r, g, b, a] in 0...1, or null.
  function parseColor(text) {
    if (typeof text !== 'string') return null;
    let s = text.charAt(0) === '#' ? text.slice(1) : text;
    if ((s.length !== 6 && s.length !== 8) || !/^[0-9a-fA-F]+$/.test(s)) return null;
    if (s.length === 6) s += 'FF';
    const channel = (i) => parseInt(s.slice(i, i + 2), 16) / 255;
    return [channel(0), channel(2), channel(4), channel(6)];
  }

  /// `#RRGGBBAA`, uppercase.
  function hexColor(c) {
    let out = '#';
    for (const v of c) {
      const h = Math.round(clamp01(v) * 255).toString(16).toUpperCase();
      out += h.length === 1 ? '0' + h : h;
    }
    return out;
  }

  function sameColor(a, b) { return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]; }

  class FormatError extends Error {}

  function fail(what) { throw new FormatError(what); }

  function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  function present(o, key) { return isObject(o) && o[key] !== undefined && o[key] !== null; }

  function number(o, key, fallback) {
    if (!present(o, key)) return fallback;
    const v = o[key];
    if (typeof v !== 'number' || !isFinite(v)) fail(key + ' is not a number');
    return v;
  }

  function requireNumber(o, key) {
    if (!present(o, key)) fail(key + ' is missing');
    return number(o, key);
  }

  function integer(o, key) {
    if (!present(o, key)) return null;
    const v = number(o, key);
    if (!Number.isInteger(v)) fail(key + ' is not a whole number');
    return v;
  }

  function bool(o, key, fallback) {
    if (!present(o, key)) return fallback;
    if (typeof o[key] !== 'boolean') fail(key + ' is not true or false');
    return o[key];
  }

  function vec(o, key, fallback) {
    if (!present(o, key)) return fallback;
    const v = o[key];
    if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'number' || typeof v[1] !== 'number' ||
        !isFinite(v[0]) || !isFinite(v[1])) fail(key + ' is not an [x, y] pair');
    return [v[0], v[1]];
  }

  function color(o, key, fallback) {
    if (!present(o, key)) return fallback;
    const c = parseColor(o[key]);
    if (!c) fail(key + ' is not a #RRGGBBAA color');
    return c;
  }

  function keyword(o, key, allowed, fallback) {
    if (!present(o, key)) return fallback;
    if (allowed.indexOf(o[key]) < 0) fail(key + ' is not one of ' + allowed.join(', '));
    return o[key];
  }

  // MARK: Reading scene objects (SceneJSON's readers)

  function identity() { return { position: [0, 0], rotation: 0, scale: [1, 1], pivot: [0, 0] }; }

  function readTransform(o) {
    if (!isObject(o)) return identity();
    return { position: vec(o, 'position', [0, 0]), rotation: number(o, 'rotation', 0),
      scale: vec(o, 'scale', [1, 1]), pivot: vec(o, 'pivot', [0, 0]) };
  }

  function readID(o) {
    const id = integer(o, 'id');
    if (id === null || id <= 0) fail('id is not a positive id');
    return id;
  }

  function readLayerProps(o, layer) { layer.transform = readTransform(o.transform); }

  function readGroupProps(o, group) {
    group.clipped = bool(o, 'clipped', false);
    group.transform = readTransform(o.transform);
  }

  /// Everything of a shape but its id, hints and points. `context` holds the global
  /// colors' ids and the ids of the layer's groups.
  function readShapeProps(o, shape, context) {
    const group = integer(o, 'group');
    shape.group = group !== null && context.groups.has(group) ? group : null;
    shape.closed = bool(o, 'closed', false);
    shape.fill = color(o, 'fill', null);
    shape.fillGlobal = null;
    shape.gradient = null;
    if (shape.fill) {
      const global = integer(o, 'fillGlobal');
      shape.fillGlobal = global !== null && context.globals.has(global) ? global : null;
      shape.gradient = present(o, 'gradient') ? readGradient(o.gradient) : null;
    }
    shape.stroke = present(o, 'stroke') ? readStroke(o.stroke, context) : null;
    shape.opacity = clamp01(number(o, 'opacity', 1));
    shape.clipped = bool(o, 'clipped', false);
    shape.transform = readTransform(o.transform);
    shape.text = present(o, 'text') ? readText(o.text) : null;
    shape.math = present(o, 'math') ? readMath(o.math) : null;
    shape.image = present(o, 'image') ? readImage(o.image) : null;
  }

  /// SceneJSON.readImage: a file directly in images/.
  function readImage(o) {
    if (!isObject(o) || typeof o.src !== 'string') fail('an image has no src');
    const name = o.src.slice('images/'.length);
    if (o.src.indexOf('images/') !== 0 || !name || /[\/\\]/.test(name) || name === '.' || name === '..') {
      fail('an image src is not a file in images/');
    }
    return { src: o.src };
  }

  /// SceneJSON.readMath.
  function readMath(o) {
    if (!isObject(o)) fail('math is not an object');
    if (typeof o.source !== 'string') fail('a formula has no source');
    const math = { source: o.source };
    const size = number(o, 'size', 72);
    if (!(size > 0)) fail('a formula size is not positive');
    math.size = Math.min(Math.max(size, 1), 2000);
    math.display = bool(o, 'display', true);
    return math;
  }

  /// SceneJSON.readText.
  function readText(o) {
    if (!isObject(o)) fail('text is not an object');
    if (typeof o.string !== 'string') fail('a text has no string');
    const text = { string: o.string };
    text.font = typeof o.font === 'string' && o.font ? o.font : 'system';
    const weight = integer(o, 'weight');
    text.weight = weight === null ? 400 : Math.min(Math.max(weight, 100), 900);
    text.weights = present(o, 'weights') ? readWeights(o.weights, text) : [];
    text.italic = bool(o, 'italic', false);
    const size = number(o, 'size', 72);
    if (!(size > 0)) fail('a text size is not positive');
    text.size = Math.min(Math.max(size, 1), 2000);
    text.align = keyword(o, 'align', ['left', 'center', 'right'], 'left');
    text.width = null;
    if (present(o, 'width')) {
      text.width = number(o, 'width');
      if (!(text.width > 0)) fail('a text width is not positive');
    }
    text.lineHeight = Math.min(Math.max(number(o, 'lineHeight', 1.2), 0.1), 10);
    text.tracking = number(o, 'tracking', 0);
    text.held = null;
    return text;
  }

  /// The `weights` runs of `text`, normalized as TextContent.normalizeWeights does: in
  /// order within the string, apart, none empty or in the text's own weight, the later
  /// of two that overlap winning.
  function readWeights(list, text) {
    if (!Array.isArray(list)) fail('a text\'s weights are not a list');
    const n = text.string.length;
    const clamp = (w) => Math.min(Math.max(w, 100), 900);
    const units = new Array(n).fill(text.weight);
    for (const run of list) {
      if (!isObject(run)) fail('a text weight run is not an object');
      const start = integer(run, 'start'), length = integer(run, 'length'), weight = integer(run, 'weight');
      if (start === null || length === null || weight === null) fail('a text weight run is missing start, length or weight');
      if (start < 0 || length < 0) fail('a text weight run is negative');
      for (let i = Math.min(start, n); i < Math.min(start + length, n); i++) units[i] = clamp(weight);
    }
    const out = [];
    for (let i = 0; i < n;) {
      let j = i + 1;
      while (j < n && units[j] === units[i]) j++;
      if (units[i] !== text.weight) out.push({ start: i, length: j - i, weight: units[i] });
      i = j;
    }
    return out;
  }

  function readVertexProps(o, point) {
    point.p = vec(o, 'p', null);
    if (!point.p) fail('p is missing');
    point.in = vec(o, 'in', [0, 0]);
    point.out = vec(o, 'out', [0, 0]);
    point.w = number(o, 'w', 1);
    if (point.w < 0) fail('w is negative');
    point.smooth = bool(o, 'smooth', true);
    point.symmetric = point.smooth && bool(o, 'symmetric', false);
    point.stroked = bool(o, 'stroked', true);
  }

  function readStroke(o, context) {
    if (!isObject(o)) fail('stroke is not an object');
    const width = requireNumber(o, 'width');
    if (width < 0) fail('width is negative');
    const c = color(o, 'color', null);
    if (!c) fail('color is missing');
    const global = integer(o, 'global');
    const stroke = {
      color: c, global: global !== null && context.globals.has(global) ? global : null, width,
      cap: keyword(o, 'cap', ['butt', 'round', 'square'], 'round'),
      join: keyword(o, 'join', ['miter', 'round', 'bevel'], 'round'),
      miterLimit: number(o, 'miterLimit', 4), dash: [], dashOffset: 0, align: 'center',
    };
    if (stroke.miterLimit < 1) fail('miterLimit is less than 1');
    if (present(o, 'dash')) {
      if (!Array.isArray(o.dash)) fail('dash is not an array');
      stroke.dash = o.dash.map((v) => {
        if (typeof v !== 'number' || !isFinite(v)) fail('dash is not a list of numbers');
        if (v < 0) fail('dash is negative');
        return v;
      });
    }
    stroke.dashOffset = number(o, 'dashOffset', 0);
    stroke.align = keyword(o, 'align', ['center', 'inside', 'outside'], 'center');
    return stroke;
  }

  function readGradient(o) {
    if (!isObject(o) || !Array.isArray(o.stops)) fail('gradient has no stops');
    const stops = o.stops.map((s) => {
      const c = color(s, 'color', null);
      if (!c) fail('a gradient stop has no color');
      return { offset: clamp01(requireNumber(s, 'offset')), color: c };
    });
    if (stops.length === 0) fail('gradient stops is empty');
    const start = vec(o, 'start', null), end = vec(o, 'end', null);
    if (!start || !end) fail('gradient has no start or end');
    const type = keyword(o, 'type', ['linear', 'radial'], null);
    if (!type) fail('gradient has no type');
    return { type, start, end, stops };
  }

  function readLayer(o, context) {
    if (!isObject(o)) fail('a layer is not an object');
    const layer = { id: readID(o), name: typeof o.name === 'string' ? o.name : 'Layer' };
    readLayerProps(o, layer);
    layer.hidden = bool(o, 'hidden', false);
    layer.locked = bool(o, 'locked', false);
    layer.groups = (Array.isArray(o.groups) ? o.groups : []).map(readGroup);
    const inner = { globals: context.globals, groups: new Set(layer.groups.map((g) => g.id)) };
    layer.shapes = (Array.isArray(o.shapes) ? o.shapes : []).map((s) => readShape(s, inner));
    return layer;
  }

  function readGroup(o) {
    if (!isObject(o)) fail('a group is not an object');
    const group = { id: readID(o), name: typeof o.name === 'string' ? o.name : 'Group' };
    readGroupProps(o, group);
    return group;
  }

  function readShape(o, context) {
    if (!isObject(o)) fail('a shape is not an object');
    const shape = { id: readID(o) };
    readShapeProps(o, shape, context);
    shape.hidden = bool(o, 'hidden', false);
    shape.locked = bool(o, 'locked', false);
    if (!Array.isArray(o.points)) fail('points is missing');
    shape.points = o.points.map(readVertex);
    return shape;
  }

  function readVertex(o) {
    if (!isObject(o)) fail('a point is not an object');
    const point = { id: readID(o) };
    readVertexProps(o, point);
    return point;
  }

  // MARK: Writing scene objects (SceneJSON's writers)

  function transformJSON(t) {
    // Compared as written (to 4 decimals), as the app does.
    const same = (a, b) => Math.abs(a - b) < 0.00005;
    const out = {};
    if (!same(t.position[0], 0) || !same(t.position[1], 0)) out.position = t.position.slice();
    if (!same(t.rotation, 0)) out.rotation = t.rotation;
    if (!same(t.scale[0], 1) || !same(t.scale[1], 1)) out.scale = t.scale.slice();
    if (!same(t.pivot[0], 0) || !same(t.pivot[1], 0)) out.pivot = t.pivot.slice();
    return Object.keys(out).length ? out : null;
  }

  function layerProps(layer) {
    const out = {};
    const t = transformJSON(layer.transform);
    if (t) out.transform = t;
    return out;
  }

  function groupProps(group) {
    const out = {};
    if (group.clipped) out.clipped = true;
    const t = transformJSON(group.transform);
    if (t) out.transform = t;
    return out;
  }

  function shapeProps(shape) {
    const out = {};
    if (shape.group !== null) out.group = shape.group;
    out.closed = shape.closed;
    if (shape.text) out.text = textJSON(shape.text);
    if (shape.math) out.math = mathJSON(shape.math);
    if (shape.image) out.image = { src: shape.image.src };
    if (shape.fill) {
      out.fill = hexColor(shape.fill);
      if (shape.fillGlobal !== null) out.fillGlobal = shape.fillGlobal;
      if (shape.gradient) out.gradient = gradientJSON(shape.gradient);
    }
    if (shape.stroke) out.stroke = strokeJSON(shape.stroke);
    if (shape.opacity !== 1) out.opacity = shape.opacity;
    if (shape.clipped) out.clipped = true;
    const t = transformJSON(shape.transform);
    if (t) out.transform = t;
    return out;
  }

  /// SceneJSON.text: the string, and the style where it isn't the default. Never `held`.
  function textJSON(text) {
    const out = { string: text.string };
    if (text.font !== 'system') out.font = text.font;
    if (text.weight !== 400) out.weight = text.weight;
    if (text.weights.length) out.weights = text.weights.map((r) => ({ start: r.start, length: r.length, weight: r.weight }));
    if (text.italic) out.italic = true;
    if (text.size !== 72) out.size = text.size;
    if (text.align !== 'left') out.align = text.align;
    if (text.width !== null) out.width = text.width;
    if (text.lineHeight !== 1.2) out.lineHeight = text.lineHeight;
    if (text.tracking !== 0) out.tracking = text.tracking;
    return out;
  }

  /// SceneJSON.math: the source, and the size and style where they aren't the default.
  function mathJSON(math) {
    const out = { source: math.source };
    if (math.size !== 72) out.size = math.size;
    if (!math.display) out.display = false;
    return out;
  }

  function vertexProps(point) {
    const out = { p: point.p.slice(), in: point.in.slice(), out: point.out.slice() };
    if (point.w !== 1) out.w = point.w;
    if (!point.smooth) out.smooth = false;
    if (point.smooth && point.symmetric) out.symmetric = true;
    if (!point.stroked) out.stroked = false;
    return out;
  }

  function strokeJSON(stroke) {
    const out = { color: hexColor(stroke.color) };
    if (stroke.global !== null) out.global = stroke.global;
    out.width = stroke.width;
    if (stroke.cap !== 'round') out.cap = stroke.cap;
    if (stroke.join !== 'round') out.join = stroke.join;
    if (stroke.miterLimit !== 4) out.miterLimit = stroke.miterLimit;
    if (stroke.dash.length) {
      out.dash = stroke.dash.slice();
      if (stroke.dashOffset !== 0) out.dashOffset = stroke.dashOffset;
    }
    if (stroke.align !== 'center') out.align = stroke.align;
    return out;
  }

  function gradientJSON(gradient) {
    return { type: gradient.type, start: gradient.start.slice(), end: gradient.end.slice(),
      stops: gradient.stops.map((s) => ({ offset: s.offset, color: hexColor(s.color) })) };
  }

  function hints(object, out) {
    if (object.hidden) out.hidden = true;
    if (object.locked) out.locked = true;
    return out;
  }

  function layerJSON(layer) {
    const out = Object.assign({ id: layer.id, name: layer.name }, layerProps(layer));
    hints(layer, out);
    if (layer.groups.length) out.groups = layer.groups.map(groupJSON);
    out.shapes = layer.shapes.map(shapeJSON);
    return out;
  }

  function groupJSON(group) { return Object.assign({ id: group.id, name: group.name }, groupProps(group)); }

  function shapeJSON(shape) {
    const out = Object.assign({ id: shape.id }, shapeProps(shape));
    hints(shape, out);
    out.points = shape.points.map(vertexJSON);
    return out;
  }

  function vertexJSON(point) { return Object.assign({ id: point.id }, vertexProps(point)); }

  /// A scene as the test vectors write it: the viewport's background, the global colors
  /// and the layers, in the file's JSON.
  function sceneJSON(scene) {
    return {
      background: hexColor(scene.viewport.background),
      globalColors: scene.globalColors.map((g) => ({ id: g.id, name: g.name, color: hexColor(g.color) })),
      layers: scene.layers.map(layerJSON),
    };
  }

  // MARK: Property paths (PropertyPath.apply)

  /// `value` with the dotted `parts` from `i` set to `next`: null removes the key, and
  /// missing objects on the way are made. Undefined when the path doesn't fit.
  function setPath(value, parts, i, next) {
    if (i === parts.length) return next;
    const key = parts[i], last = i === parts.length - 1;
    if (isObject(value)) {
      const out = Object.assign({}, value);
      if (Object.prototype.hasOwnProperty.call(out, key)) {
        if (last && next === null) {
          delete out[key];
        } else {
          const child = setPath(out[key], parts, i + 1, next);
          if (child === undefined) return undefined;
          out[key] = child;
        }
      } else if (!(last && next === null)) {
        const child = setPath({}, parts, i + 1, next);
        if (child === undefined) return undefined;
        out[key] = child;
      }
      return out;
    }
    if (Array.isArray(value)) {
      if (!/^\+?\d+$/.test(key)) return undefined;
      const index = parseInt(key, 10);
      if (index >= value.length || (last && next === null)) return undefined;
      const child = setPath(value[index], parts, i + 1, next);
      if (child === undefined) return undefined;
      const out = value.slice();
      out[index] = child;
      return out;
    }
    return undefined;
  }

  function applyProps(props, object) {
    let result = object;
    for (const key of Object.keys(props)) {
      const parts = key.split('.');
      if (parts.some((p) => p === '')) return undefined;
      result = setPath(result, parts, 0, props[key]);
      if (result === undefined) return undefined;
    }
    return result;
  }

  // MARK: Scenes

  function clone(v) {
    if (Array.isArray(v)) return v.map(clone);
    if (isObject(v)) {
      const out = {};
      for (const k of Object.keys(v)) out[k] = clone(v[k]);
      return out;
    }
    return v;
  }

  /// Where object `id` is in `scene`: its kind and indices, or null.
  function locate(scene, id) {
    if (scene.viewport.id === id) return { kind: 'viewport' };
    for (let g = 0; g < scene.globalColors.length; g++) {
      if (scene.globalColors[g].id === id) return { kind: 'globalColor', g };
    }
    for (let l = 0; l < scene.layers.length; l++) {
      const layer = scene.layers[l];
      if (layer.id === id) return { kind: 'layer', l };
      for (let g = 0; g < layer.groups.length; g++) if (layer.groups[g].id === id) return { kind: 'group', l, g };
      for (let s = 0; s < layer.shapes.length; s++) {
        const shape = layer.shapes[s];
        if (shape.id === id) return { kind: 'shape', l, s };
        for (let p = 0; p < shape.points.length; p++) if (shape.points[p].id === id) return { kind: 'vertex', l, s, p };
      }
    }
    return null;
  }

  function allIDs(kind, object) {
    switch (kind) {
      case 'layer': {
        let ids = [object.id].concat(object.groups.map((g) => g.id));
        for (const s of object.shapes) ids = ids.concat(allIDs('shape', s));
        return ids;
      }
      case 'shape': return [object.id].concat(object.points.map((p) => p.id));
      default: return [object.id];
    }
  }

  const settable = {
    viewport: ['background'], globalColor: ['color'], layer: ['transform'], group: ['clipped', 'transform'],
    shape: ['group', 'closed', 'fill', 'fillGlobal', 'gradient', 'stroke', 'opacity', 'clipped', 'transform', 'text', 'math', 'image'],
    vertex: ['p', 'in', 'out', 'w', 'smooth', 'symmetric', 'stroked'],
  };

  function globalIDs(scene) { return new Set(scene.globalColors.map((g) => g.id)); }

  function insertionIndex(after, ids) {
    if (after === null || after === undefined) return 0;
    const i = ids.indexOf(after);
    return i >= 0 ? i + 1 : ids.length;
  }

  /// `items` with those listed in `ids` put in that order, in the places the listed ones held.
  function reordered(items, ids) {
    const listed = new Set(ids);
    const byID = new Map(items.filter((x) => listed.has(x.id)).map((x) => [x.id, x]));
    const queue = ids.filter((id) => byID.has(id)).map((id) => byID.get(id));
    let next = 0;
    return items.map((x) => (listed.has(x.id) ? queue[next++] : x));
  }

  /// Applies one change (as the file holds it) to `scene` in place. Returns false,
  /// changing nothing, when it doesn't apply (Drawing.apply in SceneDiff.swift).
  function applyChange(scene, change) {
    if (!isObject(change)) return false;
    try {
      if (present(change, 'set')) return applySet(scene, change);
      if (present(change, 'create')) return applyCreate(scene, change);
      if (present(change, 'delete')) return applyDelete(scene, change);
      if (present(change, 'order')) return applyOrder(scene, change);
    } catch (e) {
      if (e instanceof FormatError) return false;
      throw e;
    }
    return false;
  }

  function applySet(scene, change) {
    const where = locate(scene, change.set);
    if (!where || !isObject(change.props)) return false;
    const props = change.props;
    if (!Object.keys(props).every((k) => settable[where.kind].indexOf(k.split('.')[0]) >= 0)) return false;
    const patched = (members) => applyProps(props, members);
    switch (where.kind) {
      case 'viewport': {
        const node = patched({ background: hexColor(scene.viewport.background) });
        if (!node) return false;
        scene.viewport.background = color(node, 'background', [1, 1, 1, 1]);
        return true;
      }
      case 'globalColor': {
        const global = scene.globalColors[where.g];
        const node = patched({ color: hexColor(global.color) });
        if (!node) return false;
        const c = color(node, 'color', null);
        if (!c) return false;
        global.color = c;
        return true;
      }
      case 'layer': {
        const layer = scene.layers[where.l];
        const node = patched(layerProps(layer));
        if (!node) return false;
        readLayerProps(node, layer);
        return true;
      }
      case 'group': {
        const group = scene.layers[where.l].groups[where.g];
        const node = patched(groupProps(group));
        if (!node) return false;
        const next = Object.assign({}, group);
        readGroupProps(node, next);
        scene.layers[where.l].groups[where.g] = next;
        return true;
      }
      case 'shape': {
        const layer = scene.layers[where.l];
        const node = patched(shapeProps(layer.shapes[where.s]));
        if (!node) return false;
        const next = Object.assign({}, layer.shapes[where.s]);
        readShapeProps(node, next, { globals: globalIDs(scene), groups: new Set(layer.groups.map((g) => g.id)) });
        layer.shapes[where.s] = next;
        return true;
      }
      case 'vertex': {
        const points = scene.layers[where.l].shapes[where.s].points;
        const node = patched(vertexProps(points[where.p]));
        if (!node) return false;
        const next = Object.assign({}, points[where.p]);
        readVertexProps(node, next);
        points[where.p] = next;
        return true;
      }
    }
    return false;
  }

  function applyCreate(scene, change) {
    let parent = null;
    if (present(change, 'in')) {
      parent = locate(scene, change.in);
      if (!parent) return false;
    }
    const after = integer(change, 'after'), before = integer(change, 'before');
    const node = change.create;
    let kind, object;
    if (!parent) {
      kind = 'layer';
      object = readLayer(node, { globals: globalIDs(scene), groups: new Set() });
    } else if (parent.kind === 'layer') {
      const context = { globals: globalIDs(scene), groups: new Set(scene.layers[parent.l].groups.map((g) => g.id)) };
      if (present(node, 'points')) {
        kind = 'shape';
        object = readShape(node, context);
      } else {
        kind = 'group';
        object = readGroup(node);
      }
    } else if (parent.kind === 'shape') {
      kind = 'vertex';
      object = readVertex(node);
    } else {
      return false;
    }
    if (allIDs(kind, object).some((id) => id <= 0 || locate(scene, id))) return false;
    switch (kind) {
      case 'layer':
        scene.layers.splice(insertionIndex(after, scene.layers.map((l) => l.id)), 0, object);
        break;
      case 'group':
        scene.layers[parent.l].groups.push(object);
        break;
      case 'shape': {
        const shapes = scene.layers[parent.l].shapes;
        shapes.splice(insertionIndex(after, shapes.map((s) => s.id)), 0, object);
        break;
      }
      case 'vertex': {
        const points = scene.layers[parent.l].shapes[parent.s].points;
        const ids = points.map((p) => p.id);
        let index = insertionIndex(after, ids);
        if (after !== null && ids.indexOf(after) < 0 && before !== null && ids.indexOf(before) >= 0) index = ids.indexOf(before);
        points.splice(index, 0, object);
        break;
      }
    }
    return true;
  }

  function applyDelete(scene, change) {
    const where = locate(scene, change.delete);
    if (!where) return false;
    switch (where.kind) {
      case 'layer':
        scene.layers.splice(where.l, 1);
        return true;
      case 'group': {
        const layer = scene.layers[where.l];
        const id = layer.groups[where.g].id;
        layer.groups.splice(where.g, 1);
        layer.shapes = layer.shapes.map((s) => (s.group === id ? Object.assign({}, s, { group: null }) : s));
        return true;
      }
      case 'shape':
        scene.layers[where.l].shapes.splice(where.s, 1);
        return true;
      case 'vertex':
        scene.layers[where.l].shapes[where.s].points.splice(where.p, 1);
        return true;
    }
    return false;
  }

  function applyOrder(scene, change) {
    const ids = change.order;
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length) return false;
    if (!present(change, 'in')) {
      scene.layers = reordered(scene.layers, ids);
      return true;
    }
    const where = locate(scene, change.in);
    if (!where) return false;
    if (where.kind === 'layer') {
      scene.layers[where.l].shapes = reordered(scene.layers[where.l].shapes, ids);
      return true;
    }
    if (where.kind === 'shape') {
      const shape = scene.layers[where.l].shapes[where.s];
      shape.points = reordered(shape.points, ids);
      return true;
    }
    return false;
  }

  /// Fills and outlines that follow a global color take its color (and a gradient its
  /// first stop); a link to a global color that isn't there is dropped.
  function syncGlobalColors(scene) {
    const colors = new Map(scene.globalColors.map((g) => [g.id, g.color]));
    for (const layer of scene.layers) {
      if (!layer.shapes.some((s) => s.fillGlobal !== null || (s.stroke && s.stroke.global !== null))) continue;
      layer.shapes = layer.shapes.map((shape) => {
        let out = shape;
        const edit = () => { if (out === shape) out = Object.assign({}, shape); return out; };
        if (shape.fillGlobal !== null) {
          const c = colors.get(shape.fillGlobal);
          if (c) {
            if (shape.fill) {
              edit().fill = c;
              if (shape.gradient && shape.gradient.stops.length) {
                const stops = shape.gradient.stops.slice();
                stops[0] = { offset: stops[0].offset, color: c };
                out.gradient = Object.assign({}, shape.gradient, { stops });
              }
            }
          } else {
            edit().fillGlobal = null;
          }
        }
        if (shape.stroke && shape.stroke.global !== null) {
          const c = colors.get(shape.stroke.global);
          edit().stroke = Object.assign({}, shape.stroke, c ? { color: c } : { global: null });
        }
        return out;
      });
    }
  }

  function groupsAreValid(scene) {
    const ids = new Set();
    for (const layer of scene.layers) {
      for (const group of layer.groups) {
        if (ids.has(group.id)) return false;
        ids.add(group.id);
        const members = [];
        layer.shapes.forEach((s, i) => { if (s.group === group.id) members.push(i); });
        if (!members.length || members[members.length - 1] - members[0] + 1 !== members.length) return false;
      }
      const known = new Set(layer.groups.map((g) => g.id));
      if (layer.shapes.some((s) => s.group !== null && !known.has(s.group))) return false;
    }
    return true;
  }

  /// Drops empty groups and links to missing ones, and splits a group whose shapes
  /// aren't together into one per run (DrawingEditor+Layers.swift, repairGroups).
  function repairGroups(scene) {
    const seen = new Set();
    for (const layer of scene.layers) {
      const groups = [];
      for (const g of layer.groups) if (!groups.some((x) => x.id === g.id)) groups.push(g);
      const known = new Set(groups.map((g) => g.id));
      layer.shapes = layer.shapes.map((s) => (s.group !== null && !known.has(s.group) ? Object.assign({}, s, { group: null }) : s));
      const repaired = [];
      for (const group of groups) {
        const runs = [];
        layer.shapes.forEach((s, i) => {
          if (s.group !== group.id) return;
          const run = runs[runs.length - 1];
          if (run && run[run.length - 1] === i - 1) run.push(i); else runs.push([i]);
        });
        runs.forEach((run, k) => {
          const id = k === 0 && !seen.has(group.id) ? group.id : scene.nextID++;
          seen.add(id);
          repaired.push({ id, name: group.name, clipped: group.clipped, transform: identity() });
          for (const i of run) layer.shapes[i] = Object.assign({}, layer.shapes[i], { group: id });
        });
      }
      layer.groups = repaired;
    }
  }

  function applyKeyframe(scene, changes) {
    if (!changes.length) return;
    for (const change of changes) applyChange(scene, change);
    syncGlobalColors(scene);
    if (!groupsAreValid(scene)) repairGroups(scene);
  }

  // MARK: Timing curves (TimingCurve in Presentation.swift)

  const namedCurves = {
    'linear': [0, 0, 1, 1], 'ease': [0.25, 0.1, 0.25, 1], 'ease-in': [0.42, 0, 1, 1],
    'ease-out': [0, 0, 0.58, 1], 'ease-in-out': [0.42, 0, 0.58, 1],
  };

  function readCurve(value) {
    if (value === undefined || value === null) return { linear: false, points: namedCurves['ease-in-out'] };
    if (typeof value === 'string') {
      if (!namedCurves[value]) fail('curve is not a named curve');
      return { linear: value === 'linear', points: namedCurves[value] };
    }
    if (!Array.isArray(value) || value.length !== 4 || value.some((v) => typeof v !== 'number' || !isFinite(v))) {
      fail('curve is not one of the named curves or [x1, y1, x2, y2]');
    }
    if (value[0] < 0 || value[0] > 1 || value[2] < 0 || value[2] > 1) fail('curve has an x outside 0...1');
    return { linear: false, points: [clamp01(value[0]), value[1], clamp01(value[2]), value[3]] };
  }

  /// The progress at time fraction `x`: the curve's y where its x is `x`.
  function progress(curve, x) {
    x = clamp01(isFinite(x) ? x : 1);
    if (x === 0) return 0;
    if (x === 1) return 1;
    if (curve.linear) return x;
    const [x1, y1, x2, y2] = curve.points;
    const bezier = (s, a, b) => { const ms = 1 - s; return 3 * ms * ms * s * a + 3 * ms * s * s * b + s * s * s; };
    const slope = (s, a, b) => { const ms = 1 - s; return 3 * ms * ms * a + 6 * ms * s * (b - a) + 3 * s * s * (1 - b); };
    let s = x;
    for (let i = 0; i < 8; i++) {
      const error = bezier(s, x1, x2) - x;
      if (Math.abs(error) < 1e-12) return bezier(s, y1, y2);
      const d = slope(s, x1, x2);
      if (!(Math.abs(d) > 1e-9)) break;
      s = clamp01(s - error / d);
    }
    let lo = 0, hi = 1;
    s = x;
    for (let i = 0; i < 60; i++) {
      const value = bezier(s, x1, x2);
      if (Math.abs(value - x) < 1e-12) break;
      if (value < x) lo = s; else hi = s;
      s = (lo + hi) / 2;
    }
    return bezier(s, y1, y2);
  }

  // MARK: Presentations

  /// Reads presentation.json (already parsed) into the opening scene and the keyframe
  /// chain. Throws a FormatError for a file it can't play.
  function readPresentation(json) {
    if (!isObject(json)) fail('the file is not a JSON object');
    const version = typeof json.formatVersion === 'string' ? json.formatVersion : '1.0';
    if (parseInt(version.split('.')[0], 10) > 1) fail('the file is from a newer version of ControlFlow (' + version + ')');
    const opening = { name: typeof json.name === 'string' ? json.name : 'Untitled' };
    const v = isObject(json.viewport) ? json.viewport : {};
    opening.viewport = {
      id: integer(v, 'id') || 0, width: number(v, 'width', 1920), height: number(v, 'height', 1080),
      background: color(v, 'background', [1, 1, 1, 1]),
    };
    if (!(opening.viewport.width > 0 && opening.viewport.height > 0)) fail('the viewport has no area');
    opening.globalColors = (Array.isArray(json.globalColors) ? json.globalColors : []).map((g) => {
      const c = color(g, 'color', null);
      if (!c) fail('a global color has no color');
      return { id: readID(g), name: typeof g.name === 'string' ? g.name : 'Color', color: c };
    });
    const context = { globals: globalIDs(opening), groups: new Set() };
    const layers = isObject(json.opening) && Array.isArray(json.opening.layers) ? json.opening.layers : [];
    opening.layers = layers.map((l) => readLayer(l, context));
    opening.nextID = 1 + maxID(json);
    if (!groupsAreValid(opening)) repairGroups(opening);
    syncGlobalColors(opening);

    const sequences = [], chain = [null];
    (Array.isArray(json.sequences) ? json.sequences : []).forEach((s, index) => {
      const sequence = { id: integer(s, 'id'), name: typeof s.name === 'string' ? s.name : null, first: chain.length, count: 0 };
      for (const k of (Array.isArray(s.keyframes) ? s.keyframes : [])) {
        const transition = isObject(k.transition) ? k.transition : {};
        const duration = number(transition, 'duration', 0.5);
        if (duration < 0) fail('a transition has a negative duration');
        const changes = Array.isArray(k.changes) ? k.changes : [];
        chain.push({ id: integer(k, 'id'), name: typeof k.name === 'string' ? k.name : null, sequence: index,
          duration, curve: readCurve(transition.curve), changes, parameters: parameters(changes) });
        sequence.count++;
      }
      sequences.push(sequence);
    });
    return { name: opening.name, viewport: opening.viewport, opening, chain, sequences };
  }

  function maxID(value) {
    let most = 0;
    (function walk(v) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (isObject(v)) {
        for (const k of Object.keys(v)) {
          if (k === 'id' && Number.isInteger(v[k])) most = Math.max(most, v[k]);
          else walk(v[k]);
        }
      }
    })(value);
    return most;
  }

  /// The `t` recorded for each vertex a keyframe adds or removes on a segment.
  function parameters(changes) {
    const out = new Map();
    for (const change of changes) {
      if (!isObject(change) || typeof change.t !== 'number' || !isFinite(change.t)) continue;
      if (present(change, 'create') && isObject(change.create) && present(change, 'in') &&
          Number.isInteger(change.create.id) && Array.isArray(change.create.p)) {
        out.set(change.create.id, clamp01(change.t));
      } else if (present(change, 'delete')) {
        out.set(change.delete, clamp01(change.t));
      }
    }
    return out;
  }

  /// The scenes of a presentation, resolved on demand, and its transitions (Timeline.swift).
  class Timeline {
    constructor(presentation) {
      this.presentation = presentation;
      this.states = [presentation.opening];
    }

    get count() { return this.presentation.chain.length; }

    /// The scene at chain index `index` (0 is the opening).
    state(index) {
      index = Math.min(Math.max(index, 0), this.count - 1);
      while (this.states.length <= index) {
        const i = this.states.length;
        const scene = clone(this.states[i - 1]);
        applyKeyframe(scene, this.presentation.chain[i].changes);
        this.states.push(scene);
      }
      return this.states[index];
    }

    /// The scene `elapsed` seconds into the transition into chain index `index`.
    transition(index, elapsed) {
      const keyframe = this.presentation.chain[index];
      if (index <= 0 || !keyframe) return this.state(0);
      const fraction = keyframe.duration > 0 ? elapsed / keyframe.duration : 1;
      const to = this.state(index);
      if (fraction >= 1) return to;
      return interpolateScene(this.state(index - 1), to, Math.max(fraction, 0),
        progress(keyframe.curve, fraction), keyframe.parameters);
    }

    /// The chain indices of sequence `index`, or null when it has none.
    range(index) {
      const s = this.presentation.sequences[index];
      return s && s.count ? { first: s.first, last: s.first + s.count - 1 } : null;
    }

    /// The seconds sequence `index` takes to play.
    duration(index) {
      const r = this.range(index);
      if (!r) return 0;
      let total = 0;
      for (let i = r.first; i <= r.last; i++) total += this.presentation.chain[i].duration;
      return total;
    }

    /// The scene `time` seconds into playing sequence `index` from the end of the one
    /// before, and whether it has reached its last keyframe.
    playing(index, time) {
      const r = this.range(index);
      if (!r) return { scene: this.state(0), finished: true };
      let remaining = Math.max(isFinite(time) ? time : 0, 0);
      for (let i = r.first; i <= r.last; i++) {
        const d = this.presentation.chain[i].duration;
        if (remaining < d) return { scene: this.transition(i, remaining), finished: false };
        remaining -= d;
      }
      return { scene: this.state(r.last), finished: true };
    }

    /// The scene once the first `count` sequences have played.
    stateAfter(count) {
      const sequences = this.presentation.sequences;
      let index = 0;
      for (let i = 0; i < Math.min(Math.max(count, 0), sequences.length); i++) index += sequences[i].count;
      return this.state(index);
    }
  }

  // MARK: Curves (CubicBezier in BezierPath.swift)

  function bezierPoint(c, t) {
    const mt = 1 - t;
    const a = mt * mt * mt, b = 3 * mt * mt * t, d = 3 * mt * t * t, e = t * t * t;
    return [a * c[0][0] + b * c[1][0] + d * c[2][0] + e * c[3][0], a * c[0][1] + b * c[1][1] + d * c[2][1] + e * c[3][1]];
  }

  function splitBezier(c, t) {
    const a = lerpVec(c[0], c[1], t), b = lerpVec(c[1], c[2], t), d = lerpVec(c[2], c[3], t);
    const e = lerpVec(a, b, t), f = lerpVec(b, d, t);
    const g = lerpVec(e, f, t);
    return [[c[0], a, e, g], [g, f, d, c[3]]];
  }

  function distance(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

  /// The curve parameter nearest `p`.
  function nearestT(c, p) {
    const samples = 24;
    let bestT = 0, best = Infinity;
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const d = distance(bezierPoint(c, t), p);
      if (d < best) { best = d; bestT = t; }
    }
    let lo = Math.max(0, bestT - 1 / samples), hi = Math.min(1, bestT + 1 / samples);
    const g = 0.61803398875;
    for (let i = 0; i < 20; i++) {
      const m1 = hi - (hi - lo) * g, m2 = lo + (hi - lo) * g;
      if (distance(bezierPoint(c, m1), p) < distance(bezierPoint(c, m2), p)) hi = m2; else lo = m1;
    }
    const t = (lo + hi) / 2;
    return distance(bezierPoint(c, t), p) < best ? t : bestT;
  }

  function outControl(point) { return [point.p[0] + point.out[0], point.p[1] + point.out[1]]; }
  function inControl(point) { return [point.p[0] + point.in[0], point.p[1] + point.in[1]]; }
  function minus(a, b) { return [a[0] - b[0], a[1] - b[1]]; }

  // MARK: Vertex merge (VertexMerge.swift)

  /// A shape's points at both ends of a transition, lined up one to one, or null when
  /// they can't be merged.
  function mergeVertices(a, b, parameterOf) {
    if (a.closed !== b.closed) return null;
    const A = a.points, B = b.points;
    const aIndex = new Map(), bIDs = new Set();
    for (let i = 0; i < A.length; i++) {
      if (aIndex.has(A[i].id)) return null;
      aIndex.set(A[i].id, i);
    }
    for (const p of B) {
      if (bIDs.has(p.id)) return null;
      bIDs.add(p.id);
    }
    const matchedB = [];
    for (let j = 0; j < B.length; j++) if (aIndex.has(B[j].id)) matchedB.push(j);
    if (!matchedB.length) return null;
    const matchedA = matchedB.map((j) => aIndex.get(B[j].id));
    const m = matchedB.length;
    let descents = 0;
    for (let i = 0; i < m; i++) {
      const next = i + 1 < m ? matchedA[i + 1] : (b.closed ? matchedA[0] : Infinity);
      if (next <= matchedA[i]) descents++;
    }
    if (b.closed ? !(m === 1 || descents === 1) : descents !== 0) return null;

    const fromB = B.map((p) => (aIndex.has(p.id) ? Object.assign({}, A[aIndex.get(p.id)]) : null));
    const toB = B.map((p) => Object.assign({}, p));
    const dyingAfter = new Map();

    const between = (start, end, n) => {
      const out = [];
      let i = (start + 1) % n;
      while (i !== end) { out.push(i); i = (i + 1) % n; }
      return out;
    };
    const around = (count, start) => {
      const out = [];
      for (let i = 0; i < count; i++) if (i !== start) out.push(i);
      return out.sort((x, y) => ((x - start + count) % count) - ((y - start + count) % count));
    };
    const standIn = (position, inHandle, outHandle, like) => ({
      id: like.id, p: position, in: inHandle, out: outHandle, w: 1, smooth: like.smooth, symmetric: like.symmetric,
      stroked: like.stroked,
    });

    for (let g = 0; g < (b.closed ? m : m - 1); g++) {
      const jS = matchedB[g], jE = matchedB[(g + 1) % m];
      const iS = matchedA[g], iE = matchedA[(g + 1) % m];
      const born = m === 1 ? around(B.length, jS) : between(jS, jE, B.length);
      const dying = m === 1 ? around(A.length, iS) : between(iS, iE, A.length);
      if (born.length && dying.length) return null;
      if (born.length) {
        let segment = [A[iS].p, outControl(A[iS]), inControl(A[iE]), A[iE].p];
        let previous = jS;
        for (const j of born) {
          const raw = parameterOf(B[j].id, segment, B[j].p);
          if (raw === null || raw === undefined) return null;
          const t = clamp01(raw);
          const [l, r] = splitBezier(segment, t);
          fromB[previous].out = minus(l[1], l[0]);
          const point = standIn(l[3], minus(l[2], l[3]), minus(r[1], r[0]), B[j]);
          point.w = fromB[previous].w + (A[iE].w - fromB[previous].w) * t;
          fromB[j] = point;
          segment = r;
          previous = j;
        }
        fromB[jE].in = minus(segment[2], segment[3]);
      } else if (dying.length) {
        let segment = [B[jS].p, outControl(B[jS]), inControl(B[jE]), B[jE].p];
        const entries = [];
        let previousWidth = B[jS].w;
        for (const i of dying) {
          const raw = parameterOf(A[i].id, segment, A[i].p);
          if (raw === null || raw === undefined) return null;
          const t = clamp01(raw);
          const [l, r] = splitBezier(segment, t);
          if (!entries.length) toB[jS].out = minus(l[1], l[0]); else entries[entries.length - 1][1].out = minus(l[1], l[0]);
          const point = standIn(l[3], minus(l[2], l[3]), minus(r[1], r[0]), A[i]);
          point.w = previousWidth + (B[jE].w - previousWidth) * t;
          previousWidth = point.w;
          entries.push([A[i], point]);
          segment = r;
        }
        toB[jE].in = minus(segment[2], segment[3]);
        dyingAfter.set(jS, entries);
      }
    }

    if (!b.closed) {
      const stub = (point, anchor) => {
        const p = standIn(anchor.p.slice(), [0, 0], [0, 0], point);
        p.w = anchor.w;
        return p;
      };
      const j0 = matchedB[0], i0 = matchedA[0], jL = matchedB[m - 1], iL = matchedA[m - 1];
      const range = (lo, hi) => { const out = []; for (let i = lo; i < hi; i++) out.push(i); return out; };
      const leadBorn = range(0, j0), leadDying = range(0, i0);
      const tailBorn = range(jL + 1, B.length), tailDying = range(iL + 1, A.length);
      if (leadBorn.length && leadDying.length) return null;
      if (tailBorn.length && tailDying.length) return null;
      for (const j of leadBorn.concat(tailBorn)) fromB[j] = stub(B[j], A[j < j0 ? i0 : iL]);
      if (leadDying.length) dyingAfter.set(-1, leadDying.map((i) => [A[i], stub(A[i], B[j0])]));
      if (tailDying.length) dyingAfter.set(jL, (dyingAfter.get(jL) || []).concat(tailDying.map((i) => [A[i], stub(A[i], B[jL])])));
    }

    const from = [], to = [];
    for (const [x, y] of dyingAfter.get(-1) || []) { from.push(x); to.push(y); }
    for (let j = 0; j < B.length; j++) {
      from.push(fromB[j]);
      to.push(toB[j]);
      for (const [x, y] of dyingAfter.get(j) || []) { from.push(x); to.push(y); }
    }
    return { from, to };
  }

  /// No merge: the new points, each matched vertex starting from where it was.
  function fallbackVertices(a, b) {
    const old = new Map();
    for (const p of a.points) if (!old.has(p.id)) old.set(p.id, p);
    return { from: b.points.map((p) => old.get(p.id) || p), to: b.points };
  }

  // MARK: Interpolation (Interpolation.swift)

  function lerpColor(a, b, p) {
    if (sameColor(a, b)) return b;
    return [clamp01(lerpNumber(a[0], b[0], p)), clamp01(lerpNumber(a[1], b[1], p)),
      clamp01(lerpNumber(a[2], b[2], p)), clamp01(lerpNumber(a[3], b[3], p))];
  }

  /// A scale overshooting past zero keeps the sign both ends share.
  function lerpScale(a, b, p) {
    const v = lerpNumber(a, b, p);
    if (a >= 0 && b >= 0) return Math.max(v, 0);
    if (a <= 0 && b <= 0) return Math.min(v, 0);
    return v;
  }

  function sameTransform(a, b) {
    return sameVec(a.position, b.position) && a.rotation === b.rotation && sameVec(a.scale, b.scale) && sameVec(a.pivot, b.pivot);
  }

  function lerpTransform(a, b, p) {
    if (sameTransform(a, b)) return b;
    return { position: lerpVec(a.position, b.position, p), rotation: lerpNumber(a.rotation, b.rotation, p),
      scale: [lerpScale(a.scale[0], b.scale[0], p), lerpScale(a.scale[1], b.scale[1], p)],
      pivot: lerpVec(a.pivot, b.pivot, p) };
  }

  function lerpPoint(a, b, p) {
    return Object.assign({}, b, { p: lerpVec(a.p, b.p, p), in: lerpVec(a.in, b.in, p), out: lerpVec(a.out, b.out, p),
      w: Math.max(lerpNumber(a.w, b.w, p), 0) });
  }

  function samePoints(a, b) {
    if (a.closed !== b.closed || a.points.length !== b.points.length) return false;
    for (let i = 0; i < a.points.length; i++) {
      const x = a.points[i], y = b.points[i];
      if (x !== y && (x.id !== y.id || !sameVec(x.p, y.p) || !sameVec(x.in, y.in) || !sameVec(x.out, y.out) ||
          x.w !== y.w || x.smooth !== y.smooth || x.symmetric !== y.symmetric || x.stroked !== y.stroked)) return false;
    }
    return true;
  }

  function interpolateShape(a, b, p, params) {
    if (a === b) return b;
    const out = Object.assign({}, b);
    out.transform = lerpTransform(a.transform, b.transform, p);
    out.opacity = clamp01(lerpNumber(a.opacity, b.opacity, p));
    if (a.fill && b.fill) out.fill = lerpColor(a.fill, b.fill, p);
    const ga = a.gradient, gb = b.gradient;
    if (ga && gb && ga.type === gb.type && ga.stops.length === gb.stops.length) {
      out.gradient = { type: gb.type, start: lerpVec(ga.start, gb.start, p), end: lerpVec(ga.end, gb.end, p),
        stops: gb.stops.map((s, i) => ({ offset: clamp01(lerpNumber(ga.stops[i].offset, s.offset, p)),
          color: lerpColor(ga.stops[i].color, s.color, p) })) };
    }
    const sa = a.stroke, sb = b.stroke;
    if (sa && sb) {
      out.stroke = Object.assign({}, sb, {
        color: lerpColor(sa.color, sb.color, p), width: Math.max(lerpNumber(sa.width, sb.width, p), 0),
        miterLimit: Math.max(lerpNumber(sa.miterLimit, sb.miterLimit, p), 1),
        dashOffset: lerpNumber(sa.dashOffset, sb.dashOffset, p),
      });
      if (sa.dash.length === sb.dash.length) out.stroke.dash = sa.dash.map((d, i) => Math.max(lerpNumber(d, sb.dash[i], p), 0));
    }
    const ma = a.math, mb = b.math;
    if (ma && mb && (ma.source !== mb.source || ma.size !== mb.size || ma.display !== mb.display)) {
      // The formula morphs from the old one (MathMorph.swift, morphMath).
      out.math = Object.assign({}, mb, { morph: { from: { source: ma.source, size: ma.size, display: ma.display }, progress: p } });
    }
    const ta = a.text, tb = b.text;
    if (ta && tb && (ta.tracking !== tb.tracking || ta.lineHeight !== tb.lineHeight)) {
      // Lines stay broken as they are at the end (TextContent.held).
      out.text = Object.assign({}, tb, {
        tracking: lerpNumber(ta.tracking, tb.tracking, p),
        lineHeight: Math.max(lerpNumber(ta.lineHeight, tb.lineHeight, p), 0),
        held: { tracking: tb.tracking, lineHeight: tb.lineHeight },
      });
    }
    if (!samePoints(a, b)) {
      let pairs;
      if (a.closed === b.closed && a.points.length === b.points.length && a.points.every((x, i) => x.id === b.points[i].id)) {
        pairs = { from: a.points, to: b.points };
      } else {
        pairs = mergeVertices(a, b, (id, segment, position) => (params.has(id) ? params.get(id) : nearestT(segment, position))) ||
          fallbackVertices(a, b);
      }
      out.points = pairs.to.map((y, i) => lerpPoint(pairs.from[i], y, p));
    }
    return out;
  }

  /// Puts the items of `old` that are leaving into `items`, each after the item it
  /// followed in `old` (first when that isn't there).
  function insertLeaving(old, items, isLeaving) {
    old.forEach((item, i) => {
      if (!isLeaving(item)) return;
      const after = i > 0 ? old[i - 1].id : null;
      items.splice(insertionIndex(after, items.map((x) => x.id)), 0, item);
    });
  }

  function interpolateLayer(a, b, p, newShapes, newGroups, params) {
    const out = Object.assign({}, b);
    out.transform = lerpTransform(a.transform, b.transform, p);
    const oldGroups = new Map(a.groups.map((g) => [g.id, g]));
    out.groups = b.groups.map((g) => {
      const old = oldGroups.get(g.id);
      return old ? Object.assign({}, g, { transform: lerpTransform(old.transform, g.transform, p) }) : g;
    });
    // Groups of shapes still leaving stay until the end too.
    out.groups = out.groups.concat(a.groups.filter((g) => !newGroups.has(g.id)));
    if (a.shapes !== b.shapes) {
      const oldShapes = new Map();
      for (const s of a.shapes) if (!oldShapes.has(s.id)) oldShapes.set(s.id, s);
      out.shapes = b.shapes.map((s) => {
        const old = oldShapes.get(s.id);
        return old ? interpolateShape(old, s, p, params) : s;
      });
      insertLeaving(a.shapes, out.shapes, (s) => !newShapes.has(s.id));
    }
    return out;
  }

  /// The scene `fraction` of the way through the transition from `a` to `b` (at 1 or
  /// more this is `b`), at progress `p`; `params` holds the recorded `t` of born and
  /// dying vertices.
  function interpolateScene(a, b, fraction, p, params) {
    if (fraction >= 1) return b;
    const out = Object.assign({}, b);
    out.viewport = Object.assign({}, b.viewport);
    if (a.viewport.id === b.viewport.id) out.viewport.background = lerpColor(a.viewport.background, b.viewport.background, p);
    const oldGlobals = new Map();
    for (const g of a.globalColors) if (!oldGlobals.has(g.id)) oldGlobals.set(g.id, g.color);
    out.globalColors = b.globalColors.map((g) => (oldGlobals.has(g.id) ? Object.assign({}, g, { color: lerpColor(oldGlobals.get(g.id), g.color, p) }) : g));
    const oldLayers = new Map();
    for (const l of a.layers) if (!oldLayers.has(l.id)) oldLayers.set(l.id, l);
    const newShapes = new Set(), newGroups = new Set();
    for (const layer of b.layers) {
      for (const s of layer.shapes) newShapes.add(s.id);
      for (const g of layer.groups) newGroups.add(g.id);
    }
    const layers = b.layers.map((layer) => {
      const old = oldLayers.get(layer.id);
      return old ? interpolateLayer(old, layer, p, newShapes, newGroups, params) : layer;
    });
    const newLayers = new Set(b.layers.map((l) => l.id));
    insertLeaving(a.layers, layers, (l) => !newLayers.has(l.id));
    out.layers = layers.map((l) => Object.assign({}, l, { shapes: l.shapes.slice() }));
    syncGlobalColors(out);
    return out;
  }

  // MARK: Drawing (SVGWriter.swift, Stroker.swift)

  // ControlFlow scene renderer: one normalized scene to SVG markup.
  //
  // A port of ControlFlowCore's SVGWriter (the app's SVG export, which draws what the
  // canvas draws) and what it relies on: Layer.worldShape (layer, group and shape
  // transforms baked into the points, the outline width and dashes scaled by the square
  // root of the transform's area scale, gradients moved with the shape), the clip plan,
  // BezierPath (segments, flattening with widths, stroked runs) and the Stroker (outlines
  // whose width varies become filled triangles, with caps, joins and dashes).
  //
  // Entry point: renderScene(scene, options) returns the inner markup of
  // <svg viewBox="0 0 W H">. Every other name starts with r_. No DOM access.

  /* exported renderScene */

  // MARK: Numbers and colors

  /** '.001' ... '.999' with no trailing zeros, by thousandths; '' for 0. */
  const r_fractions = (function () {
    const out = [''];
    for (let i = 1; i < 1000; i++) out.push(('.' + String(i + 1000).slice(1)).replace(/0+$/, ''));
    return out;
  })();

  /** `x` with at most three decimals and no trailing zeros (SVGWriter.number). */
  function r_num(x) {
    if (!Number.isFinite(x)) return '0';
    // Swift's rounded() rounds halves away from zero.
    const s = x * 1000;
    const k = s < 0 ? Math.round(-s) : Math.round(s);
    if (k === 0) return '0';
    // Written from the integer thousandths in small-integer arithmetic: the same text as
    // String(k / 1000), many times faster.
    if (k < 2147483648) {
      const ki = k | 0;
      const whole = (ki / 1000) | 0;
      return (s < 0 ? '-' : '') + whole + r_fractions[ki - whole * 1000];
    }
    return String((s < 0 ? -k : k) / 1000);
  }

  const r_hexBytes = (function () {
    const out = [];
    for (let i = 0; i < 256; i++) out.push((i < 16 ? '0' : '') + i.toString(16).toUpperCase());
    return out;
  })();

  function r_byte(v) {
    const c = Math.min(Math.max(v, 0), 1);
    // NaN clamps to... Swift's min/max keep the NaN and Int() traps; draw it as 0.
    return r_hexBytes[Number.isFinite(c) ? Math.round(c * 255) : 0];
  }

  /** `#RRGGBB`; the alpha is written separately as an opacity. */
  function r_rgb(c) {
    return '#' + r_byte(c[0]) + r_byte(c[1]) + r_byte(c[2]);
  }

  // MARK: Vectors (plain {x, y} objects; the arithmetic follows Vec2's order exactly)

  function r_v(x, y) { return { x: x, y: y }; }
  function r_len(v) { return Math.sqrt(v.x * v.x + v.y * v.y); }
  function r_norm(v) {
    const l = Math.sqrt(v.x * v.x + v.y * v.y);
    return l > 0 ? { x: v.x / l, y: v.y / l } : { x: 0, y: 0 };
  }
  function r_dist(a, b) {
    const x = a.x - b.x, y = a.y - b.y;
    return Math.sqrt(x * x + y * y);
  }
  function r_isZero(v) { return v.x === 0 && v.y === 0; }
  function r_lerp(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }
  function r_approx(a, b) { return Math.abs(a.x - b.x) <= 1e-9 && Math.abs(a.y - b.y) <= 1e-9; }

  /** Distance from `p` to the segment from `a` to `b`. */
  function r_distSeg(p, a, b) {
    const abx = b.x - a.x, aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    if (!(len2 > 1e-18)) return r_dist(p, a);
    const t = Math.min(Math.max(((p.x - a.x) * abx + (p.y - a.y) * aby) / len2, 0), 1);
    const x = p.x - (a.x + abx * t), y = p.y - (a.y + aby * t);
    return Math.sqrt(x * x + y * y);
  }

  function r_rotate(v, angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
  }

  // MARK: Transforms (Affine2D and Transform.matrix)

  const r_identity = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

  function r_isIdentityMatrix(m) {
    return m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.tx === 0 && m.ty === 0;
  }

  /** `l` applied after `r`. */
  function r_mul(l, r) {
    return {
      a: l.a * r.a + l.c * r.b,
      b: l.b * r.a + l.d * r.b,
      c: l.a * r.c + l.c * r.d,
      d: l.b * r.c + l.d * r.d,
      tx: l.a * r.tx + l.c * r.ty + l.tx,
      ty: l.b * r.tx + l.d * r.ty + l.ty,
    };
  }

  function r_transformIsIdentity(t) {
    return !t || (t.position[0] === 0 && t.position[1] === 0 && t.rotation === 0 && t.scale[0] === 1 && t.scale[1] === 1);
  }

  /** translate(position + pivot) · rotate · scale · translate(-pivot). */
  function r_matrix(t) {
    if (r_transformIsIdentity(t)) return r_identity;
    const radians = t.rotation * Math.PI / 180;
    const cs = Math.cos(radians), sn = Math.sin(radians);
    const move = { a: 1, b: 0, c: 0, d: 1, tx: t.position[0] + t.pivot[0], ty: t.position[1] + t.pivot[1] };
    const turn = { a: cs, b: sn, c: -sn, d: cs, tx: 0, ty: 0 };
    const scale = { a: t.scale[0], b: 0, c: 0, d: t.scale[1], tx: 0, ty: 0 };
    const back = { a: 1, b: 0, c: 0, d: 1, tx: -t.pivot[0], ty: -t.pivot[1] };
    return r_mul(r_mul(r_mul(move, turn), scale), back);
  }

  // MARK: Shapes in world space

  /**
   * A shape as drawn (Layer.worldShape): `{ closed, pts, fill, gradient, stroke, opacity }`
   * with each point `{ x, y, ix, iy, ox, oy, w, s }` (handles as offsets, `s` = stroked)
   * in world space. Only what drawing needs is kept.
   */
  function r_worldShape(layer, shape, groupsById) {
    const text = shape.text ? r_textOutline(shape.text) : shape.math ? r_mathOutline(shape.math) : null;
    const layerMatrix = r_matrix(layer.transform);
    let parent = layerMatrix;
    if (shape.group !== null && shape.group !== undefined) {
      const g = groupsById.get(shape.group);
      if (g && !r_transformIsIdentity(g.transform)) parent = r_mul(layerMatrix, r_matrix(g.transform));
    }
    const m = r_transformIsIdentity(shape.transform) ? parent : r_mul(parent, r_matrix(shape.transform));
    const ident = r_isIdentityMatrix(m);
    const src = text || shape.points;
    const pts = new Array(src.length);
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      const x = v.p[0], y = v.p[1];
      const ix = v.in ? v.in[0] : 0, iy = v.in ? v.in[1] : 0;
      const ox = v.out ? v.out[0] : 0, oy = v.out ? v.out[1] : 0;
      const w = v.w === undefined ? 1 : v.w;
      const s = v.stroked !== false;
      if (ident) {
        pts[i] = { x: x, y: y, ix: ix, iy: iy, ox: ox, oy: oy, w: w, s: s };
      } else {
        pts[i] = {
          x: m.a * x + m.c * y + m.tx, y: m.b * x + m.d * y + m.ty,
          ix: m.a * ix + m.c * iy, iy: m.b * ix + m.d * iy,
          ox: m.a * ox + m.c * oy, oy: m.b * ox + m.d * oy,
          w: w, s: s,
        };
      }
    }
    let gradient = null;
    if (shape.gradient) {
      const gr = shape.gradient;
      let stops = gr.stops || [];
      // ShapeGradient keeps its stops sorted by offset.
      for (let i = 1; i < stops.length; i++) {
        if (stops[i].offset < stops[i - 1].offset) {
          stops = stops.slice().sort(function (p, q) { return p.offset - q.offset; });
          break;
        }
      }
      const sx = gr.start[0], sy = gr.start[1], ex = gr.end[0], ey = gr.end[1];
      gradient = ident
        ? { type: gr.type, start: r_v(sx, sy), end: r_v(ex, ey), stops: stops }
        : {
          type: gr.type,
          start: r_v(m.a * sx + m.c * sy + m.tx, m.b * sx + m.d * sy + m.ty),
          end: r_v(m.a * ex + m.c * ey + m.tx, m.b * ex + m.d * ey + m.ty),
          stops: stops,
        };
    }
    // Text and formulas draw their glyphs filled, with no outline (VectorShape.resolvingLayout).
    let stroke = text ? null : shape.stroke || null;
    if (stroke && !ident) {
      const k = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
      stroke = {
        color: stroke.color, width: stroke.width * k, cap: stroke.cap, join: stroke.join,
        miterLimit: stroke.miterLimit, dash: (stroke.dash || []).map(function (x) { return x * k; }),
        dashOffset: (stroke.dashOffset || 0) * k, align: stroke.align,
      };
    }
    return { closed: !!shape.closed || !!text, pts: pts, fill: shape.fill || null, gradient: gradient, stroke: stroke,
      opacity: shape.opacity === undefined ? 1 : shape.opacity, image: shape.image ? shape.image.src : null };
  }

  /**
   * VectorShape.imagePlacement: the map from the image's unit square to its frame, whose
   * top-left, top-right and bottom-left corners are points 0, 1 and 3 (or the bounds of
   * a path without four points). Null when the frame has no area.
   */
  function r_imagePlacement(shape) {
    const pts = shape.pts;
    let ox, oy, ax, ay, dx, dy;
    if (pts.length >= 4) {
      ox = pts[0].x; oy = pts[0].y;
      ax = pts[1].x - ox; ay = pts[1].y - oy;
      dx = pts[3].x - ox; dy = pts[3].y - oy;
    } else {
      if (pts.length === 0) return null;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of pts) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
      ox = minX; oy = minY; ax = maxX - minX; ay = 0; dx = 0; dy = maxY - minY;
    }
    if (!(Math.abs(ax * dy - ay * dx) > 1e-12)) return null;
    return { a: ax, b: ay, c: dx, d: dy, tx: ox, ty: oy };
  }

  // MARK: Text (Text.swift)

  /// The layouts in text.json (HTMLExport.textLayouts), by `r_textKey` of their text.
  let r_texts = null;
  let r_textCache = new Map();

  function r_textKey(text) { return JSON.stringify(textJSON(text)); }

  /// Reads text.json (already parsed) into the layouts `renderScene` takes as
  /// `options.texts`.
  function readTextLayouts(json) {
    const out = new Map();
    for (const entry of (isObject(json) && Array.isArray(json.texts) ? json.texts : [])) {
      if (!isObject(entry) || !Array.isArray(entry.lines) || !Array.isArray(entry.glyphs)) continue;
      out.set(r_textKey(readText(entry.text)), entry);
    }
    return out;
  }

  /// The glyph origins of `layout` (laid out for `base`) with the tracking and line
  /// height changed, lines broken as they are: TextLayout.adjusted.
  function r_adjustedOrigins(layout, base, tracking, lineHeight) {
    const dt = tracking - base.tracking;
    const spacing = lineHeight * base.size, dh = spacing - base.lineHeight * base.size;
    if (dt === 0 && dh === 0) return layout.glyphs.map((g) => g.origin);
    const lines = layout.lines;
    const widths = lines.map((l) => l.width + dt * Math.max(l.glyphCount - 1, 0));
    const boxWidth = base.width !== null ? base.width : Math.max(widths.length ? Math.max.apply(null, widths) : 0, 0);
    const f = base.align === 'center' ? 0.5 : base.align === 'right' ? 1 : 0;
    const shifts = lines.map((l, i) => (boxWidth - widths[i]) * f - l.x);
    return layout.glyphs.map((g) => {
      if (!(g.line >= 0 && g.line < lines.length)) return g.origin;
      return [g.origin[0] + shifts[g.line] + dt * g.index, g.origin[1] + dh * (g.line + 0.5)];
    });
  }

  /// A text's glyphs as one path's points `{ p, in, out }`, in the shape's space
  /// (TextLayout.outline, bridged as BezierPath.bridging does). Empty when text.json
  /// has no layout for it.
  function r_textOutline(text) {
    if (!r_texts) return [];
    const cacheKey = JSON.stringify(text);
    if (r_textCache.has(cacheKey)) return r_textCache.get(cacheKey);
    // Partway through a transition the lines are as they are at the end.
    const base = text.held ? Object.assign({}, text, { tracking: text.held.tracking, lineHeight: text.held.lineHeight }) : text;
    const layout = r_texts.get(r_textKey(base));
    const out = [];
    if (layout) {
      const origins = r_adjustedOrigins(layout, base, text.tracking, text.lineHeight);
      let hub = null;
      layout.glyphs.forEach((glyph, g) => {
        const [gx, gy] = origins[g];
        for (const c of (Array.isArray(glyph.contours) ? glyph.contours : [])) {
          if (c.length < 12) continue;
          const ring = [];
          for (let i = 0; i + 5 < c.length; i += 6) {
            ring.push({ p: [c[i] + gx, c[i + 1] + gy], in: [c[i + 2], c[i + 3]], out: [c[i + 4], c[i + 5]] });
          }
          // Enter at the first point and come back to it along straight bridges.
          const back = { p: ring[0].p, in: ring[0].in, out: [0, 0] };
          ring[0] = { p: ring[0].p, in: [0, 0], out: ring[0].out };
          for (const point of ring) out.push(point);
          out.push(back);
          if (hub) out.push(hub); else hub = { p: ring[0].p, in: [0, 0], out: [0, 0] };
        }
      });
    }
    if (r_textCache.size >= 512) r_textCache = new Map();
    r_textCache.set(cacheKey, out);
    return out;
  }

  // MARK: Formulas (Math.swift, MathFile in PresentationPackage.swift)

  /// The layouts in math.json, by `r_mathKey` of their formula.
  let r_math = null;
  let r_mathCache = new Map();

  function r_mathKey(math) { return JSON.stringify(mathJSON(math)); }

  /// Reads math.json (already parsed) into the layouts `renderScene` takes as
  /// `options.math`: each formula's glyphs `{ key, tags, contours, place }` and rules, in points.
  /// Entries that don't read are left out (MathFile.read).
  function readMathLayouts(json) {
    const out = new Map();
    if (!isObject(json) || !Array.isArray(json.formulas)) return out;
    const table = isObject(json.glyphs) ? json.glyphs : {};
    const finite = (list, n) => Array.isArray(list) && list.length === n && list.every((x) => typeof x === 'number' && isFinite(x));
    for (const entry of json.formulas) {
      try {
        if (!isObject(entry)) continue;
        const math = readMath(entry.math);
        const k = math.size / 1000;
        if (!finite(entry.box, 2) || typeof entry.baseline !== 'number' || !Array.isArray(entry.glyphs) || !Array.isArray(entry.rules)) continue;
        const glyphs = [];
        for (const g of entry.glyphs) {
          const contours = isObject(g) ? table[g.key] : null;
          if (!Array.isArray(contours) || !finite(g.place, 6)) throw new Error('a glyph does not read');
          const m = g.place.map((x) => x * k);
          const tags = Array.isArray(g.tags) ? g.tags.filter((t) => typeof t === 'string') : [];
          glyphs.push({ key: g.key, tags, contours, place: { a: m[0], b: m[1], c: m[2], d: m[3], tx: m[4], ty: m[5] } });
        }
        const rules = [];
        for (const r of entry.rules) {
          if (!finite(r, 4)) throw new Error('a rule does not read');
          rules.push(r.map((x) => x * k));
        }
        out.set(r_mathKey(math), { glyphs, rules });
      } catch (e) {
        // A cache: a formula that doesn't read draws nothing.
      }
    }
    return out;
  }

  /// A formula's glyphs and rules as one path's points `{ p, in, out }`, in the shape's
  /// space (MathLayout.outline, bridged as BezierPath.bridging does, rules wound as the
  /// glyphs are). Empty when math.json has no layout for it. A formula partway through a
  /// morph draws its frame (morphMath), or the formula it goes to while either layout is
  /// missing.
  function r_mathOutline(math) {
    if (!r_math) return [];
    if (math.morph) {
      const frame = morphMath(math);
      if (frame) return frame;
    }
    const key = r_mathKey(math);
    if (r_mathCache.has(key)) return r_mathCache.get(key);
    const layout = r_math.get(key);
    const out = layout ? r_placedOutline(layout.glyphs, layout.rules) : [];
    r_mathCache.set(key, out);
    return out;
  }

  /// MathLayout.outline(placed:rules:): `glyphs` as `{ contours, place }` (contours in
  /// glyph units, place to points), rules as `[x, y, w, h]` in points.
  function r_placedOutline(glyphs, rules) {
    const rings = [];
    let area = 0;
    const signedArea = (ring) => {
      let sum = 0;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i].p, b = ring[(i + 1) % ring.length].p;
        sum += a[0] * b[1] - a[1] * b[0];
      }
      return ring.length >= 3 ? sum / 2 : 0;
    };
    for (const glyph of glyphs) {
      const m = glyph.place;
      for (const c of glyph.contours) {
        if (!Array.isArray(c) || c.length < 12) continue;
        const ring = [];
        for (let i = 0; i + 5 < c.length; i += 6) {
          const x = c[i], y = c[i + 1];
          ring.push({
            p: [m.a * x + m.c * y + m.tx, m.b * x + m.d * y + m.ty],
            in: [m.a * c[i + 2] + m.c * c[i + 3], m.b * c[i + 2] + m.d * c[i + 3]],
            out: [m.a * c[i + 4] + m.c * c[i + 5], m.b * c[i + 4] + m.d * c[i + 5]],
          });
        }
        area += signedArea(ring);
        rings.push(ring);
      }
    }
    for (const [x, y, w, h] of rules) {
      if (!(w > 0 && h > 0)) continue;
      let ring = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map((p) => ({ p, in: [0, 0], out: [0, 0] }));
      if (area !== 0 && (signedArea(ring) > 0) !== (area > 0)) ring = ring.reverse();
      rings.push(ring);
    }
    const out = [];
    let hub = null;
    for (const ring of rings) {
      // Enter at the first point and come back to it along straight bridges.
      const back = { p: ring[0].p, in: ring[0].in, out: [0, 0] };
      ring[0] = { p: ring[0].p, in: [0, 0], out: ring[0].out };
      for (const point of ring) out.push(point);
      out.push(back);
      if (hub) out.push(hub); else hub = { p: ring[0].p, in: [0, 0], out: [0, 0] };
    }
    return out;
  }

  // MARK: The morph (MathMorph.swift)

  let r_pairings = new Map();

  /// MathMorph.symbol: a glyph key without its variant.
  function mathSymbol(key) {
    const parts = key.split('-');
    return parts.length >= 3 ? `${parts[0]}-${parts[parts.length - 1]}` : key;
  }

  /// MathMorph.pair: `{ glyphs, rules }`, each a list of `[from, to]` index pairs (null
  /// for a side that has none), matched and new ones in `b`'s order, then those leaving.
  function pairMath(a, b) {
    const fromOf = b.glyphs.map(() => null);
    const paired = a.glyphs.map(() => false);
    const last = (g) => (g.tags.length ? g.tags[g.tags.length - 1] : null);
    const tagsB = new Set(b.glyphs.map(last).filter((t) => t !== null));
    const shared = new Set(a.glyphs.map(last).filter((t) => t !== null && tagsB.has(t)));
    const tagged = (g) => last(g) !== null && shared.has(last(g));
    const match = (name) => {
      const queues = new Map();
      b.glyphs.forEach((g, j) => {
        if (fromOf[j] !== null) return;
        const n = name(g);
        if (n === null) return;
        if (!queues.has(n)) queues.set(n, []);
        queues.get(n).push(j);
      });
      const next = new Map();
      a.glyphs.forEach((g, i) => {
        if (paired[i]) return;
        const n = name(g);
        if (n === null || !queues.has(n)) return;
        const queue = queues.get(n), k = next.get(n) || 0;
        if (k >= queue.length) return;
        next.set(n, k + 1);
        fromOf[queue[k]] = i;
        paired[i] = true;
      });
    };
    match((g) => (tagged(g) ? `${last(g)}\u0000${g.key}` : null));
    match((g) => (tagged(g) ? null : g.key));
    match((g) => (tagged(g) ? null : mathSymbol(g.key)));
    const glyphs = b.glyphs.map((g, j) => [fromOf[j], j]);
    a.glyphs.forEach((g, i) => { if (!paired[i]) glyphs.push([i, null]); });
    const rules = b.rules.map((r, j) => [j < a.rules.length ? j : null, j]);
    for (let i = Math.min(a.rules.length, b.rules.length); i < a.rules.length; i++) rules.push([i, null]);
    return { glyphs, rules };
  }

  /// MathMorph.scaled: `place` scaled by `s` about the center of the glyph's control points.
  function scaledPlace(m, contours, s) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of contours) {
      if (!Array.isArray(c)) continue;
      for (let i = 0; i + 5 < c.length; i += 6) {
        for (const [x, y] of [[c[i], c[i + 1]], [c[i] + c[i + 2], c[i + 1] + c[i + 3]], [c[i] + c[i + 4], c[i + 1] + c[i + 5]]]) {
          minX = Math.min(minX, x); minY = Math.min(minY, y);
          maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        }
      }
    }
    const cx = minX > maxX ? 0 : (minX + maxX) / 2, cy = minY > maxY ? 0 : (minY + maxY) / 2;
    const px = m.a * cx + m.c * cy + m.tx, py = m.b * cx + m.d * cy + m.ty;
    return { a: m.a * s, b: m.b * s, c: m.c * s, d: m.d * s, tx: m.tx * s + px * (1 - s), ty: m.ty * s + py * (1 - s) };
  }

  /// MathMorph.scaled: a rule `[x, y, w, h]` scaled by `s` about its center.
  function scaledRule([x, y, w, h], s) {
    const sw = w * s, sh = h * s;
    return [x + w / 2 - sw / 2, y + h / 2 - sh / 2, sw, sh];
  }

  /// MathMorph.outline: the frame of `math`, a formula with `morph`, as one path's
  /// points, or null when either layout is missing.
  function morphMath(math) {
    const fromKey = r_mathKey(math.morph.from), toKey = r_mathKey(math);
    const a = r_math.get(fromKey), b = r_math.get(toKey);
    if (!a || !b) return null;
    const p = math.morph.progress;
    if (p === 0) return r_placedOutline(a.glyphs, a.rules);
    if (p === 1) return r_placedOutline(b.glyphs, b.rules);
    const pairKey = `${fromKey}\n${toKey}`;
    if (!r_pairings.has(pairKey)) r_pairings.set(pairKey, pairMath(a, b));
    const pairing = r_pairings.get(pairKey);
    const grow = clamp01(p), shrink = clamp01(1 - p);
    const placed = [];
    for (const [i, j] of pairing.glyphs) {
      if (i !== null && j !== null) {
        const ga = a.glyphs[i], gb = b.glyphs[j];
        const contours = ga.key === gb.key || p >= 0.5 ? gb.contours : ga.contours;
        const m = ga.place, n = gb.place;
        placed.push({ contours, place: { a: lerpNumber(m.a, n.a, p), b: lerpNumber(m.b, n.b, p), c: lerpNumber(m.c, n.c, p),
          d: lerpNumber(m.d, n.d, p), tx: lerpNumber(m.tx, n.tx, p), ty: lerpNumber(m.ty, n.ty, p) } });
      } else if (i !== null) {
        const g = a.glyphs[i];
        if (shrink > 0) placed.push({ contours: g.contours, place: scaledPlace(g.place, g.contours, shrink) });
      } else if (j !== null) {
        const g = b.glyphs[j];
        if (grow > 0) placed.push({ contours: g.contours, place: scaledPlace(g.place, g.contours, grow) });
      }
    }
    const rules = [];
    for (const [i, j] of pairing.rules) {
      if (i !== null && j !== null) rules.push(a.rules[i].map((v, k) => lerpNumber(v, b.rules[j][k], p)));
      else if (i !== null) rules.push(scaledRule(a.rules[i], shrink));
      else if (j !== null) rules.push(scaledRule(b.rules[j], grow));
    }
    return r_placedOutline(placed, rules);
  }

  function r_useMath(math) {
    if ((math || null) !== r_math) {
      r_math = math || null;
      r_mathCache = new Map();
      r_pairings = new Map();
    }
  }

  // MARK: Bézier paths

  function r_segmentCount(path) {
    const n = path.pts.length;
    if (n < 2) return 0;
    return path.closed ? n : n - 1;
  }

  /** Segment `i` as four control points. */
  function r_segment(path, i) {
    const a = path.pts[i], b = path.pts[(i + 1) % path.pts.length];
    return [r_v(a.x, a.y), r_v(a.x + a.ox, a.y + a.oy), r_v(b.x + b.ix, b.y + b.iy), r_v(b.x, b.y)];
  }

  function r_split(c, t) {
    const a = r_lerp(c[0], c[1], t), b = r_lerp(c[1], c[2], t), d0 = r_lerp(c[2], c[3], t);
    const d = r_lerp(a, b, t), e = r_lerp(b, d0, t);
    const f = r_lerp(d, e, t);
    return [[c[0], a, d, f], [f, e, d0, c[3]]];
  }

  /** CubicBezier.flatten(tolerance:into:params:), excluding p0. */
  function r_flattenCubic(c, tol, depth, t0, t1, out, params) {
    const flat = r_distSeg(c[1], c[0], c[3]) <= tol && r_distSeg(c[2], c[0], c[3]) <= tol;
    if (flat || depth >= 16) {
      out.push(c[3]);
      if (params) params.push(t1);
      return;
    }
    const halves = r_split(c, 0.5);
    const mid = (t0 + t1) / 2;
    r_flattenCubic(halves[0], tol, depth + 1, t0, mid, out, params);
    r_flattenCubic(halves[1], tol, depth + 1, mid, t1, out, params);
  }

  /** BezierPath.flattenedWithWidths: points and width multiples; closed paths don't repeat the start. */
  function r_flattenWithWidths(path, tolerance) {
    const out = [], widths = [];
    if (path.pts.length === 0) return { points: out, widths: widths };
    const tol = Math.max(tolerance, 1e-6);
    const first = path.pts[0];
    out.push(r_v(first.x, first.y));
    widths.push(first.w);
    const count = r_segmentCount(path);
    const params = [];
    for (let i = 0; i < count; i++) {
      params.length = 0;
      r_flattenCubic(r_segment(path, i), tol, 0, 0, 1, out, params);
      const w0 = path.pts[i].w, w1 = path.pts[(i + 1) % path.pts.length].w;
      for (let k = 0; k < params.length; k++) widths.push(w0 + (w1 - w0) * params[k]);
    }
    if (path.closed && count > 0 && out.length > 1) {
      out.pop();
      widths.pop();
    }
    return { points: out, widths: widths };
  }

  /** How many points BezierPath.flattened makes. */
  function r_flattenedCount(path, tolerance) {
    const n = path.pts.length;
    if (n === 0) return 0;
    // Each segment adds at least one point, so only two-point closed paths need flattening.
    if (path.closed && n !== 2) return n;
    if (!path.closed) return n; // not asked for open paths
    return r_flattenWithWidths(path, tolerance).points.length;
  }

  function r_hasUnstroked(path) {
    const count = r_segmentCount(path);
    for (let i = 0; i < count; i++) if (!path.pts[i].s) return true;
    return false;
  }

  function r_hasVariableWidth(path) {
    for (let i = 0; i < path.pts.length; i++) if (path.pts[i].w !== 1) return true;
    return false;
  }

  /** The outlined parts of the path as open paths; the whole path when every segment is stroked. */
  function r_strokedRuns(path) {
    const count = r_segmentCount(path);
    if (count === 0 || !r_hasUnstroked(path)) return [path];
    const n = path.pts.length;
    let start = 0;
    if (path.closed) {
      let bare = 0;
      while (path.pts[bare].s) bare++;
      start = (bare + 1) % n;
    }
    const runs = [];
    let current = [];
    for (let k = 0; k < count; k++) {
      const i = (start + k) % n;
      if (path.pts[i].s) {
        if (current.length === 0) current.push(path.pts[i]);
        current.push(path.pts[(i + 1) % n]);
      } else if (current.length > 0) {
        runs.push({ pts: current, closed: false });
        current = [];
      }
    }
    if (current.length > 0) runs.push({ pts: current, closed: false });
    return runs;
  }

  function r_pair(p) { return r_num(p.x) + ' ' + r_num(p.y); }

  /** Path data: straight segments as lines, curves as cubics (SVGWriter.pathData). */
  function r_pathData(path) {
    if (path.pts.length === 0) return '';
    const first = path.pts[0];
    let d = 'M' + r_num(first.x) + ' ' + r_num(first.y);
    const count = r_segmentCount(path);
    for (let i = 0; i < count; i++) {
      const s = r_segment(path, i);
      if (r_approx(s[1], s[0]) && r_approx(s[2], s[3])) {
        // Z draws a straight closing segment.
        if (path.closed && i === count - 1) break;
        d += 'L' + r_pair(s[3]);
      } else {
        d += 'C' + r_pair(s[1]) + ' ' + r_pair(s[2]) + ' ' + r_pair(s[3]);
      }
    }
    if (path.closed) d += 'Z';
    return d;
  }

  /** The outlined parts: the whole path, or one open subpath per stroked run. */
  function r_strokeData(path) {
    if (!r_hasUnstroked(path)) return r_pathData(path);
    return r_strokedRuns(path).map(r_pathData).join('');
  }

  /** Path data for triangles, six numbers each in `t`. */
  function r_triangleData(t) {
    let d = '';
    for (let i = 0; i + 5 < t.length; i += 6) {
      d += 'M' + r_num(t[i]) + ' ' + r_num(t[i + 1]) + 'L' + r_num(t[i + 2]) + ' ' + r_num(t[i + 3]) +
        'L' + r_num(t[i + 4]) + ' ' + r_num(t[i + 5]) + 'Z';
    }
    return d;
  }

  // MARK: Appearance

  /** StrokeStyle.dashPattern: an even-length pattern, or null when solid. */
  function r_dashPattern(stroke) {
    const dash = stroke.dash;
    if (!dash || dash.length === 0) return null;
    for (let i = 0; i < dash.length; i++) if (!(Number.isFinite(dash[i]) && dash[i] >= 0)) return null;
    const pattern = dash.length % 2 === 1 ? dash.concat(dash) : dash;
    let gaps = 0;
    for (let i = 1; i < pattern.length; i += 2) gaps += pattern[i];
    return gaps > 0 ? pattern : null;
  }

  // MARK: Stroker

  const r_maxDashes = 5000;

  /**
   * Stroker.triangles: the outline of `path` (internal form, see r_worldShape) as
   * triangles, six numbers each, wound counter-clockwise on a y-up plane so a non-zero
   * fill of all of them is their union.
   */
  function r_strokeTriangles(path, style, widthScale, tolerance) {
    const out = [];
    const runs = r_strokedRuns(path);
    for (let k = 0; k < runs.length; k++) {
      const run = runs[k];
      const flat = r_flattenWithWidths(run, tolerance);
      const radii = flat.widths;
      for (let i = 0; i < radii.length; i++) radii[i] = Math.max(radii[i], 0) * style.width * widthScale / 2;
      r_appendTriangles(flat.points, radii, run.closed && flat.points.length > 2, style, tolerance, out);
    }
    return out;
  }

  /** Stroker.appendTriangles: a polyline with a half-width (radius) at each point. */
  function r_appendTriangles(points, radii, closed, style, tolerance, out) {
    let p, r;
    let firstRepeat = -1;
    if (points.length !== radii.length) {
      firstRepeat = 0;
    } else {
      for (let i = 1; i < Math.max(points.length, 1); i++) {
        if (r_dist(points[i - 1], points[i]) < 1e-9) { firstRepeat = i; break; }
      }
    }
    if (firstRepeat >= 0) {
      // Repeated points are merged, keeping the wider radius.
      p = points.slice(0, firstRepeat);
      r = radii.slice(0, firstRepeat);
      const m = Math.min(points.length, radii.length);
      for (let k = firstRepeat; k < m; k++) {
        const q = points[k], w = radii[k];
        if (p.length > 0 && r_dist(p[p.length - 1], q) < 1e-9) {
          r[r.length - 1] = Math.max(r[r.length - 1], w);
          continue;
        }
        p.push(q);
        r.push(w);
      }
    } else {
      p = points.slice();
      r = radii.slice();
    }
    let isClosed = closed;
    if (isClosed && p.length > 1 && r_dist(p[0], p[p.length - 1]) < 1e-9) {
      p.pop();
      r.pop();
    }
    if (p.length < 3) isClosed = false;
    if (p.length === 0 || !r.some(function (x) { return x > 0; })) return;

    const pattern = r_dashPattern(style);
    if (pattern) {
      if (isClosed) {
        p.push(p[0]);
        r.push(r[0]);
      }
      const pieces = r_dashes(p, r, pattern, style.dashOffset || 0);
      if (pieces) {
        for (let i = 0; i < pieces.length; i++) {
          r_strokePolyline(pieces[i].points, pieces[i].radii, false, style, tolerance, out);
        }
        return;
      }
      if (isClosed) {
        p.pop();
        r.pop();
      }
    }
    r_strokePolyline(p, r, isClosed, style, tolerance, out);
  }

  /** Stroker.dashes: an open polyline cut into dashes; null when there would be too many. */
  function r_dashes(p, r, pattern, offset) {
    const lengths = [0];
    for (let i = 1; i < Math.max(p.length, 1); i++) lengths.push(lengths[i - 1] + r_dist(p[i - 1], p[i]));
    const total = lengths[lengths.length - 1];
    let period = 0;
    for (let i = 0; i < pattern.length; i++) period += pattern[i];
    if (!(period > 0 && total / period * Math.floor(pattern.length / 2) <= r_maxDashes)) return null;

    function sample(s, start) {
      let i = start;
      while (i < p.length - 2 && lengths[i + 1] < s) i++;
      const len = lengths[i + 1] - lengths[i];
      const k = len > 0 ? Math.min(Math.max((s - lengths[i]) / len, 0), 1) : 0;
      return [r_lerp(p[i], p[i + 1], k), r[i] + (r[i + 1] - r[i]) * k, i];
    }

    if (p.length === 1) return [{ points: p, radii: r }];
    let phase = offset % period;
    if (phase < 0) phase += period;
    let index = 0;
    while (phase >= pattern[index]) {
      phase -= pattern[index];
      index = (index + 1) % pattern.length;
    }
    const pieces = [];
    let s = 0;
    let segment = 0;
    let remaining = pattern[index] - phase;
    while (s <= total) {
      const end = Math.min(s + remaining, total);
      if (index % 2 === 0) {
        const a = sample(s, segment);
        const pts = [a[0]], rs = [a[1]];
        const add = function (q, w) {
          if (r_dist(q, pts[pts.length - 1]) < 1e-9) return;
          pts.push(q);
          rs.push(w);
        };
        let j = a[2] + 1;
        while (j < p.length && lengths[j] < end) {
          add(p[j], r[j]);
          j++;
        }
        const b = sample(end, a[2]);
        add(b[0], b[1]);
        segment = b[2];
        pieces.push({ points: pts, radii: rs });
      }
      if (s + remaining > total) break;
      s += remaining;
      index = (index + 1) % pattern.length;
      remaining = pattern[index];
    }
    return pieces;
  }

  function r_strokePolyline(p, r, closed, style, tolerance, out) {
    const n = p.length;
    if (n === 0) return;
    if (n === 1 || (n === 2 && r_dist(p[0], p[1]) < 1e-9)) {
      r_dot(p[0], r[0], style.cap, tolerance, out);
      return;
    }
    const segments = closed ? n : n - 1;
    for (let i = 0; i < segments; i++) {
      const a = p[i], b = p[(i + 1) % n];
      const ra = r[i], rb = r[(i + 1) % n];
      const d = r_norm(r_v(b.x - a.x, b.y - a.y));
      if (r_isZero(d)) continue;
      const nx = -d.y, ny = d.x;
      r_quad(r_v(a.x + nx * ra, a.y + ny * ra), r_v(b.x + nx * rb, b.y + ny * rb),
        r_v(b.x - nx * rb, b.y - ny * rb), r_v(a.x - nx * ra, a.y - ny * ra), out);
    }
    const jStart = closed ? 0 : 1, jEnd = closed ? n : n - 1;
    for (let i = jStart; i < jEnd; i++) {
      const prev = p[(i - 1 + n) % n], here = p[i], next = p[(i + 1) % n];
      r_join(here, r_norm(r_v(here.x - prev.x, here.y - prev.y)), r_norm(r_v(next.x - here.x, next.y - here.y)),
        r[i], style, tolerance, out);
    }
    if (!closed) {
      r_cap(p[0], r_norm(r_v(p[0].x - p[1].x, p[0].y - p[1].y)), r[0], style.cap, tolerance, out);
      r_cap(p[n - 1], r_norm(r_v(p[n - 1].x - p[n - 2].x, p[n - 1].y - p[n - 2].y)), r[n - 1], style.cap, tolerance, out);
    }
  }

  function r_join(center, d0, d1, radius, style, tolerance, out) {
    if (!(radius > 0) || r_isZero(d0) || r_isZero(d1)) return;
    const cross = d0.x * d1.y - d0.y * d1.x, dot = d0.x * d1.x + d0.y * d1.y;
    if (Math.abs(cross) < 1e-9 && dot > 0) return;
    // The outer side of the turn: the side the path turns away from.
    const side = cross > 0 ? -1 : 1;
    const u0 = r_v(-d0.y * side, d0.x * side), u1 = r_v(-d1.y * side, d1.x * side);
    const a = r_v(center.x + u0.x * radius, center.y + u0.y * radius);
    const b = r_v(center.x + u1.x * radius, center.y + u1.y * radius);
    switch (style.join) {
      case 'bevel':
        r_triangle(center, a, b, out);
        break;
      case 'miter': {
        const m = r_norm(r_v(u0.x + u1.x, u0.y + u1.y));
        const cosHalf = m.x * u0.x + m.y * u0.y;
        if (r_isZero(m) || cosHalf < 1e-9 || 1 / cosHalf > style.miterLimit) {
          r_triangle(center, a, b, out);
        } else {
          const k = radius / cosHalf;
          const tip = r_v(center.x + m.x * k, center.y + m.y * k);
          r_triangle(center, a, tip, out);
          r_triangle(center, tip, b, out);
        }
        break;
      }
      default: { // round
        let sweep = Math.atan2(u0.x * u1.y - u0.y * u1.x, u0.x * u1.x + u0.y * u1.y);
        if (Math.abs(cross) < 1e-9) {
          // A full reversal: go round the end the path came in through.
          const mid = r_rotate(u0, sweep / 2);
          if (mid.x * d0.x + mid.y * d0.y < 0) sweep = -sweep;
        }
        r_arc(center, u0, sweep, radius, tolerance, out);
      }
    }
  }

  /** A cap at an end point; `d` points out of the path. */
  function r_cap(end, d, radius, cap, tolerance, out) {
    if (!(radius > 0) || r_isZero(d)) return;
    const nx = -d.y, ny = d.x;
    if (cap === 'square') {
      const px = end.x + nx * radius, py = end.y + ny * radius;
      const qx = end.x - nx * radius, qy = end.y - ny * radius;
      r_quad(r_v(px, py), r_v(px + d.x * radius, py + d.y * radius), r_v(qx + d.x * radius, qy + d.y * radius),
        r_v(qx, qy), out);
    } else if (cap === 'round') {
      const turned = r_rotate(r_v(nx, ny), Math.PI / 2);
      r_arc(end, r_v(nx, ny), d.x * turned.x + d.y * turned.y > 0 ? Math.PI : -Math.PI, radius, tolerance, out);
    }
  }

  /** A lone point: a disc for round caps, a square for square caps, nothing for butt. */
  function r_dot(p, radius, cap, tolerance, out) {
    if (!(radius > 0)) return;
    if (cap === 'square') {
      r_quad(r_v(p.x + -radius, p.y + -radius), r_v(p.x + radius, p.y + -radius), r_v(p.x + radius, p.y + radius),
        r_v(p.x + -radius, p.y + radius), out);
    } else if (cap === 'round') {
      r_arc(p, r_v(1, 0), 2 * Math.PI, radius, tolerance, out);
    }
  }

  /** A fan from `center` along the arc from direction `u` turning `sweep` radians. */
  function r_arc(center, u, sweep, radius, tolerance, out) {
    if (!(Math.abs(sweep) > 1e-9)) return;
    const count = r_arcCount(sweep, radius, tolerance);
    let previous = r_v(center.x + u.x * radius, center.y + u.y * radius);
    for (let k = 1; k <= count; k++) {
      const q = r_rotate(u, sweep * k / count);
      const next = r_v(center.x + q.x * radius, center.y + q.y * radius);
      r_triangle(center, previous, next, out);
      previous = next;
    }
  }

  function r_arcCount(sweep, radius, tolerance) {
    const step = radius > tolerance ? 2 * Math.acos(Math.max(-1, 1 - tolerance / radius)) : Math.PI / 2;
    const n = Math.ceil(Math.abs(sweep) / Math.max(step, 1e-3));
    return Math.min(Math.max(Number.isFinite(n) ? n : 1, 1), 128);
  }

  function r_quad(a, b, c, d, out) {
    r_triangle(a, b, c, out);
    r_triangle(a, c, d, out);
  }

  /** A triangle wound counter-clockwise (positive area); degenerate ones are dropped. */
  function r_triangle(a, b, c, out) {
    const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (!(Math.abs(area) > 1e-12)) return;
    if (area > 0) out.push(a.x, a.y, b.x, b.y, c.x, c.y);
    else out.push(a.x, a.y, c.x, c.y, b.x, b.y);
  }

  // MARK: Clipping (Layer.clipPlan)

  function r_clipPlan(layer) {
    const bases = [], groupBases = [];
    const clippedGroups = new Set();
    for (let i = 0; i < layer.groups.length; i++) if (layer.groups[i].clipped) clippedGroups.add(layer.groups[i].id);
    let lastBase = null;
    const lastInGroup = new Map();
    const groupBase = new Map();
    for (let index = 0; index < layer.shapes.length; index++) {
      const shape = layer.shapes[index];
      const group = shape.group === undefined ? null : shape.group;
      if (group !== null) {
        if (!groupBase.has(group)) groupBase.set(group, clippedGroups.has(group) ? lastBase : null);
        groupBases.push(groupBase.get(group));
        bases.push(shape.clipped ? (lastInGroup.has(group) ? lastInGroup.get(group) : null) : null);
        if (!shape.clipped) lastInGroup.set(group, index);
      } else {
        groupBases.push(null);
        bases.push(shape.clipped ? lastBase : null);
      }
      const inClippedGroup = group !== null && clippedGroups.has(group);
      if (!shape.clipped && !inClippedGroup) lastBase = index;
    }
    return { bases: bases, groupBases: groupBases };
  }

  // MARK: Writer

  const r_tolerance = 0.1;

  /** Escapes text for an attribute value (SVGWriter.escaped). */
  function r_escape(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function r_makeID(w, prefix) {
    return w.prefix + prefix + (w.next++);
  }

  function r_areaAttrs(w) {
    return ' x="0" y="0" width="' + w.width + '" height="' + w.height + '"';
  }

  function r_strokeAttributes(stroke, widthScale) {
    let out = ' stroke-width="' + r_num(stroke.width * widthScale) + '" stroke-linecap="' + stroke.cap +
      '" stroke-linejoin="' + stroke.join + '"';
    if (stroke.join === 'miter') out += ' stroke-miterlimit="' + r_num(stroke.miterLimit) + '"';
    const pattern = r_dashPattern(stroke);
    if (pattern) {
      out += ' stroke-dasharray="' + pattern.map(r_num).join(' ') + '"';
      if (stroke.dashOffset) out += ' stroke-dashoffset="' + r_num(stroke.dashOffset) + '"';
    }
    return out;
  }

  /** A mask that is white wherever `base` draws: its fill and its outline. */
  function r_clipMask(w, base) {
    const id = r_makeID(w, 'clip');
    let m = '<mask id="' + id + '" maskUnits="userSpaceOnUse"' + r_areaAttrs(w) + '>';
    const d = r_pathData(base);
    // An image clips to its frame, as a fill does to its path.
    const filled = base.closed && base.fill || base.image;
    if (filled) m += '<path d="' + d + '" fill="#FFFFFF"/>';
    const stroke = base.stroke;
    if (stroke && stroke.width > 0) {
      const alignment = base.closed ? stroke.align : 'center';
      // An inside outline lies within the fill; an outside one is the far half of a doubled one.
      if (alignment !== 'inside' || !filled) {
        const scale = alignment === 'outside' ? 2 : 1;
        if (r_hasVariableWidth(base)) {
          const t = r_strokeTriangles(base, stroke, scale, r_tolerance);
          m += '<path d="' + r_triangleData(t) + '" fill="#FFFFFF"/>';
        } else if (r_strokedRuns(base).length > 0) {
          m += '<path d="' + r_strokeData(base) + '" fill="none" stroke="#FFFFFF"' + r_strokeAttributes(stroke, scale) + '/>';
        }
      }
    }
    w.defs.push(m + '</mask>');
    return id;
  }

  /** A gradient in user space; returns its id. */
  function r_gradient(w, g) {
    const id = r_makeID(w, 'gradient');
    let s;
    if (g.type === 'radial') {
      s = '<radialGradient id="' + id + '" gradientUnits="userSpaceOnUse" cx="' + r_num(g.start.x) + '" cy="' +
        r_num(g.start.y) + '" r="' + r_num(r_dist(g.start, g.end)) + '">';
    } else {
      s = '<linearGradient id="' + id + '" gradientUnits="userSpaceOnUse" x1="' + r_num(g.start.x) + '" y1="' +
        r_num(g.start.y) + '" x2="' + r_num(g.end.x) + '" y2="' + r_num(g.end.y) + '">';
    }
    const count = Math.min(g.stops.length, 8);
    for (let i = 0; i < count; i++) {
      const stop = g.stops[i];
      s += '<stop offset="' + r_num(stop.offset) + '" stop-color="' + r_rgb(stop.color) + '"';
      if (stop.color[3] < 1) s += ' stop-opacity="' + r_num(stop.color[3]) + '"';
      s += '/>';
    }
    w.defs.push(s + (g.type === 'radial' ? '</radialGradient>' : '</linearGradient>'));
    return id;
  }

  /** True when the gradient has no extent, where the canvas paints its color at 0 (the first stop). */
  function r_gradientCollapsed(g) {
    const ax = g.end.x - g.start.x, ay = g.end.y - g.start.y;
    if (g.type === 'radial') return !(Math.sqrt(ax * ax + ay * ay) > 1e-12);
    return !(ax * ax + ay * ay > 1e-12);
  }

  function r_shape(w, shape) {
    const body = w.body;
    const d = r_pathData(shape);
    const opacity = Math.min(Math.max(shape.opacity, 0), 1);
    // An image draws its picture in place of a fill.
    const visibleFill = shape.closed && !shape.image ? shape.fill : null;
    const placement = shape.image ? r_imagePlacement(shape) : null;
    if (placement) {
      const m = placement;
      let image = '<image width="1" height="1" preserveAspectRatio="none" transform="matrix(' +
        [m.a, m.b, m.c, m.d, m.tx, m.ty].map(r_num).join(' ') + ')" href="' + r_escape(shape.image) + '"';
      if (opacity < 1) image += ' opacity="' + r_num(opacity) + '"';
      body.push(image + '/>');
    }
    let fill = 'fill="none"';
    if (visibleFill) {
      const g = shape.gradient;
      if (g && g.stops.length > 0 && !r_gradientCollapsed(g)) {
        fill = 'fill="url(#' + r_gradient(w, g) + ')"';
        if (opacity < 1) fill += ' fill-opacity="' + r_num(opacity) + '"';
      } else {
        // A gradient with no extent paints its first stop, as on the canvas.
        const color = g && g.stops.length > 0 ? g.stops[0].color : visibleFill;
        fill = 'fill="' + r_rgb(color) + '"';
        const alpha = color[3] * opacity;
        if (alpha < 1) fill += ' fill-opacity="' + r_num(alpha) + '"';
      }
    }
    const stroke = shape.stroke;
    if (!stroke || !(stroke.width > 0)) {
      if (visibleFill) body.push('<path d="' + d + '" ' + fill + '/>');
      return;
    }
    // As on the canvas: aligned only when the path encloses an area.
    const encloses = shape.closed && r_flattenedCount(shape, r_tolerance) >= 3;
    const alignment = encloses ? stroke.align : 'center';
    const strokeAlpha = stroke.color[3] * opacity;
    const variable = r_hasVariableWidth(shape);
    const unstroked = r_hasUnstroked(shape);
    if (alignment === 'center' && !variable && !unstroked) {
      let line = '<path d="' + d + '" ' + fill + ' stroke="' + r_rgb(stroke.color) + '"';
      if (strokeAlpha < 1) line += ' stroke-opacity="' + r_num(strokeAlpha) + '"';
      body.push(line + r_strokeAttributes(stroke, 1) + '/>');
      return;
    }
    if (visibleFill) body.push('<path d="' + d + '" ' + fill + '/>');
    // The outline on its own: doubled and cut to one side of the path when aligned.
    let limit = '';
    if (alignment === 'inside') {
      const id = r_makeID(w, 'inside');
      w.defs.push('<clipPath id="' + id + '"><path d="' + d + '"/></clipPath>');
      limit = ' clip-path="url(#' + id + ')"';
    } else if (alignment === 'outside') {
      const id = r_makeID(w, 'outside');
      w.defs.push('<mask id="' + id + '" maskUnits="userSpaceOnUse"' + r_areaAttrs(w) + '><rect' + r_areaAttrs(w) +
        ' fill="#FFFFFF"/><path d="' + d + '" fill="#000000"/></mask>');
      limit = ' mask="url(#' + id + ')"';
    }
    const scale = alignment === 'center' ? 1 : 2;
    if (variable) {
      // SVG strokes have one width, so the outline is written as its area.
      const t = r_strokeTriangles(shape, stroke, scale, r_tolerance);
      if (t.length === 0) return;
      let paint = r_rgb(stroke.color) + '"';
      if (strokeAlpha < 1) paint += ' fill-opacity="' + r_num(strokeAlpha) + '"';
      body.push('<path d="' + r_triangleData(t) + '" fill="' + paint + limit + '/>');
    } else {
      const sd = r_strokeData(shape);
      if (sd === '') return;
      let line = '<path d="' + sd + '" fill="none" stroke="' + r_rgb(stroke.color) + '"';
      if (strokeAlpha < 1) line += ' stroke-opacity="' + r_num(strokeAlpha) + '"';
      body.push(line + r_strokeAttributes(stroke, scale) + limit + '/>');
    }
  }

  /** One layer, as SVGWriter.Writer.layer: groups as <g>, clips as masked <g>s. */
  function r_layer(w, layer, drawHidden) {
    const body = w.body;
    const shapes = layer.shapes;
    const groupsById = new Map();
    for (let i = 0; i < layer.groups.length; i++) groupsById.set(layer.groups[i].id, layer.groups[i]);
    const world = new Array(shapes.length);
    const worldShape = function (i) {
      if (!world[i]) world[i] = r_worldShape(layer, shapes[i], groupsById);
      return world[i];
    };
    const shown = function (i) { return drawHidden || !shapes[i].hidden; };
    body.push('<g>');
    let openGroup = null;
    let clipGroup = null; // { base, mask }
    const masks = new Map();
    const maskFor = function (base) {
      let mask = masks.get(base);
      if (mask === undefined) {
        mask = r_clipMask(w, worldShape(base));
        masks.set(base, mask);
      }
      return mask;
    };
    const clips = r_clipPlan(layer);
    for (let index = 0; index < shapes.length; index++) {
      if (!shown(index)) continue;
      const base = clips.bases[index];
      if (base !== null && !shown(base)) continue;
      const groupBase = clips.groupBases[index];
      if (groupBase !== null && !shown(groupBase)) continue;
      const gid = shapes[index].group;
      const group = gid === null || gid === undefined ? null : (groupsById.get(gid) || null);
      const groupID = group ? group.id : null;
      if (groupID !== openGroup) {
        if (clipGroup) body.push('</g>');
        clipGroup = null;
        if (openGroup !== null) body.push('</g>');
        openGroup = groupID;
        if (group) {
          // A clipped group is masked by its base as a whole.
          body.push(groupBase !== null ? '<g mask="url(#' + maskFor(groupBase) + ')">' : '<g>');
        }
      }
      if ((clipGroup ? clipGroup.base : null) !== base) {
        if (clipGroup) body.push('</g>');
        clipGroup = null;
        if (base !== null) {
          const mask = maskFor(base);
          clipGroup = { base: base, mask: mask };
          body.push('<g mask="url(#' + mask + ')">');
        }
      }
      r_shape(w, worldShape(index));
    }
    if (clipGroup) body.push('</g>');
    if (openGroup !== null) body.push('</g>');
    body.push('</g>');
  }

  /**
   * The inner markup of `<svg viewBox="0 0 W H">` for one normalized scene: a <defs>
   * block when needed, the background rectangle, then each layer back to front.
   *
   * options.idPrefix: put before every element id, for several renders in one page.
   * options.drawHidden: draw hidden layers and shapes too (the app's presentation mode
   * skips them, as does SVG export, so the default is false).
   * options.texts: the glyph layouts from text.json (readTextLayouts); without them text
   * draws nothing.
   * options.math: the formula layouts from math.json (readMathLayouts); without them
   * formulas draw nothing.
   */
  function renderScene(scene, options) {
    const opts = options || {};
    if ((opts.texts || null) !== r_texts) {
      r_texts = opts.texts || null;
      r_textCache = new Map();
    }
    r_useMath(opts.math);
    const drawHidden = !!opts.drawHidden;
    const w = {
      defs: [], body: [], next: 1, prefix: opts.idPrefix || '',
      width: r_num(scene.width), height: r_num(scene.height),
    };
    for (let i = 0; i < scene.layers.length; i++) {
      const layer = scene.layers[i];
      if (layer.hidden && !drawHidden) continue;
      r_layer(w, layer, drawHidden);
    }
    const bg = scene.background || [1, 1, 1, 1];
    let rect = '<rect' + r_areaAttrs(w) + ' fill="' + r_rgb(bg) + '"';
    if (bg[3] < 1) rect += ' fill-opacity="' + r_num(Math.max(bg[3], 0)) + '"';
    rect += '/>';
    return (w.defs.length ? '<defs>' + w.defs.join('') + '</defs>' : '') + rect + w.body.join('');
  }

  // MARK: Exports

  const api = {
    FormatError, readPresentation, readTextLayouts, readMathLayouts, Timeline, interpolateScene, progress, sceneJSON, hexColor, parseColor,
    renderScene: typeof renderScene === 'function' ? renderScene : null,
    /// A text's glyph outline points, from layouts read by readTextLayouts (for the tests).
    textOutline(text, texts) {
      if ((texts || null) !== r_texts) {
        r_texts = texts || null;
        r_textCache = new Map();
      }
      return r_textOutline(text);
    },
    /// A formula's outline points (its file JSON or as read), from layouts read by
    /// readMathLayouts (for the tests).
    mathOutline(math, layouts) {
      r_useMath(layouts);
      return r_mathOutline(readMath(math));
    },
    /// A played formula's outline points (`shape.math` of a scene, morph and all).
    formulaOutline(math, layouts) {
      r_useMath(layouts);
      return r_mathOutline(math);
    },
    pairMath,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ControlFlowPlayer = api;

  // MARK: The page (Presenter.swift, PresentationTouches)

  /// Plays the presentation on `svg`: the opening state, then one sequence per Advance,
  /// stopping on its last keyframe. Advancing while a sequence plays jumps to its end;
  /// Back jumps, with no animation, to the end of the sequence before. The address's
  /// hash (`#3`) is the number of sequences played, so a link opens on that step.
  function play(svg, presentation, texts, math) {
    const timeline = new Timeline(presentation);
    const count = presentation.sequences.length;
    const { width, height } = presentation.viewport;
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    // The art is cut to the viewport, and the page around it is the letterbox.
    const stage = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    stage.setAttribute('width', width);
    stage.setAttribute('height', height);
    stage.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    stage.setAttribute('overflow', 'hidden');
    svg.appendChild(stage);
    document.title = presentation.name || 'ControlFlow';

    let position = 0;     // sequences played to their end
    let playing = null;   // { sequence, start } while one plays
    let frame = 0;

    const draw = (scene) => {
      stage.innerHTML = renderScene({ width, height, background: scene.viewport.background,
        globalColors: scene.globalColors, layers: scene.layers }, { texts, math });
    };
    const rest = () => {
      draw(timeline.stateAfter(position));
      const hash = position ? '#' + position : ' ';
      if ((location.hash || ' ') !== hash && history.replaceState) {
        history.replaceState(null, '', position ? hash : location.pathname + location.search);
      }
    };
    const finish = (sequence) => {
      playing = null;
      position = sequence + 1;
      rest();
    };
    const tick = (now) => {
      frame = 0;
      if (!playing) return;
      const time = now / 1000;
      if (playing.start === null) playing.start = time;
      const result = timeline.playing(playing.sequence, time - playing.start);
      if (result.finished) {
        finish(playing.sequence);
      } else {
        draw(result.scene);
        frame = requestAnimationFrame(tick);
      }
    };
    const stop = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };
    const advance = () => {
      if (playing) {
        stop();
        finish(playing.sequence);
      } else if (position < count) {
        if (!timeline.range(position)) {
          finish(position);
        } else {
          playing = { sequence: position, start: null };
          frame = requestAnimationFrame(tick);
        }
      }
    };
    const back = () => {
      if (playing) {
        stop();
        position = playing.sequence;
        playing = null;
      } else if (position > 0) {
        position -= 1;
      } else {
        return;
      }
      rest();
    };
    const jump = (to) => {
      stop();
      playing = null;
      position = Math.min(Math.max(to, 0), count);
      rest();
    };
    const fromHash = () => {
      const n = parseInt(location.hash.slice(1), 10);
      return isFinite(n) ? n : 0;
    };

    window.addEventListener('keydown', (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      switch (event.key) {
        case ' ': case 'Enter': case 'ArrowRight': case 'ArrowDown': case 'PageDown': advance(); break;
        case 'ArrowLeft': case 'ArrowUp': case 'PageUp': case 'Backspace': back(); break;
        case 'Home': jump(0); break;
        case 'End': jump(count); break;
        case 'f': case 'F': toggleFullscreen(); break;
        default: return;
      }
      event.preventDefault();
    });
    window.addEventListener('hashchange', () => { if (fromHash() !== position || playing) jump(fromHash()); });

    // A tap on the right half advances and on the left half goes back; a swipe to the
    // left advances and to the right goes back.
    const touches = new Map();
    let mostDown = 0, spent = false;
    window.addEventListener('pointerdown', (event) => {
      if (event.button > 0) return;
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY, time: event.timeStamp });
      mostDown = Math.max(mostDown, touches.size);
    });
    const ended = (event, cancelled) => {
      const touch = touches.get(event.pointerId);
      if (!touch) return;
      touches.delete(event.pointerId);
      if (cancelled) spent = true;
      const single = touches.size === 0 && mostDown === 1 && !spent;
      if (touches.size === 0) { mostDown = 0; spent = false; }
      if (!single) return;
      const dx = event.clientX - touch.x, dy = event.clientY - touch.y, seconds = (event.timeStamp - touch.time) / 1000;
      if (Math.hypot(dx, dy) <= 20 && seconds <= 0.5) {
        if (event.clientX >= window.innerWidth / 2) advance(); else back();
      } else if (Math.abs(dx) >= 50 && Math.abs(dx) > 1.5 * Math.abs(dy) && seconds <= 1) {
        if (dx < 0) advance(); else back();
      }
    };
    window.addEventListener('pointerup', (event) => ended(event, false));
    window.addEventListener('pointercancel', (event) => ended(event, true));

    position = Math.min(Math.max(fromHash(), 0), count);
    rest();
  }

  function toggleFullscreen() {
    if (!document.fullscreenEnabled) return;
    if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen();
  }

  function showMessage(text) {
    const message = document.getElementById('message');
    if (!message) return;
    message.textContent = text;
    message.hidden = false;
  }

  function start() {
    const svg = document.getElementById('stage');
    if (!svg) return;
    fetch('presentation.json', { cache: 'no-cache' })
      .then((response) => {
        if (!response.ok) throw new Error('presentation.json could not be loaded (' + response.status + ').');
        return response.json();
      })
      .then((json) => {
        const presentation = readPresentation(json);
        // text.json is there only when the presentation has text, and math.json only
        // when it has formulas.
        const optional = (name) => fetch(name, { cache: 'no-cache' })
          .then((response) => (response.ok ? response.json() : null), () => null)
          .catch(() => null);
        return Promise.all([optional('text.json'), optional('math.json')])
          .then(([texts, math]) => play(svg, presentation, texts ? readTextLayouts(texts) : null,
            math ? readMathLayouts(math) : null));
      })
      .catch((error) => {
        // Browsers don't let a page opened from a file read the file next to it.
        const local = location.protocol === 'file:';
        showMessage(local ? 'Serve this folder from a web server (GitHub Pages, or `python3 -m http.server` in it) to play it.'
          : 'This presentation could not be played: ' + error.message);
      });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
