/* =========================================================================
   Rutas Verificadores · Núcleo de lógica (sin dependencias de UI)
   - Normalización y coincidencia de colonias / fraccionamientos / poblados
   - Detección de columnas del Excel
   - Zonificación en 3 sectores balanceados por carga
   - Ruteo por verificador (vecino más cercano + 2-opt) y división por días
   - Motor de recomendaciones
   Funciona en navegador (window.Core) y en Node (module.exports) para pruebas.
   ========================================================================= */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- utilidades
  const R_EARTH = 6371;
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;

  function haversineKm(a, b) {
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.sqrt(h));
  }

  /** Rumbo 0–360 (0 = norte, 90 = oriente) desde a hacia b */
  function bearing(a, b) {
    const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
    const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
      Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  /** Punto destino a partir de origen, rumbo y distancia (km) */
  function destination(o, brg, km) {
    const d = km / R_EARTH, t = toRad(brg), la = toRad(o.lat), lo = toRad(o.lng);
    const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(t));
    const lo2 = lo + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
    return { lat: toDeg(la2), lng: toDeg(lo2) };
  }

  /** Tiempo estimado en auto (min) cuando no hay dato de ruteo real */
  function estimateDriveMin(a, b) {
    const km = haversineKm(a, b) * 1.35;               // factor de rodeo vial
    const speed = km < 4 ? 24 : km < 10 ? 32 : 50;      // km/h: urbano → periférico → carretera
    return (km / speed) * 60;
  }

  function angDiff(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

  function circularMean(angles, weights) {
    let x = 0, y = 0;
    angles.forEach((a, i) => { const w = weights ? weights[i] : 1; x += Math.cos(toRad(a)) * w; y += Math.sin(toRad(a)) * w; });
    if (Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9) return 0;
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  const DIRS = ['Norte', 'Noreste', 'Oriente', 'Sureste', 'Sur', 'Suroeste', 'Poniente', 'Noroeste'];
  function directionName(brg) { return DIRS[Math.round(brg / 45) % 8]; }

  // ------------------------------------------------------------ normalización
  const PREFIX_RE = new RegExp('^(?:' + [
    'colonia', 'col', 'fraccionamiento', 'fracionamiento', 'fracc', 'frac', 'fto',
    'poblado', 'pob', 'ejido', 'ej', 'rancho', 'rancheria', 'ranch', 'localidad', 'loc',
    'barrio', 'bo', 'conjunto habitacional', 'unidad habitacional', 'u hab', 'infonavit',
    'privada', 'priv', 'residencial', 'resid', 'asentamiento', 'comunidad', 'congregacion'
  ].join('|') + ')\\b\\.?\\s*', 'i');

  function stripAccents(s) { return String(s).normalize('NFD').replace(/[̀-ͯ]/g, ''); }

  /** Nombre canónico para comparar: sin acentos, sin prefijos tipo "Col." / "Fracc." */
  function normalizeName(s) {
    if (s == null) return '';
    let t = stripAccents(String(s)).toLowerCase()
      .replace(/[“”"'`´]/g, '')
      .replace(/[.,;:()\[\]{}#\/\\_-]+/g, ' ')
      .replace(/\s+/g, ' ').trim();
    for (let i = 0; i < 3; i++) { const n = t.replace(PREFIX_RE, '').trim(); if (n === t) break; t = n; }
    t = t.replace(/\b(durango|dgo|mexico|mex)\b/g, ' ').replace(/\s+/g, ' ').trim();
    // romanos finales → número (Huizache II = Huizache 2)
    t = t.replace(/\s(i|ii|iii|iv|v|vi)$/, (m, r) => ' ' + ({ i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6 })[r]);
    // "ampliacion x" / "x ampliacion" / "amp x"
    t = t.replace(/^(amp|ampl)\s/, 'ampliacion ').replace(/^(.+)\sampliacion$/, 'ampliacion $1');
    // Zona Centro (al quitar "Durango" queda "victoria de centro")
    if (/^(zona centro|centro|centro historico|zona centro historico|victoria de centro|victoria centro)$/.test(t)) t = 'centro';
    return t;
  }

  /** Variante sin "sección / etapa" para segundo intento */
  function baseName(norm) {
    return norm
      .replace(/\b(\d+|primera|segunda|tercera|cuarta|quinta|1a|2a|3a|4a|5a|1ra|2da|3ra|4ta|5ta|i{1,3}|iv|v)\s*(seccion|secc|sec|etapa|ampliacion)\b/g, ' ')
      .replace(/\b(seccion|secc|etapa|ampliacion|ampl|amp)\s*(\d+|[ivx]+|[a-c])?\b/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  function bigrams(s) {
    const t = ' ' + s + ' ', out = new Map();
    for (let i = 0; i < t.length - 1; i++) { const g = t.substr(i, 2); out.set(g, (out.get(g) || 0) + 1); }
    return out;
  }
  function dice(A, B) {
    let inter = 0, na = 0, nb = 0;
    A.forEach(v => { na += v; }); B.forEach(v => { nb += v; });
    A.forEach((v, g) => { if (B.has(g)) inter += Math.min(v, B.get(g)); });
    return na + nb ? (2 * inter) / (na + nb) : 0;
  }

  /** Clasifica el tipo de asentamiento a partir de etiquetas OSM y del nombre */
  function classifyPlace(tags) {
    const n = stripAccents((tags.name || '')).toLowerCase();
    if (/^fracc|^fraccionamiento|^residencial|^privada|^conjunto/.test(n)) return 'Fraccionamiento';
    if (/^ejido/.test(n)) return 'Ejido';
    if (/^rancho|^rancheria/.test(n)) return 'Rancho';
    if (/^col(onia)?\b/.test(n)) return 'Colonia';
    const p = tags.place;
    if (p === 'town' || p === 'village') return 'Poblado';
    if (p === 'hamlet' || p === 'locality' || p === 'isolated_dwelling' || p === 'farm') return 'Ranchería';
    if (p === 'suburb' || p === 'neighbourhood' || p === 'quarter') return 'Colonia';
    if (tags.landuse === 'residential') return 'Fraccionamiento';
    return 'Colonia';
  }

  // ------------------------------------------------------- índice de catálogo
  function buildIndex(places) {
    const byNorm = new Map(), entries = [];
    places.forEach(p => {
      const norm = normalizeName(p.name), base = baseName(norm);
      if (!norm) return;
      [norm, base].forEach(k => {
        if (!k) return;
        if (!byNorm.has(k)) byNorm.set(k, []);
        if (!byNorm.get(k).includes(p)) byNorm.get(k).push(p);
      });
      entries.push({ p, norm, grams: bigrams(norm) });
    });
    // nombres largos primero para escaneo dentro de direcciones
    const scan = entries.filter(e => e.norm.length >= 5).sort((a, b) => b.norm.length - a.norm.length);
    return { byNorm, entries, scan, cache: new Map() };
  }

  function pickClosest(list, center) {
    if (!list || !list.length) return null;
    if (list.length === 1 || !center) return list[0];
    return list.slice().sort((a, b) => (a.minutes ?? 1e9) - (b.minutes ?? 1e9) || haversineKm(center, a) - haversineKm(center, b))[0];
  }

  /**
   * Busca el asentamiento del catálogo que corresponde a un texto.
   * Devuelve { place, score, method } o null.
   */
  function matchPlace(text, index, center, minScore) {
    minScore = minScore || 0.84;
    const norm = normalizeName(text);
    if (!norm) return null;
    const ck = norm + '|' + minScore;
    if (index.cache.has(ck)) return index.cache.get(ck);
    let res = null;
    const exact = index.byNorm.get(norm) || index.byNorm.get(baseName(norm));
    if (exact) {
      const ids = new Set(exact.map(p => p.id));
      res = { place: pickClosest(exact, center), score: 1, method: ids.size > 1 ? 'nombre repetido' : 'exacta', options: ids.size };
    }
    if (!res) {
      const g = bigrams(norm); let best = null, bs = 0;
      for (const e of index.entries) {
        if (Math.abs(e.norm.length - norm.length) > Math.max(6, norm.length * 0.6)) continue;
        const s = dice(g, e.grams);
        if (s > bs || (s === bs && best && (e.p.minutes ?? 1e9) < (best.minutes ?? 1e9))) { bs = s; best = e.p; }
      }
      if (best && bs >= minScore) res = { place: best, score: +bs.toFixed(2), method: 'aproximada' };
    }
    index.cache.set(ck, res);
    return res;
  }

  /** Busca nombres del catálogo contenidos dentro de una dirección completa */
  function scanAddress(text, index, center) {
    const norm = ' ' + normalizeName(text) + ' ';
    if (norm.length < 6) return null;
    for (const e of index.scan) {
      if (norm.includes(' ' + e.norm + ' ')) {
        const all = index.byNorm.get(e.norm) || [e.p];
        return { place: pickClosest(all, center), score: 0.9, method: 'en dirección' };
      }
    }
    return null;
  }

  // ----------------------------------------------------- detección de columnas
  const ROLE_KEYS = {
    id: ['folio', 'id', 'clave', 'expediente', 'cuenta', 'no', 'num', 'numero de visita', 'consecutivo'],
    nombre: ['nombre', 'cliente', 'solicitante', 'beneficiario', 'razon social', 'titular', 'contribuyente', 'persona', 'negocio', 'establecimiento', 'empresa', 'derechohabiente'],
    direccion: ['direccion', 'domicilio', 'calle', 'dir', 'ubicacion', 'domicilio completo'],
    numero: ['numero exterior', 'num ext', 'no ext', 'exterior', 'numero ext'],
    colonia: ['colonia', 'fraccionamiento', 'fracc', 'asentamiento', 'barrio', 'localidad', 'poblado', 'comunidad', 'col', 'zona', 'sector', 'ejido'],
    municipio: ['municipio', 'ciudad', 'mpio'],
    cp: ['cp', 'c p', 'codigo postal', 'cod postal'],
    lat: ['lat', 'latitud', 'latitude'],
    lng: ['lng', 'lon', 'long', 'longitud', 'longitude'],
    telefono: ['telefono', 'tel', 'celular', 'cel', 'movil', 'contacto'],
    referencias: ['referencia', 'referencias', 'entre calles', 'observaciones', 'notas']
  };

  function normHeader(h) { return stripAccents(String(h || '')).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }

  function headerScore(h, keys) {
    const n = normHeader(h); if (!n) return 0;
    let best = 0;
    for (const k of keys) {
      if (n === k) best = Math.max(best, 10);
      else if (new RegExp('(^| )' + k + '( |$)').test(n)) best = Math.max(best, 6 + Math.min(k.length, 4) / 2);
      else if (k.length >= 4 && n.includes(k)) best = Math.max(best, 4);
    }
    return best;
  }

  /** Encuentra la fila de encabezados (algunos Excel traen títulos arriba) */
  function findHeaderRow(rows) {
    let bestRow = 0, bestScore = -1;
    for (let r = 0; r < Math.min(rows.length, 15); r++) {
      const row = rows[r] || [];
      let s = 0, filled = 0;
      row.forEach(c => {
        if (c !== '' && c != null) filled++;
        Object.values(ROLE_KEYS).forEach(keys => { s += headerScore(c, keys) > 0 ? 1 : 0; });
      });
      if (filled >= 2 && s > bestScore) { bestScore = s; bestRow = r; }
    }
    return bestRow;
  }

  function detectColumns(headers, sampleRows) {
    const mapping = {}; const used = new Set();
    const order = ['lat', 'lng', 'cp', 'numero', 'colonia', 'direccion', 'nombre', 'id', 'municipio', 'telefono', 'referencias'];
    for (const role of order) {
      let best = -1, bs = 0;
      headers.forEach((h, i) => {
        if (used.has(i)) return;
        let s = headerScore(h, ROLE_KEYS[role]);
        if (s && (role === 'lat' || role === 'lng') && sampleRows) {
          const nums = sampleRows.map(r => parseFloat(r[i])).filter(v => !isNaN(v));
          const ok = nums.filter(v => role === 'lat' ? (v > 14 && v < 33) : (v < -86 && v > -118)).length;
          if (nums.length && ok / nums.length < 0.6) s = 0;
        }
        if (s > bs) { bs = s; best = i; }
      });
      if (best >= 0 && bs >= 4) { mapping[role] = best; used.add(best); }
    }
    // Contenido: si no hay coordenadas por encabezado, busca columna con "lat,lng"
    if (mapping.lat == null && sampleRows) {
      headers.forEach((h, i) => {
        if (used.has(i) || mapping.coords != null) return;
        const hits = sampleRows.filter(r => /^\s*-?\d{1,2}\.\d+\s*,\s*-?\d{2,3}\.\d+\s*$/.test(String(r[i] || ''))).length;
        if (hits && hits / sampleRows.length > 0.5) { mapping.coords = i; used.add(i); }
      });
    }
    if (mapping.nombre == null) { // primera columna de texto no usada
      for (let i = 0; i < headers.length; i++) if (!used.has(i)) { mapping.nombre = i; break; }
    }
    return mapping;
  }

  // ------------------------------------------------------------- zonificación
  /**
   * Divide nodos en k sectores angulares contiguos alrededor del centro,
   * balanceando la carga (peso) y prefiriendo cortar en huecos angulares.
   * nodes: [{id, bearing, weight}]
   * Devuelve { cuts:[ángulos], assign: Map(id → sector), loads:[...] }
   */
  function partitionSectors(nodes, k) {
    k = k || 3;
    const items = nodes.slice().sort((a, b) => a.bearing - b.bearing);
    const n = items.length;
    if (n === 0) return { cuts: [0, 120, 240], assign: new Map(), loads: new Array(k).fill(0) };
    if (n <= k) {
      const assign = new Map(); items.forEach((it, i) => assign.set(it.id, i));
      const cuts = items.map((it, i) => (it.bearing + angGap(items, i) / 2) % 360);
      while (cuts.length < k) cuts.push((cuts[cuts.length - 1] + 360 / k) % 360);
      return { cuts, assign, loads: items.map(it => it.weight) };
    }
    const W = items.reduce((s, it) => s + it.weight, 0);
    // huecos: gap[i] = separación angular entre item i e i+1 (circular)
    const gap = items.map((_, i) => angGap(items, i));
    const maxGap = Math.max(...gap) || 1;
    // Candidatos de rotación: inicio de sector en cada índice
    let best = null;
    const step = n > 1500 ? Math.ceil(n / 1500) : 1;
    for (let s = 0; s < n; s += step) {
      // pesos acumulados desde s
      const cum = new Array(n + 1); cum[0] = 0;
      for (let j = 0; j < n; j++) cum[j + 1] = cum[j] + items[(s + j) % n].weight;
      const cutsIdx = [];
      let prev = 0, ok = true;
      for (let c = 1; c < k; c++) {
        const target = (W * c) / k;
        // primer j con cum[j] >= target
        let lo = prev + 1, hi = n - (k - c);
        let j = lo; while (j < hi && cum[j] < target) j++;
        // evaluar j-1, j y considerar huecos cercanos (±2)
        let bj = j, bc = Infinity;
        for (let t = Math.max(lo, j - 2); t <= Math.min(hi, j + 2); t++) {
          const imb = Math.abs(cum[t] - target) / (W || 1);
          const g = gap[(s + t - 1 + n) % n] / maxGap;
          const cost = imb - 0.06 * g;
          if (cost < bc) { bc = cost; bj = t; }
        }
        if (bj <= prev) { ok = false; break; }
        cutsIdx.push(bj); prev = bj;
      }
      if (!ok) continue;
      const bounds = [0, ...cutsIdx, n];
      const loads = []; for (let c = 0; c < k; c++) loads.push(cum[bounds[c + 1]] - cum[bounds[c]]);
      const imbalance = (Math.max(...loads) - Math.min(...loads)) / (W || 1);
      // hueco en los k cortes (incluye el corte de rotación s)
      let gsum = gap[(s - 1 + n) % n];
      cutsIdx.forEach(t => { gsum += gap[(s + t - 1) % n]; });
      const cost = imbalance - 0.05 * (gsum / (k * maxGap));
      if (!best || cost < best.cost) best = { cost, s, cutsIdx, loads };
    }
    const assign = new Map();
    const { s, cutsIdx, loads } = best;
    const bounds = [0, ...cutsIdx, n];
    for (let c = 0; c < k; c++) for (let j = bounds[c]; j < bounds[c + 1]; j++) assign.set(items[(s + j) % n].id, c);
    // ángulos de corte = punto medio del hueco
    const cuts = [0, ...cutsIdx].map(t => {
      const ia = (s + t - 1 + n) % n;
      return (items[ia].bearing + angGap(items, ia) / 2) % 360;
    });
    return { cuts, assign, loads };
  }
  function angGap(items, i) {
    const a = items[i].bearing, b = items[(i + 1) % items.length].bearing;
    const d = (b - a + 360) % 360; return d === 0 && items.length === 1 ? 360 : d;
  }

  /** Reordena sectores para que sus nombres sigan el sentido horario desde el norte */
  function orderSectors(part, nodes, k) {
    const meanBy = [];
    for (let c = 0; c < k; c++) {
      const ns = nodes.filter(n => part.assign.get(n.id) === c);
      meanBy.push({ c, mean: circularMean(ns.map(n => n.bearing), ns.map(n => Math.max(n.weight, 0.01))) });
    }
    meanBy.sort((a, b) => a.mean - b.mean);
    const remap = new Map(meanBy.map((m, i) => [m.c, i]));
    const assign = new Map(); part.assign.forEach((v, id) => assign.set(id, remap.get(v)));
    const loads = new Array(k).fill(0); part.loads.forEach((l, c) => { loads[remap.get(c)] = l; });
    return { cuts: part.cuts.slice().sort((a, b) => a - b), assign, loads, means: meanBy.map(m => m.mean) };
  }

  function sectorNames(means) {
    const names = means.map(directionName);
    // desambiguar si se repite
    const seen = {};
    return names.map((n, i) => { seen[n] = (seen[n] || 0) + 1; return seen[n] > 1 ? n + ' ' + seen[n] : n; });
  }

  /** Nodos cerca de la frontera entre sectores o en el núcleo del centro */
  function borderInfo(node, cuts, assignSector, coreKm) {
    if (node.distKm != null && node.distKm <= coreKm) return { shared: true, reason: 'centro' };
    let best = null;
    cuts.forEach(c => { const d = angDiff(node.bearing, c); if (!best || d < best.d) best = { d, c }; });
    // umbral angular decreciente con la distancia (frontera ≈ 1.2 km de ancho, mín 4°, máx 14°)
    const km = Math.max(node.distKm || 3, 0.5);
    const thr = Math.min(14, Math.max(4, toDeg(1.2 / km)));
    if (best && best.d <= thr) return { shared: true, reason: 'frontera', cut: best.c, angle: +best.d.toFixed(1) };
    return { shared: false };
  }

  // ------------------------------------------------------------------- ruteo
  function routeLength(path, start, dist) {
    let t = 0, prev = start;
    for (const p of path) { t += dist(prev, p); prev = p; }
    return t + dist(prev, start);
  }

  /** Recorrido cerrado desde start: vecino más cercano + 2-opt */
  function solveTour(stops, start, dist) {
    if (stops.length <= 1) return stops.slice();
    const rest = stops.slice(), tour = [];
    let cur = start;
    while (rest.length) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < rest.length; i++) { const d = dist(cur, rest[i]); if (d < bd) { bd = d; bi = i; } }
      cur = rest.splice(bi, 1)[0]; tour.push(cur);
    }
    // 2-opt sobre ciclo [start, ...tour, start]
    const pts = [start, ...tour, start];
    let improved = true, iter = 0;
    while (improved && iter < 60) {
      improved = false; iter++;
      for (let i = 1; i < pts.length - 2; i++) {
        for (let j = i + 1; j < pts.length - 1; j++) {
          const d0 = dist(pts[i - 1], pts[i]) + dist(pts[j], pts[j + 1]);
          const d1 = dist(pts[i - 1], pts[j]) + dist(pts[i], pts[j + 1]);
          if (d1 + 1e-9 < d0) { reverse(pts, i, j); improved = true; }
        }
      }
    }
    return pts.slice(1, -1);
  }
  function reverse(a, i, j) { while (i < j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; } }

  /**
   * Planea la ruta de un verificador.
   * stops: [{key, lat, lng, visits:[...], minutesFromCenter}]  (una parada por ubicación)
   * cfg: { base:{lat,lng}, visitMin, dayMin, maxPerDay, farFirst }
   */
  function planRoute(stops, cfg) {
    const base = cfg.base;
    const tf = cfg.traffic || 1;
    const dist = (a, b) => estimateDriveMin(a, b) * tf;
    const tour = solveTour(stops, base, dist);
    // dividir en días respetando jornada
    const days = []; let cur = [], t = 0, prev = base, count = 0;
    for (const s of tour) {
      const n = s.visits.length;
      const add = dist(prev, s) + n * cfg.visitMin;
      const back = dist(s, base);
      const over = cur.length && (t + add + back > cfg.dayMin || (cfg.maxPerDay && count + n > cfg.maxPerDay));
      if (over) { days.push(cur); cur = []; t = 0; prev = base; count = 0; }
      cur.push(s); t += (cur.length === 1 ? dist(base, s) + n * cfg.visitMin : add); count += n; prev = s;
    }
    if (cur.length) days.push(cur);
    // optimizar cada día y orientar: primero lo más lejano (salir temprano, regresar cerca de la base)
    return days.map((d, i) => {
      let order = solveTour(d, base, dist);
      if (order.length > 1) {
        const first = order[0], last = order[order.length - 1];
        const farFirst = cfg.farFirst !== false;
        if (farFirst ? dist(base, last) > dist(base, first) : dist(base, last) < dist(base, first)) order = order.reverse();
      }
      let drive = 0, p = base;
      order.forEach(s => { drive += dist(p, s); p = s; });
      const ret = order.length ? dist(p, base) : 0;
      const visits = order.reduce((s, x) => s + x.visits.length, 0);
      return {
        day: i + 1, stops: order, visits,
        driveMin: Math.round(drive + ret),
        workMin: Math.round(drive + ret + visits * cfg.visitMin),
        km: +(order.reduce((acc, s, k) => acc + haversineKm(k ? order[k - 1] : base, s), 0) * 1.35 + (order.length ? haversineKm(order[order.length - 1], base) * 1.35 : 0)).toFixed(1)
      };
    });
  }

  /** Enlaces de Google Maps (máx. 9 puntos intermedios por enlace) */
  function mapsLinks(base, stops, addressOf) {
    const enc = s => encodeURIComponent(s);
    const pt = s => {
      const a = addressOf && addressOf(s);
      return a ? a : (s.lat.toFixed(6) + ',' + s.lng.toFixed(6));
    };
    const links = []; const CH = 10;
    let origin = base.lat.toFixed(6) + ',' + base.lng.toFixed(6);
    for (let i = 0; i < stops.length; i += CH) {
      const chunk = stops.slice(i, i + CH);
      const dest = chunk[chunk.length - 1];
      const way = chunk.slice(0, -1).map(pt).join('|');
      let url = 'https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=' + enc(origin) + '&destination=' + enc(pt(dest));
      if (way) url += '&waypoints=' + enc(way);
      links.push({ from: i + 1, to: i + chunk.length, url });
      origin = pt(dest);
    }
    return links;
  }

  // --------------------------------------------------------- recomendaciones
  /**
   * ctx: { sectors:[{idx,name,verif,color,nodes:[...],visits,days:[...]}], unmatched, outOfRange, cfg }
   * Devuelve [{level:'clave'|'ruta'|'compartir'|'alerta', title, body, sector}]
   */
  function recommendations(ctx) {
    const recs = [];
    const S = ctx.sectors;
    const totalVisits = S.reduce((s, x) => s + x.visits, 0);
    const workloads = S.map(s => s.days.reduce((a, d) => a + d.workMin, 0));
    const maxW = Math.max(...workloads), minW = Math.min(...workloads);

    // 1. Panorama general
    if (totalVisits) {
      const daysMax = Math.max(...S.map(s => s.days.length));
      recs.push({
        level: 'clave', title: 'Panorama de la operación',
        body: `${totalVisits} visitas dentro del radio repartidas en 3 zonas (${S.map(s => `${s.verif}: ${s.visits}`).join(' · ')}). ` +
          `Con ${ctx.cfg.visitMin} min por visita y jornada de ${Math.round(ctx.cfg.dayMin / 60 * 10) / 10} h, la operación completa toma ~${daysMax} día(s) hábiles trabajando en paralelo.`
      });
    }

    // 2. Balance de carga
    if (totalVisits && maxW > 0) {
      const ratio = minW ? maxW / minW : Infinity;
      if (ratio > 1.25) {
        const hi = S[workloads.indexOf(maxW)], lo = S[workloads.indexOf(minW)];
        const movable = hi.nodes.filter(n => n.border && n.border.shared && n.visits > 0 && (n.neighbor === lo.idx || n.border.reason === 'centro'));
        recs.push({
          level: 'alerta', title: `Carga desbalanceada: ${hi.verif} trae ${Math.round((ratio - 1) * 100)}% más tiempo que ${lo.verif}`,
          body: movable.length
            ? `Mueve a ${lo.verif} estas colonias de frontera (están pegadas a su zona): ${movable.slice(0, 8).map(n => `${n.name} (${n.visits})`).join(', ')}. Usa el selector de verificador en la pestaña Zonas.`
            : `Las visitas de ${hi.verif} están concentradas lejos de la frontera. Considera que ${lo.verif} apoye a ${hi.verif} un día completo en su zona (ver "Día de apoyo").`,
          sector: hi.idx
        });
      } else {
        recs.push({ level: 'clave', title: 'Carga equilibrada', body: `La diferencia entre la zona más cargada y la más ligera es de ${Math.round((ratio - 1) * 100)}%. No es necesario mover colonias.` });
      }
    }

    // 3. Estrategia por verificador
    S.forEach(s => {
      if (!s.visits) {
        recs.push({ level: 'ruta', sector: s.idx, title: `${s.verif} · Zona ${s.name}`, body: 'Sin visitas asignadas en esta zona con el Excel actual. Puede funcionar como apoyo de las otras zonas.' });
        return;
      }
      const withV = s.nodes.filter(n => n.visits > 0);
      const rural = withV.filter(n => ['Poblado', 'Ranchería', 'Rancho', 'Ejido'].includes(n.type));
      const far = withV.slice().sort((a, b) => (b.minutes || 0) - (a.minutes || 0));
      const top = withV.slice().sort((a, b) => b.visits - a.visits).slice(0, 3);
      const d1 = s.days[0];
      const firstStop = d1 && d1.stops[0];
      const lines = [];
      lines.push(`Arranque sugerido del día 1: salir directo a ${firstStop ? firstStop.label : '—'} (punto más alejado del día) y trabajar de regreso hacia la base; así el tramo largo se hace temprano y la jornada cierra cerca de la oficina.`);
      if (rural.length) lines.push(`Poblados/rancherías con visitas (${rural.length}): ${rural.slice(0, 6).map(n => `${n.name} ${Math.round(n.minutes || 0)} min`).join(', ')}. Agrúpalos en un mismo día por carretera y no los mezcles con colonias del centro.`);
      if (top.length) lines.push(`Mayor concentración: ${top.map(n => `${n.name} (${n.visits})`).join(', ')}. Ahí conviene estacionarse una vez y recorrer a pie.`);
      if (far[0]) lines.push(`Punto más lejano de la zona: ${far[0].name} (~${Math.round(far[0].minutes || 0)} min del centro).`);
      lines.push(`Plan: ${s.days.length} día(s), ${s.visits} visitas, ~${s.days.reduce((a, d) => a + d.km, 0).toFixed(0)} km de manejo estimado.`);
      recs.push({ level: 'ruta', sector: s.idx, title: `${s.verif} · Zona ${s.name}`, body: lines.join('\n') });
    });

    // 4. Frontera compartida
    for (let a = 0; a < S.length; a++) {
      const b = (a + 1) % S.length;
      const shared = [...S[a].nodes, ...S[b].nodes].filter(n => n.visits > 0 && n.border && n.border.reason === 'frontera' && (n.neighbor === a || n.neighbor === b));
      if (shared.length) {
        recs.push({
          level: 'compartir', title: `Frontera compartida ${S[a].verif} ↔ ${S[b].verif}`,
          body: `Colonias pegadas al límite: ${shared.slice(0, 10).map(n => `${n.name} (${n.visits}, hoy ${S[n.sector].verif})`).join(', ')}. ` +
            `Regla práctica: quien termine primero su día toma las visitas pendientes de esta franja, avisando por WhatsApp para no duplicar.`
        });
      }
    }
    const core = S.flatMap(s => s.nodes.filter(n => n.visits > 0 && n.border && n.border.reason === 'centro'));
    if (core.length) {
      recs.push({
        level: 'compartir', title: 'Centro histórico como zona comodín',
        body: `${core.reduce((a, n) => a + n.visits, 0)} visitas caen en el núcleo del centro (${core.slice(0, 6).map(n => n.name).join(', ')}). Están a minutos de todos: úsalas para rellenar huecos al final del día de cualquier verificador.`
      });
    }

    // 5. Día de apoyo
    if (totalVisits) {
      const dl = S.map(s => s.days.length);
      const mx = Math.max(...dl), mn = Math.min(...dl);
      if (mx - mn >= 2) {
        const hi = S[dl.indexOf(mx)], lo = S[dl.indexOf(mn)];
        const lastDay = hi.days[hi.days.length - 1];
        recs.push({
          level: 'compartir', title: `Día de apoyo: ${lo.verif} → zona ${hi.name}`,
          body: `${lo.verif} termina ~${mx - mn} día(s) antes. Que tome el día ${lastDay.day} de ${hi.verif} (${lastDay.visits} visitas, ${lastDay.stops.slice(0, 4).map(x => x.label).join(', ')}) para cerrar la operación al mismo tiempo.`
        });
      }
    }

    // 6. Alertas de datos
    if (ctx.unmatched) recs.push({ level: 'alerta', title: `${ctx.unmatched} visitas sin ubicar`, body: 'No se encontró su colonia en el catálogo. Usa "Geocodificar pendientes" o asígnalas manualmente en la pestaña Cargar.' });
    if (ctx.outOfRange) recs.push({ level: 'alerta', title: `${ctx.outOfRange} visitas fuera del radio de ${ctx.cfg.maxMin} min`, body: 'Quedan fuera de las 3 zonas. Programa una salida foránea dedicada o ajusta el límite de minutos en Ajustes.' });
    return recs;
  }

  const Core = {
    haversineKm, bearing, destination, estimateDriveMin, angDiff, circularMean, directionName,
    stripAccents, normalizeName, baseName, classifyPlace, buildIndex, matchPlace, scanAddress,
    normHeader, findHeaderRow, detectColumns, partitionSectors, orderSectors, sectorNames, borderInfo,
    solveTour, planRoute, mapsLinks, recommendations, routeLength
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core; else root.Core = Core;
})(typeof window !== 'undefined' ? window : globalThis);
