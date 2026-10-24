/* =========================================================================
   Rutas Verificadores · Aplicación (UI, estado, exportación)
   ========================================================================= */
(function () {
  'use strict';
  const C = window.Core, G = window.Geo;
  const $ = s => document.querySelector(s), $$ = s => Array.from(document.querySelectorAll(s));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LS = 'rv1:';

  const DEFAULT_CFG = {
    center: { lat: 24.0245, lng: -104.6700 },   // Plaza de Armas / Catedral, Durango
    base: null, maxMin: 0, traffic: 1.1, visitMin: 20, dayH: 8, maxPerDay: 0, farFirst: true,
    verifs: ['Verificador 1', 'Verificador 2', 'Verificador 3'], users: ['', '', ''], gKey: ''
  };
  const APP = window.APP_CONFIG || {};
  if (APP.base) DEFAULT_CFG.base = APP.base;
  if (APP.gKey) DEFAULT_CFG.gKey = APP.gKey;
  const BASE_LABEL = APP.baseLabel || 'Base de salida';
  const ROLES = [
    ['id', 'Folio / ID'], ['nombre', 'Nombre'], ['direccion', 'Domicilio / calle'], ['numero', 'Número ext.'],
    ['colonia', 'Colonia / fracc. / poblado'], ['municipio', 'Municipio / ciudad'], ['cp', 'C.P.'],
    ['lat', 'Latitud'], ['lng', 'Longitud'], ['coords', 'Coordenadas "lat, lng"'], ['telefono', 'Teléfono'], ['referencias', 'Referencias'],
    ['asignado', 'Columna donde va el verificador (Asignada a)']
  ];
  const RURAL = ['Poblado', 'Ranchería', 'Rancho', 'Ejido'];

  // ------------------------------------------------------------------ estado
  const load = (k, d) => { try { const v = localStorage.getItem(LS + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(LS + k, JSON.stringify(v)); return true; } catch (e) { return false; } };

  const state = {
    cfg: (() => { const c = Object.assign({}, DEFAULT_CFG, load('cfg', {})); if (!c.gKey) c.gKey = DEFAULT_CFG.gKey; if (!c.base) c.base = DEFAULT_CFG.base; return c; })(),
    catalog: load('catalog', null),      // { places, center, radiusKm, source, fetchedAt }
    excel: load('excel', null),          // { fileName, sheet, sheets, headers, data, mapping }
    overrides: load('overrides', {}),    // nodeId → sector
    manual: load('manual', {}),          // visitKey → placeId
    geocoded: load('geocoded', {}),      // visitKey → {lat,lng}
    done: load('done', {}),              // visitKey → true
    visits: [], result: null, activeVerif: 0, workbook: null, index: null
  };
  // Catálogo oficial incluido (zonas fijas). Se usa por defecto y cuando no hay internet de mapas.
  const BUNDLED = window.CATALOGO_DURANGO || null;
  function bundledCatalog() {
    if (!BUNDLED) return null;
    const c = state.cfg.center;
    const places = BUNDLED.places.map(p => Object.assign({}, p, {
      distKm: +C.haversineKm(c, p).toFixed(2), bearing: +C.bearing(c, p).toFixed(1)
    }));
    return { places, center: Object.assign({}, BUNDLED.center), radiusKm: 0, source: BUNDLED.source, fetchedAt: Date.parse(BUNDLED.version + 'T12:00:00'),
      bundled: BUNDLED.version, fixedZones: true, zoneNames: BUNDLED.zoneNames, cuts: BUNDLED.cuts };
  }
  // Catálogos viejos guardados (de versiones anteriores, 20 min) se reemplazan por el oficial; solo se respeta uno que el usuario eligió.
  if (!state.catalog || !state.catalog.userChosen || (state.catalog.bundled && state.catalog.bundled !== (BUNDLED && BUNDLED.version))) {
    if (state.catalog && !state.catalog.userChosen) {   // había un catálogo viejo guardado: sus cambios de zona ya no aplican
      try { localStorage.removeItem(LS + 'catalog'); localStorage.removeItem(LS + 'overrides'); } catch (e) {}
      state.overrides = {};
    }
    state.catalog = bundledCatalog();
    // no se guarda en localStorage: viene incluido en la app
  }
  if (state.cfg.maxMin === 20 && !load('cfgMaxMinTouched', false)) state.cfg.maxMin = 0; // antes el límite era 20 min
  const noLimit = () => !(state.cfg.maxMin > 0);
  const colors = () => ['--v1', '--v2', '--v3'].map(v => getComputedStyle(document.documentElement).getPropertyValue(v).trim());
  const base = () => state.cfg.base || state.cfg.center;
  // Google Routes ya trae tráfico: el factor solo aplica a OSRM / estimados
  const eff = (m, src) => m == null ? null : (src === 'Google' ? m : m * state.cfg.traffic);

  function toast(msg, ms) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms || 3200);
  }
  function progress(sel, pct, text) {
    const p = $(sel); p.hidden = pct == null;
    if (pct == null) return;
    p.querySelector('div').style.width = Math.max(3, Math.min(100, pct)) + '%';
    p.querySelector('span').textContent = text || '';
  }

  // ------------------------------------------------------------- navegación
  $$('#tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  function showTab(name) {
    $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
    if (name === 'zonas') { ensureMap(); setTimeout(() => { map.invalidateSize(); drawMap(); }, 60); }
    window.scrollTo({ top: 0 });
  }

  // ============================================================== CATÁLOGO
  function renderCatalogStatus() {
    $$('.v-maxmin').forEach(e => { e.textContent = state.cfg.maxMin; });
    const el = $('#catStatus'), cat = state.catalog;
    if (!cat) { el.className = 'status'; el.textContent = 'Aún no se ha generado el catálogo.'; return; }
    const inR = cat.places.filter(p => noLimit() || eff(p.minutes, p.timeSource) <= state.cfg.maxMin);
    const byType = {};
    inR.forEach(p => { byType[p.type] = (byType[p.type] || 0) + 1; });
    const moved = C.haversineKm(cat.center, state.cfg.center) > 0.3;
    el.className = 'status ok';
    const cs = $('#catSummary'); if (cs) cs.textContent = `${cat.places.length.toLocaleString('es-MX')} colonias, fraccionamientos y poblados${cat.bundled ? ' en 3 zonas fijas' : ''}`;
    el.innerHTML = (cat.bundled ? `<b>Catálogo oficial incluido</b> (${esc(cat.bundled)}) · zonas fijas: ${cat.zoneNames.map(esc).join(' · ')}<br>` : '') +
      `<b>${inR.length}</b> asentamientos ${noLimit() ? '(sin límite de minutos)' : 'a ≤ ' + state.cfg.maxMin + ' min'} de ${cat.places.length} · ` +
      Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} ${esc(t)}`).join(' · ') +
      `<br><small class="muted">Tiempos: ${esc(cat.source)} · factor tráfico ×${state.cfg.traffic} (solo OSRM/estimados) · ${new Date(cat.fetchedAt).toLocaleString('es-MX')}</small>` +
      (moved && !cat.bundled ? '<br><b style="color:var(--warn)">El centro cambió: vuelve a generar el catálogo.</b>' : '') +
      (!cat.bundled && BUNDLED ? '<br><button class="btn sm" id="btnBundled" type="button">Volver al catálogo oficial incluido</button>' : '');
    const bb = $('#btnBundled'); if (bb) bb.onclick = () => { state.catalog = bundledCatalog(); state.index = null; try { localStorage.removeItem(LS + 'catalog'); } catch (e) {} renderCatalogStatus(); compute(); toast('Catálogo oficial restaurado'); };
  }

  $('#btnCatalog').addEventListener('click', async () => {
    const btn = $('#btnCatalog'); btn.disabled = true;
    const cfg = state.cfg, center = cfg.center;
    const radiusKm = noLimit() ? 45 : Math.min(60, Math.max(15, cfg.maxMin * 1.5));
    try {
      progress('#catProgress', 5, 'Consultando OpenStreetMap…');
      let places = await G.fetchSettlements(center, radiusKm, t => progress('#catProgress', 10, t));
      progress('#catProgress', 25, `${places.length} asentamientos encontrados. Calculando tiempos…`);
      // descarta lo que ni a 100 km/h en línea recta llega en el límite
      const far = [], near = [];
      places.forEach(p => (!noLimit() && p.distKm / 100 * 60 > cfg.maxMin * 1.2 ? far : near).push(p));
      far.forEach(p => { p.minutes = +C.estimateDriveMin(center, p).toFixed(1); p.km = +(p.distKm * 1.35).toFixed(1); p.timeSource = 'estimado'; });
      let source = 'OSRM (OpenStreetMap, sin tráfico)';
      const onP = t => { const m = t.match(/(\d+)\/(\d+)/); progress('#catProgress', m ? 25 + 70 * (+m[1] / +m[2]) : 50, t); };
      if (cfg.gKey) {
        try { await G.googleFromCenter(cfg.gKey, center, near, onP); source = 'Google Routes API (con tráfico, día hábil 10:00)'; }
        catch (e) { toast('Google Maps falló (' + e.message + '). Usando OSRM.', 5000); await G.osrmFromCenter(center, near, onP); }
      } else await G.osrmFromCenter(center, near, onP);
      places = near.concat(far);
      const est = near.filter(p => p.timeSource === 'estimado').length;
      if (est) source += ` · ${est} estimados`;
      state.catalog = { places, center: Object.assign({}, center), radiusKm, source, fetchedAt: Date.now(), userChosen: true };
      state.index = null;
      if (!save('catalog', state.catalog)) toast('Catálogo generado (no se pudo guardar en el dispositivo).');
      progress('#catProgress', null);
      renderCatalogStatus(); compute();
      toast('Catálogo listo');
    } catch (e) {
      progress('#catProgress', null);
      toast(e.message || String(e), 6000);
    } finally { btn.disabled = false; }
  });

  // Importar catálogo propio (Nombre, Tipo, Lat, Lng, [Min], [Km])
  $('#catFile').addEventListener('change', async ev => {
    const f = ev.target.files[0]; if (!f) return;
    try {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames.find(n => /cat/i.test(n)) || wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
      const pick = (r, ...keys) => { for (const k of Object.keys(r)) if (keys.includes(C.normHeader(k))) return r[k]; return ''; };
      const center = state.cfg.center;
      const places = rows.map((r, i) => {
        const lat = parseFloat(pick(r, 'lat', 'latitud')), lng = parseFloat(pick(r, 'lng', 'lon', 'longitud'));
        const name = String(pick(r, 'nombre', 'asentamiento', 'colonia', 'name')).trim();
        if (!name || isNaN(lat) || isNaN(lng)) return null;
        const min = parseFloat(pick(r, 'min', 'minutos', 'min desde centro', 'min sin trafico'));
        const km = parseFloat(pick(r, 'km'));
        const type = String(pick(r, 'tipo', 'type')).trim() || C.classifyPlace({ name });
        return {
          id: 'i' + i, name, type, osm: 'importado', lat, lng,
          distKm: +C.haversineKm(center, { lat, lng }).toFixed(2), bearing: +C.bearing(center, { lat, lng }).toFixed(1),
          minutes: isNaN(min) ? null : min, km: isNaN(km) ? null : km, timeSource: isNaN(min) ? null : 'importado'
        };
      }).filter(Boolean);
      if (!places.length) throw new Error('El archivo necesita columnas Nombre, Lat y Lng.');
      const missing = places.filter(p => p.minutes == null);
      if (missing.length) {
        toast(`Calculando tiempos para ${missing.length} lugares…`);
        await G.osrmFromCenter(center, missing, t => progress('#catProgress', 50, t));
        progress('#catProgress', null);
      }
      state.catalog = { places, center: Object.assign({}, center), radiusKm: 0, source: 'Catálogo importado', fetchedAt: Date.now(), userChosen: true };
      state.index = null; save('catalog', state.catalog); renderCatalogStatus(); compute();
      toast(`Catálogo importado: ${places.length} lugares`);
    } catch (e) { toast(e.message, 6000); }
    ev.target.value = '';
  });

  // ================================================================= EXCEL
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach(e => drop.addEventListener(e, () => drop.classList.add('over')));
  ['dragleave', 'drop'].forEach(e => drop.addEventListener(e, () => drop.classList.remove('over')));
  $('#xlsFile').addEventListener('change', async ev => {
    const f = ev.target.files[0]; if (!f) return;
    try {
      const buf = await f.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array', cellDates: true });
      state.workbook = wb;
      // copia exacta del archivo para devolver la misma plantilla con el verificador lleno
      let b64 = ''; if (buf.byteLength < 3e6) { const u = new Uint8Array(buf); let str = ''; for (let i = 0; i < u.length; i += 0x8000) str += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); b64 = btoa(str); }
      state.fileB64 = b64;
      const counts = wb.SheetNames.map(n => (XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1 }) || []).length);
      const sheet = wb.SheetNames[counts.indexOf(Math.max(...counts))];
      readSheet(f.name, sheet);
      state.excel.b64 = b64;
    } catch (e) { toast('No se pudo leer el archivo: ' + e.message, 6000); }
    ev.target.value = '';
  });

  function readSheet(fileName, sheet) {
    const wb = state.workbook;
    const ws = wb.Sheets[sheet];
    const r0 = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']).s.r : 0;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: true });
    let hr = C.findHeaderRow(rows);
    // Plantillas con doble encabezado (clave técnica + etiqueta en español): usar el de mejor puntaje y saltar ambos
    let dataStart = hr + 1;
    const headerLike = row => C.headerRowScore(row) >= 3 && !(row || []).some(c => /\d{4,}/.test(String(c)));   // una fila de datos trae folios, C.P. o teléfonos
    if (headerLike(rows[hr + 1])) {
      dataStart = hr + 2;
      if (C.headerRowScore(rows[hr + 1]) > C.headerRowScore(rows[hr])) hr = hr + 1;
    }
    const keyRow = (hr > 0 && headerLike(rows[hr - 1])) ? rows[hr - 1] : (hr + 1 < dataStart ? rows[hr + 1] : null);
    const width = Math.max(...rows.slice(hr, hr + 50).map(r => r.length), 1);
    const headers = Array.from({ length: width }, (_, i) => String((rows[hr] || [])[i] ?? '').trim() || String((keyRow || [])[i] ?? '').trim() || ('Columna ' + (i + 1)));
    const data = [], rowNums = [];
    rows.slice(dataStart).forEach((r, k) => { if (r.some(c => String(c).trim() !== '')) { data.push(r); rowNums.push(r0 + dataStart + k); } });
    let mapping = C.detectColumns(headers, data.slice(0, 60));
    if (keyRow) {   // completa con la fila de claves (p. ej. userName) lo que la etiqueta no reveló
      const m2 = C.detectColumns(keyRow.map(h => String(h || '')), data.slice(0, 60));
      Object.keys(m2).forEach(k => { if (mapping[k] == null && !Object.values(mapping).includes(m2[k])) mapping[k] = m2[k]; });
    }
    state.excel = { fileName, sheet, sheets: wb.SheetNames, headers, data, mapping, rowNums, template: mapping.asignado != null };
    renderExcel();
  }

  function renderExcel() {
    const x = state.excel;
    if (!x) { $('#xlsInfo').hidden = $('#mapping').hidden = $('#mapActions').hidden = true; return; }
    const info = $('#xlsInfo');
    info.hidden = false; info.className = 'status ok';
    info.innerHTML = `<b>${esc(x.fileName)}</b> · ${x.data.length} visitas · ${x.headers.length} columnas` +
      (x.sheets && x.sheets.length > 1 && state.workbook
        ? ` · Hoja: <select id="sheetSel">${x.sheets.map(s => `<option ${s === x.sheet ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>` : ` · Hoja: ${esc(x.sheet)}`);
    const ss = $('#sheetSel'); if (ss) ss.onchange = () => readSheet(x.fileName, ss.value);
    const sample = i => { const v = x.data.find(r => String(r[i] ?? '').trim()); return v ? String(v[i]).slice(0, 28) : ''; };
    $('#mapping').hidden = false;
    $('#mapping').innerHTML = ROLES.map(([role, label]) => `
      <label>${label}
        <select data-role="${role}">
          <option value="">— no aplica —</option>
          ${x.headers.map((h, i) => `<option value="${i}" ${x.mapping[role] === i ? 'selected' : ''}>${esc(h)}${sample(i) ? ' · ' + esc(sample(i)) : ''}</option>`).join('')}
        </select>
      </label>`).join('');
    $$('#mapping select').forEach(s => s.addEventListener('change', () => {
      if (s.value === '') delete x.mapping[s.dataset.role]; else x.mapping[s.dataset.role] = +s.value;
    }));
    $('#mapActions').hidden = false;
  }

  $('#btnProcess').addEventListener('click', () => {
    const m = state.excel.mapping;
    if (m.colonia == null && m.direccion == null && m.lat == null && m.coords == null) {
      toast('Indica al menos la columna de colonia, domicilio o coordenadas.', 5000); return;
    }
    if (!state.catalog && m.lat == null && m.coords == null) { toast('Primero genera el catálogo de zonas (paso 1).', 5000); return; }
    if (!save('excel', state.excel)) toast('Archivo grande: se procesará, pero no quedará guardado al cerrar.', 4500);
    compute(); showTab('zonas');
  });

  function buildVisits() {
    const x = state.excel; if (!x) return [];
    const m = x.mapping;
    const g = (r, k) => (m[k] == null ? '' : String(r[m[k]] ?? '').trim());
    return x.data.map((r, i) => {
      let lat = parseFloat(g(r, 'lat')), lng = parseFloat(g(r, 'lng'));
      if ((isNaN(lat) || isNaN(lng)) && m.coords != null) {
        const mm = g(r, 'coords').match(/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/); if (mm) { lat = +mm[1]; lng = +mm[2]; }
      }
      const valid = !isNaN(lat) && !isNaN(lng) && Math.abs(lat) > 1 && Math.abs(lng) > 1;
      const dir = [g(r, 'direccion'), g(r, 'numero')].filter(Boolean).join(' ');
      const v = {
        i, row: r, id: g(r, 'id') || String(i + 1), nombre: g(r, 'nombre'), direccion: dir, colonia: g(r, 'colonia'),
        municipio: g(r, 'municipio'), cp: g(r, 'cp'), telefono: g(r, 'telefono'), referencias: g(r, 'referencias'),
        lat: valid ? lat : null, lng: valid ? lng : null
      };
      v.key = [v.id, v.nombre, v.direccion, v.colonia].join('|').toLowerCase();
      return v;
    });
  }

  // ============================================================== CÁLCULO
  function compute() {
    const cfg = state.cfg, center = cfg.center;
    const places = state.catalog ? state.catalog.places : [];
    if (!state.index) state.index = C.buildIndex(places);
    const byId = new Map(places.map(p => [p.id, p]));
    const inRange = p => p && (noLimit() || (eff(p.minutes, p.timeSource) != null && eff(p.minutes, p.timeSource) <= cfg.maxMin));
    const visits = state.visits = buildVisits();

    // 1) ubicar cada visita
    visits.forEach(v => {
      v.place = null; v.own = null; v.method = ''; v.score = null;
      const man = state.manual[v.key] && byId.get(state.manual[v.key]);
      const coords = (v.lat != null) ? { lat: v.lat, lng: v.lng } : state.geocoded[v.key];
      if (man) { v.place = man; v.method = 'manual'; }
      else if (coords) {
        v.own = coords; v.method = v.lat != null ? 'coordenadas' : 'geocodificada';
        let best = null, bd = 1.5;
        places.forEach(p => { const d = C.haversineKm(coords, p); if (d < bd) { bd = d; best = p; } });
        v.place = best;
      } else {
        let r = v.colonia ? C.matchPlace(v.colonia, state.index, center, null, v.cp) : null;
        // Buscar dentro del domicilio solo si no hay colonia (evita que una calle "Hidalgo" se confunda con "Rancho Hidalgo")
        if (!r && !v.colonia) r = C.scanAddress([v.direccion, v.referencias].join(' '), state.index, center);
        // Respaldo: si la colonia no aparece pero el C.P. sí, se asigna a la zona de ese código postal (para revisar)
        if (!r && v.cp) {
          const cp = String(v.cp).replace(/\D/g, '').slice(0, 5);
          const same = places.filter(p => String(p.cp || '') === cp);
          if (same.length) {
            const votes = {}; same.forEach(p => { votes[p.zona] = (votes[p.zona] || 0) + 1; });
            const z = +Object.keys(votes).sort((a, b) => votes[b] - votes[a])[0];
            const pick = same.filter(p => p.zona === z).sort((a, b) => (a.minutes ?? 1e9) - (b.minutes ?? 1e9))[0];
            r = { place: pick, method: 'por C.P.', score: null, options: same.length };
          }
        }
        if (r) { v.place = r.place; v.method = r.method; v.score = r.score; v.options = r.options || 1; }
      }
      v.minutes = v.own && !v.place ? eff(C.estimateDriveMin(center, v.own)) : (v.place ? eff(v.place.minutes, v.place.timeSource) : null);
      v.status = (!v.place && !v.own) ? 'none' : (!noLimit() && v.minutes > cfg.maxMin ? 'fuera' : 'ok');
    });

    // 2) nodos: asentamientos en radio + visitas con coordenadas propias sin asentamiento
    const nodes = new Map();
    places.filter(inRange).forEach(p => nodes.set(p.id, {
      id: p.id, name: p.name, type: p.type, cp: p.cp || '', lat: p.lat, lng: p.lng, minutes: eff(p.minutes, p.timeSource), km: p.km,
      distKm: p.distKm, bearing: p.bearing, timeSource: p.timeSource, zona: p.zona, list: []
    }));
    visits.filter(v => v.status === 'ok').forEach(v => {
      if (v.place && nodes.has(v.place.id)) { nodes.get(v.place.id).list.push(v); return; }
      const id = 'v:' + v.i, pt = v.own;
      nodes.set(id, {
        id, name: v.colonia || v.direccion || ('Visita ' + v.id), type: 'Ubicación propia', lat: pt.lat, lng: pt.lng,
        minutes: v.minutes, km: +(C.haversineKm(center, pt) * 1.35).toFixed(1), distKm: C.haversineKm(center, pt),
        bearing: C.bearing(center, pt), timeSource: 'estimado', list: [v]
      });
    });
    const N = Array.from(nodes.values());
    N.forEach(n => { n.visits = n.list.length; });
    const anyVisits = N.some(n => n.visits);
    N.forEach(n => { n.weight = n.visits ? n.visits * (1 + n.minutes / 60) : (anyVisits ? 0.02 : 1); });

    if (!N.length) { state.result = null; renderAll(); return; }

    // 3) sectores
    const cat = state.catalog || {};
    let part, cuts, names;
    if (cat.fixedZones) {
      cuts = cat.cuts.slice().sort((a, b) => a - b); names = cat.zoneNames.slice();
      const assign = new Map();
      const fixed = N.filter(n => n.zona != null);
      N.forEach(n => {
        if (n.zona != null) { assign.set(n.id, n.zona); return; }
        // ubicación propia: zona del asentamiento oficial más cercano
        let best = null, bd = Infinity;
        fixed.forEach(f => { const d = C.haversineKm(n, f); if (d < bd) { bd = d; best = f; } });
        assign.set(n.id, best ? best.zona : 0);
      });
      part = { assign };
    } else {
      part = C.orderSectors(C.partitionSectors(N, 3), N, 3);
      cuts = part.cuts; names = C.sectorNames(part.means);
    }
    // sector de cada arco (mayoría) para conocer vecinos
    const arcOf = b => { for (let j = 0; j < cuts.length; j++) { const a = cuts[j], z = cuts[(j + 1) % cuts.length]; const span = (z - a + 360) % 360 || 360; if ((b - a + 360) % 360 < span) return j; } return 0; };
    const arcVotes = cuts.map(() => [0, 0, 0]);
    N.forEach(n => { arcVotes[arcOf(n.bearing)][part.assign.get(n.id)] += 1 + n.weight; });
    const arcSector = arcVotes.map(v => v.indexOf(Math.max(...v)));
    const sectorAt = b => arcSector[arcOf((b + 360) % 360)];

    N.forEach(n => {
      n.auto = part.assign.get(n.id);
      n.sector = state.overrides[n.id] != null ? state.overrides[n.id] : n.auto;
      n.border = C.borderInfo(n, cuts, null, 1.2);
      if (n.border.reason === 'frontera') {
        const s1 = sectorAt(n.border.cut + 1.5), s0 = sectorAt(n.border.cut - 1.5);
        n.neighbor = n.sector === s1 ? s0 : s1;
      } else n.neighbor = null;
    });

    // 4) rutas por verificador
    const routeCfg = { base: base(), visitMin: cfg.visitMin, dayMin: cfg.dayH * 60, maxPerDay: cfg.maxPerDay, farFirst: cfg.farFirst, traffic: cfg.traffic };
    const col = colors();
    const sectors = [0, 1, 2].map(i => {
      const sn = N.filter(n => n.sector === i).sort((a, b) => a.name.localeCompare(b.name, 'es'));
      const stops = sn.filter(n => n.visits).map(n => ({
        key: n.id, label: n.name, type: n.type, lat: n.lat, lng: n.lng, minutes: n.minutes,
        visits: n.list.slice().sort((a, b) => (a.direccion || a.nombre).localeCompare(b.direccion || b.nombre, 'es'))
      }));
      const days = C.planRoute(stops, routeCfg);
      days.forEach(d => d.stops.forEach((s, k) => s.visits.forEach(v => { v.day = d.day; v.order = k + 1; v.sector = i; })));
      return { idx: i, name: names[i], verif: cfg.verifs[i], color: col[i], nodes: sn, visits: sn.reduce((a, n) => a + n.visits, 0), days };
    });
    visits.forEach(v => { if (v.status !== 'ok') { v.sector = null; v.day = null; v.order = null; } });

    const recs = C.recommendations({
      sectors, cfg: Object.assign({}, cfg, { dayMin: cfg.dayH * 60 }), unmatched: visits.filter(v => v.status === 'none').length, outOfRange: visits.filter(v => v.status === 'fuera').length
    });
    state.result = { nodes: N, cuts, arcSector, sectors, recs, names };
    renderAll();
  }

  // ================================================================ RENDER
  function renderAll() {
    renderCatalogStatus(); renderExcel(); renderMatch(); renderZones(); renderRoutes(); renderRecs();
    $('#btnExport').disabled = !state.result;
    $('#btnExportZonas').disabled = !state.result;
    $('#btnExportTpl').hidden = !(state.result && state.excel && state.excel.mapping && state.excel.mapping.asignado != null);
    if (map && $('#tab-zonas').classList.contains('active')) drawMap();
    const r = state.result;
    $('#subtitle').textContent = 'Municipio de Durango';
  }

  function renderMatch() {
    const V = state.visits, card = $('#matchCard');
    if (!V.length) { card.hidden = true; return; }
    card.hidden = false;
    const c = k => V.filter(k).length;
    const exact = c(v => statusOf(v) === 'Asignada');
    const approx = c(v => statusOf(v) === 'Revisar');
    const fuera = c(v => v.status === 'fuera'), none = c(v => v.status === 'none');
    $('#matchKpis').innerHTML = `
      <div class="kpi ok"><b>${exact}</b><span>Asignadas</span></div>
      <div class="kpi"><b>${approx}</b><span>Por revisar</span></div>
      ${noLimit() ? '' : `<div class="kpi warn"><b>${fuera}</b><span>Fuera de ${state.cfg.maxMin} min</span></div>`}
      <div class="kpi bad"><b>${none}</b><span>Sin ubicar</span></div>`;
    const pend = V.filter(v => v.status === 'none');
    const fz = V.filter(v => v.status === 'fuera');
    $('#pendActions').innerHTML = (pend.length ? `<button class="btn primary sm" id="btnGeo">Geocodificar pendientes (${pend.length})</button>` : '') +
      (approx ? `<button class="btn ghost sm" id="btnShowApprox">Revisar repetidas y aproximadas (${approx})</button>` : '');
    const places = state.catalog ? state.catalog.places : [];
    let dl = $('#placesList');
    if (!dl) { dl = document.createElement('datalist'); dl.id = 'placesList'; document.body.appendChild(dl); }
    if (dl.dataset.n !== String(places.length)) {
      dl.innerHTML = places.slice().sort((a, b) => a.name.localeCompare(b.name, 'es'))
        .map(p => `<option value="${esc(p.name)} · ${esc(p.type)}">`).join('');
      dl.dataset.n = places.length;
    }
    const row = v => `<div class="pend"><div><b>${esc(v.nombre || 'Visita ' + v.id)}</b><small>${esc([v.direccion, v.colonia, v.municipio].filter(Boolean).join(', ') || 'sin domicilio')}${v.status === 'fuera' ? ` · <span style="color:var(--warn)">${esc(v.place ? v.place.name : '')} ~${Math.round(v.minutes)} min</span>` : ''}${v.method && v.status === 'ok' ? ` · → ${esc(v.place ? v.place.name : '')} (${v.method}${v.score ? ' ' + v.score : ''})` : ''}</small></div>
      <input list="placesList" data-key="${esc(v.key)}" placeholder="Asignar colonia…"></div>`;
    const showList = (list, title) => list.length ? `<h3 class="small muted" style="margin:14px 0 4px">${title}</h3>` + list.slice(0, 300).map(row).join('') + (list.length > 300 ? `<p class="muted small">… y ${list.length - 300} más (ver exportación).</p>` : '') : '';
    $('#pendList').innerHTML = showList(pend, 'Sin ubicar — escribe la colonia correcta') + showList(fz, 'Fuera del radio (no se asignan)');
    bindPendInputs();
    const ba = $('#btnShowApprox');
    if (ba) ba.onclick = () => {
      const ap = V.filter(v => statusOf(v) === 'Revisar');
      $('#pendList').innerHTML = showList(ap, 'Coincidencias aproximadas — corrige si no es la colonia') + $('#pendList').innerHTML;
      bindPendInputs();
    };
    const bg = $('#btnGeo'); if (bg) bg.onclick = geocodePending;
  }
  function bindPendInputs() {
    const places = state.catalog ? state.catalog.places : [];
    $$('#pendList input[list]').forEach(inp => inp.addEventListener('change', () => {
      const name = inp.value.split(' · ')[0].trim();
      const p = places.filter(x => x.name === name).sort((a, b) => (a.minutes ?? 1e9) - (b.minutes ?? 1e9))[0];
      if (!p) { toast('Elige un nombre de la lista.'); return; }
      state.manual[inp.dataset.key] = p.id; save('manual', state.manual);
      toast(`Asignada a ${p.name}`); compute();
    }));
  }

  async function geocodePending() {
    const pend = state.visits.filter(v => v.status === 'none');
    const btn = $('#btnGeo'); btn.disabled = true;
    let ok = 0;
    for (let k = 0; k < pend.length; k++) {
      const v = pend[k];
      btn.textContent = `Geocodificando ${k + 1}/${pend.length}…`;
      const q = [v.direccion, v.colonia, v.cp, v.municipio || 'Durango', 'Durango, México'].filter(Boolean).join(', ');
      try {
        const r = await G.geocode(q, state.cfg.center, state.cfg.gKey);
        if (r && C.haversineKm(r, state.cfg.center) < 60) { state.geocoded[v.key] = { lat: r.lat, lng: r.lng }; ok++; }
      } catch (e) { /* continúa */ }
      await G.sleep(state.cfg.gKey ? 120 : 1100);
    }
    save('geocoded', state.geocoded);
    toast(`${ok} de ${pend.length} visitas geocodificadas`);
    compute();
  }

  // ---------------------------------------------------------------- zonas
  function renderZones() {
    const r = state.result, cards = $('#zoneCards');
    if (!r) {
      cards.innerHTML = `<div class="panel empty" style="grid-column:1/-1">Sube un Excel en Cargar para ver las 3 zonas.</div>`;
      $('#catTable tbody').innerHTML = ''; $('#legend').innerHTML = ''; return;
    }
    const totalW = r.sectors.reduce((a, s) => a + s.days.reduce((x, d) => x + d.workMin, 0), 0) || 1;
    const totalN = r.nodes.length;
    cards.innerHTML = r.sectors.map(s => {
      const w = s.days.reduce((x, d) => x + d.workMin, 0);
      const cnt = t => s.nodes.filter(n => t(n.type)).length;
      const share = state.visits.length ? w / totalW : s.nodes.length / totalN;
      const big = state.visits.length
        ? `<div><b>${s.visits}</b><span>visitas</span></div><div><b>${s.days.length}</b><span>${s.days.length === 1 ? 'día' : 'días'}</span></div><div><b>${(w / 60).toFixed(1)}</b><span>horas</span></div>`
        : `<div><b>${s.nodes.length}</b><span>asentamientos</span></div>`;
      return `<div class="zcard" style="--c:${s.color}">
        <div class="zname"><h3>${esc(s.verif)}</h3><span>Zona ${esc(s.name)}</span></div>
        <div class="big">${big}</div>
        <div class="mix">${cnt(t => t === 'Colonia')} colonias, ${cnt(t => t === 'Fraccionamiento')} fraccionamientos y ${cnt(t => RURAL.includes(t) || ['Pueblo', 'Granja', 'Hacienda'].includes(t))} poblados o ranchos</div>
        <div class="bar" title="Parte de la carga total"><i style="width:${Math.round(share * 100)}%"></i></div></div>`;
    }).join('');
    drawDial(r);
    $('#legend').innerHTML = r.sectors.map(s => `<span><i style="background:${s.color}"></i>${esc(s.verif)} · ${esc(s.name)}</span>`).join('') +
      `<span><i style="background:transparent;border:2px dashed var(--warn)"></i>Frontera compartible</span>`;
    const zs = $('#catZone'), cur = zs.value;
    zs.innerHTML = `<option value="">Todas las zonas</option>` + r.sectors.map(s => `<option value="${s.idx}">${esc(s.verif)} · ${esc(s.name)}</option>`).join('');
    zs.value = cur;
    const ts = $('#catType'), ct = ts.value, types = [...new Set(r.nodes.map(n => n.type))].sort();
    ts.innerHTML = `<option value="">Todos los tipos</option>` + types.map(t => `<option>${esc(t)}</option>`).join('');
    ts.value = types.includes(ct) ? ct : '';
    renderCatTable();
  }

  /** Brújula de zonas: tres arcos con los cortes reales desde la Catedral */
  function drawDial(r) {
    const svg = $('#zoneDial'); if (!svg) return;
    const cx = 110, cy = 110, R = 92, w = 22, pt = (a, rad) => [cx + rad * Math.sin(a * Math.PI / 180), cy - rad * Math.cos(a * Math.PI / 180)];
    const cuts = r.cuts.slice().sort((a, b) => a - b);
    let out = '';
    cuts.forEach((a, j) => {
      const z = cuts[(j + 1) % cuts.length]; const span = ((z - a + 360) % 360) || 360;
      const s = r.sectors[r.arcSector[j]]; const a0 = a + 1.2, a1 = a + span - 1.2, large = (a1 - a0) > 180 ? 1 : 0;
      const [x0, y0] = pt(a0, R), [x1, y1] = pt(a1, R), [x2, y2] = pt(a1, R - w), [x3, y3] = pt(a0, R - w);
      out += `<path d="M${x0} ${y0} A${R} ${R} 0 ${large} 1 ${x1} ${y1} L${x2} ${y2} A${R - w} ${R - w} 0 ${large} 0 ${x3} ${y3}Z" fill="${s.color}"><title>Zona ${esc(s.name)}: ${esc(s.verif)}</title></path>`;
      const mid = a + span / 2, [tx, ty] = pt(mid, R - w - 20);
      out += `<text x="${tx}" y="${ty}" text-anchor="middle" dominant-baseline="middle" font-size="12" font-weight="700" style="fill:${s.color}">${s.visits || s.nodes.length}</text>`;
    });
    ['N', 'E', 'S', 'O'].forEach((l, k) => { const [x, y] = pt(k * 90, R + 11); out += `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" font-size="10" font-weight="650" opacity=".55">${l}</text>`; });
    out += `<circle cx="${cx}" cy="${cy}" r="4" style="fill:var(--ink)"/><text x="${cx}" y="${cy + 18}" text-anchor="middle" font-size="9.5" opacity=".6">Catedral</text>`;
    svg.innerHTML = out;
  }

  function renderCatTable() {
    const r = state.result; if (!r) return;
    const q = C.normalizeName($('#catSearch').value), z = $('#catZone').value, t = $('#catType').value, only = $('#catOnlyVisits').checked;
    const rows = r.nodes.filter(n => (!q || C.normalizeName(n.name).includes(q)) && (z === '' || n.sector === +z) && (!t || n.type === t) && (!only || n.visits))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
    $('#catCount').textContent = `${rows.length} de ${r.nodes.length}`;
    let letter = '', html = '';
    rows.slice(0, 2500).forEach(n => {
      const L = C.stripAccents(n.name[0] || '#').toUpperCase();
      if (L !== letter) { letter = L; html += `<tr class="letter"><td colspan="6">${esc(L)}</td></tr>`; }
      const s = r.sectors[n.sector];
      html += `<tr><td>${esc(n.name)} ${n.border.shared ? `<span class="tag border" title="${n.border.reason === 'centro' ? 'Núcleo del centro: cualquiera puede cubrirla' : 'Pegada al límite con ' + esc(r.sectors[n.neighbor]?.verif || '')}">${n.border.reason === 'centro' ? 'centro' : 'frontera'}</span>` : ''}${state.overrides[n.id] != null ? ' <span class="tag">manual</span>' : ''}</td>
        <td>${esc(n.type)}</td><td class="n">${Math.round(n.minutes)}${n.timeSource === 'estimado' ? '<span class="tag est">≈</span>' : ''}</td><td class="n">${n.km ?? ''}</td><td class="n">${n.visits || ''}</td>
        <td><select data-node="${esc(n.id)}" style="--c:${s.color}">${r.sectors.map(o => `<option value="${o.idx}" ${o.idx === n.sector ? 'selected' : ''}>${esc(o.verif)} · ${esc(o.name)}${o.idx === n.auto ? ' (auto)' : ''}</option>`).join('')}</select></td></tr>`;
    });
    $('#catTable tbody').innerHTML = html || `<tr><td colspan="6" class="empty">Sin resultados</td></tr>`;
    $$('#catTable select[data-node]').forEach(sel => sel.addEventListener('change', () => {
      const n = r.nodes.find(x => x.id === sel.dataset.node);
      if (+sel.value === n.auto) delete state.overrides[n.id]; else state.overrides[n.id] = +sel.value;
      save('overrides', state.overrides); compute(); toast(`${n.name} → ${r.sectors[+sel.value].verif}`);
    }));
  }
  ['#catSearch', '#catZone', '#catType', '#catOnlyVisits'].forEach(s => $(s).addEventListener('input', renderCatTable));

  // ------------------------------------------------------------------ mapa
  let map = null, layer = null;
  function ensureMap() {
    if (map) return;
    const c = state.cfg.center;
    map = L.map('map', { preferCanvas: true }).setView([c.lat, c.lng], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
    layer = L.layerGroup().addTo(map);
  }
  function drawMap() {
    if (!map) return;
    layer.clearLayers();
    const r = state.result, c = state.cfg.center;
    L.circleMarker([c.lat, c.lng], { radius: 8, color: '#0B1F33', fillColor: '#fff', fillOpacity: 1, weight: 3 }).bindTooltip('Centro').addTo(layer);
    const b = base();
    if (state.cfg.base) L.circleMarker([b.lat, b.lng], { radius: 7, color: '#0B1F33', fillColor: '#0B1F33', fillOpacity: 1 }).bindTooltip(BASE_LABEL).addTo(layer);
    if (!r) return;
    // cuñas de cada sector
    r.cuts.forEach((a, j) => {
      const z = r.cuts[(j + 1) % r.cuts.length], span = ((z - a + 360) % 360) || 360;
      const inArc = r.nodes.filter(n => ((n.bearing - a + 360) % 360) < span);
      const ds = inArc.map(n => n.distKm).sort((x, y) => x - y);
      const p90 = ds.length ? ds[Math.floor(ds.length * 0.9)] : 6;   // sin dejar que un rancho lejano infle la cuña
      const rad = Math.max(5, Math.min(p90 + 1.5, 25));
      const pts = [[c.lat, c.lng]];
      for (let t = 0; t <= span; t += 3) { const p = C.destination(c, a + t, rad); pts.push([p.lat, p.lng]); }
      const p2 = C.destination(c, a + span, rad); pts.push([p2.lat, p2.lng]);
      const s = r.sectors[r.arcSector[j]];
      L.polygon(pts, { color: s.color, weight: 1.5, dashArray: '6 6', fillColor: s.color, fillOpacity: 0.07 }).addTo(layer);
    });
    const bounds = [];
    r.nodes.forEach(n => {
      const s = r.sectors[n.sector];
      const rad = n.visits ? 5 + Math.min(10, Math.sqrt(n.visits) * 2.2) : 3.5;
      const m = L.circleMarker([n.lat, n.lng], {
        radius: rad, color: n.border.shared ? '#B26A00' : s.color, weight: n.border.shared ? 2 : 1,
        dashArray: n.border.shared ? '3 3' : null, fillColor: s.color, fillOpacity: n.visits ? 0.85 : 0.35
      });
      m.bindPopup(`<b>${esc(n.name)}</b><br>${esc(n.type)} · ${Math.round(n.minutes)} min · ${n.km ?? '?'} km<br>Zona ${esc(s.name)} · <b>${esc(s.verif)}</b><br>${n.visits} visita(s)${n.border.shared ? `<br><i>${n.border.reason === 'centro' ? 'Centro: zona comodín' : 'Frontera con ' + esc(r.sectors[n.neighbor]?.verif || '')}</i>` : ''}`);
      m.addTo(layer); if (n.visits || n.distKm < 12) bounds.push([n.lat, n.lng]);
    });
    if (bounds.length && !drawMap._fitted) { map.fitBounds(bounds, { padding: [20, 20] }); drawMap._fitted = true; }
  }

  // ------------------------------------------------------------------ rutas
  function addressOf(v) {
    const parts = [v.direccion, v.colonia || (v.place && v.place.name), v.cp, v.municipio || 'Durango', 'Dgo.'].filter(Boolean);
    return v.direccion ? parts.join(', ') : null;
  }
  function dayPoints(d) {
    // un punto por domicilio cuando existe; si no, el punto del asentamiento
    const pts = [];
    d.stops.forEach(s => {
      const withAddr = s.visits.filter(v => v.direccion);
      if (withAddr.length) withAddr.forEach(v => { const own = v.own; pts.push({ lat: own ? own.lat : s.lat, lng: own ? own.lng : s.lng, addr: own ? null : addressOf(v) }); });
      else pts.push({ lat: s.lat, lng: s.lng, addr: null });
    });
    return pts.filter((p, i) => !i || p.addr !== pts[i - 1].addr || p.lat !== pts[i - 1].lat);
  }

  function renderRoutes() {
    const r = state.result;
    if (!r) { $('#verifChips').innerHTML = ''; $('#routeSummary').innerHTML = '<div class="empty">Sube un Excel en Cargar para armar las rutas.</div>'; $('#routeDays').innerHTML = ''; return; }
    const ai = state.activeVerif;
    $('#verifChips').innerHTML = r.sectors.map(s => `<button class="chip ${s.idx === ai ? 'active' : ''}" style="--c:${s.color}" data-v="${s.idx}"><span class="dot"></span>${esc(s.verif)} · ${esc(s.name)}</button>`).join('');
    $$('#verifChips .chip').forEach(b => b.onclick = () => { state.activeVerif = +b.dataset.v; renderRoutes(); });
    const s = r.sectors[ai];
    const tot = s.days.reduce((a, d) => ({ w: a.w + d.workMin, km: a.km + d.km }), { w: 0, km: 0 });
    const doneN = s.days.reduce((a, d) => a + d.stops.reduce((x, st) => x + st.visits.filter(v => state.done[v.key]).length, 0), 0);
    $('#routeSummary').style.borderLeft = `5px solid ${s.color}`;
    $('#routeSummary').innerHTML = `<div class="list-head"><div><h2>${esc(s.verif)} · Zona ${esc(s.name)}</h2>
      <p class="muted">${s.visits} visitas · ${s.days.length} día(s) · ~${(tot.w / 60).toFixed(1)} h · ~${tot.km.toFixed(0)} km · avance ${doneN}/${s.visits}</p></div>
      <div class="row" style="gap:6px"><button class="btn sm" id="btnShareAll">Compartir plan</button></div></div>`;
    $('#btnShareAll').onclick = () => share(planText(s, null));
    const b = base();
    $('#routeDays').innerHTML = s.days.length ? s.days.map(d => {
      const links = C.mapsLinks(b, dayPoints(d), p => p.addr);
      return `<article class="day" style="--c:${s.color}">
        <header><h3>Día ${d.day} · ${d.visits} visitas</h3><span class="muted small">${d.stops.length} paradas · manejo ~${d.driveMin} min · jornada ~${(d.workMin / 60).toFixed(1)} h · ${d.km} km</span>
          <button class="btn sm" data-share="${d.day}">Compartir día</button></header>
        <div class="links">${links.map(l => `<a class="btn sm primary" target="_blank" rel="noopener" href="${l.url}">Google Maps ${links.length > 1 ? `(${l.from}–${l.to})` : ''}</a>`).join('')}</div>
        ${d.stops.map((st, k) => `<div class="stop"><span class="n">${k + 1}</span><div>
          <h4>${esc(st.label)} <span class="tag">${esc(st.type)}</span> <span class="muted small">${Math.round(st.minutes || 0)} min desde la base</span></h4>
          <ul>${st.visits.map(v => `<li class="${state.done[v.key] ? 'done' : ''}"><input type="checkbox" data-done="${esc(v.key)}" ${state.done[v.key] ? 'checked' : ''}><span><b>${esc(v.nombre || 'Visita ' + v.id)}</b>${v.direccion ? ' — ' + esc(v.direccion) : ''}${v.telefono ? ` · <a href="tel:${esc(v.telefono)}">${esc(v.telefono)}</a>` : ''}</span></li>`).join('')}</ul>
        </div></div>`).join('')}
      </article>`;
    }).join('') : '<div class="panel empty">Esta zona no tiene visitas asignadas.</div>';
    $$('[data-done]').forEach(c => c.onchange = () => {
      if (c.checked) state.done[c.dataset.done] = true; else delete state.done[c.dataset.done];
      save('done', state.done); c.closest('li').classList.toggle('done', c.checked);
    });
    $$('[data-share]').forEach(btn => btn.onclick = () => share(planText(s, +btn.dataset.share)));
  }

  function planText(s, dayNum) {
    const b = base();
    const days = dayNum ? s.days.filter(d => d.day === dayNum) : s.days;
    let t = `*${s.verif} · Zona ${s.name}*\n`;
    days.forEach(d => {
      t += `\n*Día ${d.day}* — ${d.visits} visitas, ~${(d.workMin / 60).toFixed(1)} h\n`;
      d.stops.forEach((st, k) => {
        t += `${k + 1}. ${st.label} (${st.type})\n`;
        st.visits.forEach(v => { t += `   • ${v.nombre || 'Visita ' + v.id}${v.direccion ? ' — ' + v.direccion : ''}\n`; });
      });
      C.mapsLinks(b, dayPoints(d), p => p.addr).forEach(l => { t += `Ruta ${l.from}-${l.to}: ${l.url}\n`; });
    });
    return t;
  }
  async function share(text) {
    if (navigator.share) { try { await navigator.share({ text }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    try { await navigator.clipboard.writeText(text); toast('Plan copiado. Pégalo en WhatsApp.'); }
    catch (e) { window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank'); }
  }

  // ------------------------------------------------------------ estrategia
  function renderRecs() {
    const r = state.result;
    if (!r) { $('#recs').innerHTML = '<div class="panel empty">Las recomendaciones aparecen al procesar el Excel.</div>'; return; }
    const lbl = { clave: 'Clave', ruta: 'Ruta', compartir: 'Trabajo compartido', alerta: 'Atención' };
    $('#recs').innerHTML = r.recs.map(x => {
      const c = x.level === 'ruta' && x.sector != null ? r.sectors[x.sector].color : null;
      return `<div class="rec ${x.level}" ${c ? `style="--c:${c}"` : ''}><h3><span class="lvl">${lbl[x.level]}</span>${esc(x.title)}</h3><p>${esc(x.body)}</p></div>`;
    }).join('');
  }

  // ============================================================ EXPORTAR
  // Excel con formato (ExcelJS): encabezados, anchos legibles, ajuste de texto, colores por zona, filtros y ligas.
  let exLoading = null;
  function loadExcelJS() {
    if (window.ExcelJS) return Promise.resolve();
    if (exLoading) return exLoading;
    exLoading = new Promise((res, rej) => {
      const sc = document.createElement('script'); sc.src = 'js/vendor/exceljs.min.js';
      sc.onload = () => res(); sc.onerror = () => { exLoading = null; rej(new Error('No se pudo cargar el generador de Excel')); };
      document.head.appendChild(sc);
    });
    return exLoading;
  }
  const ZONE_FILL = ['FFDBE7FB', 'FFFDE3D3', 'FFD7F0E3'], ZONE_INK = ['FF1E3A8A', 'FF9A3412', 'FF14532D'];
  const STATUS_FILL = { 'Asignada': 'FFC6EFCE', 'Revisar': 'FFFFE699', 'Sin ubicar': 'FFF8CBAD', 'Fuera de radio': 'FFF8CBAD' };
  const FONT = 'Arial';
  const fill = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
  const thin = { style: 'thin', color: { argb: 'FFD9D9D9' } };
  const BORDER = { top: thin, left: thin, bottom: thin, right: thin };
  const mapsUrl = q => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q);

  /** Agrega una tabla legible: cols = [{h, w?, min?, max?, wrap?, num?, link?, center?}] */
  function addTable(wb, name, cols, rows, opt) {
    opt = opt || {};
    const ws = wb.addWorksheet(safeName(name), {
      views: [{ state: 'frozen', ySplit: (opt.top || 0) + 1, xSplit: opt.freezeCols || 0 }],
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 1, margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } }
    });
    if (opt.title) {
      ws.addRow([opt.title]); const t = ws.getRow(1); t.font = { name: FONT, bold: true, size: 14, color: { argb: 'FF0B1F33' } }; t.height = 24;
      if (opt.subtitle) { ws.addRow([opt.subtitle]); ws.getRow(2).font = { name: FONT, italic: true, size: 10, color: { argb: 'FF666666' } }; }
      while (ws.rowCount < (opt.top || 0)) ws.addRow([]);
    }
    const hr = ws.addRow(cols.map(c => c.h));
    hr.height = 32;
    hr.eachCell(c => {
      c.font = { name: FONT, bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
      c.fill = fill('FF0B1F33'); c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }; c.border = BORDER;
    });
    const headerRow = hr.number;
    rows.forEach(r => {
      if (r && r.__section) {
        const sr = ws.addRow([r.__section]); ws.mergeCells(sr.number, 1, sr.number, cols.length);
        sr.getCell(1).font = { name: FONT, bold: true, size: 11, color: { argb: 'FF0B1F33' } };
        sr.getCell(1).fill = fill('FFE7ECF3'); sr.height = 22; sr.getCell(1).alignment = { vertical: 'middle' };
        return;
      }
      const vals = cols.map((c, i) => {
        const v = r.v[i];
        if (c.link && v) return { text: c.linkText || 'Abrir mapa', hyperlink: v };
        return v == null ? '' : v;
      });
      const row = ws.addRow(vals);
      row.eachCell({ includeEmpty: true }, (cell, ci) => {
        const c = cols[ci - 1]; if (!c) return;
        cell.font = c.link && r.v[ci - 1] ? { name: FONT, size: 10, color: { argb: 'FF0563C1' }, underline: true } : { name: FONT, size: 10 };
        cell.alignment = { vertical: 'top', wrapText: !!c.wrap, horizontal: c.num || c.center ? 'center' : 'left' };
        cell.border = BORDER;
        if (c.num && typeof cell.value === 'number') cell.numFmt = c.fmt || '0';
      });
      if (r.zone != null && opt.zoneCols) opt.zoneCols.forEach(ci => {
        const cell = row.getCell(ci); cell.fill = fill(ZONE_FILL[r.zone]); cell.font = { name: FONT, size: 10, bold: true, color: { argb: ZONE_INK[r.zone] } };
      });
      if (r.status && opt.statusCol) { const cell = row.getCell(opt.statusCol); cell.fill = fill(STATUS_FILL[r.status] || 'FFFFFFFF'); cell.font = { name: FONT, size: 10, bold: true }; }
      if (r.bold) row.font = { name: FONT, size: 10, bold: true };
    });
    // anchos: contenido real (máx. 200 filas), con mínimos y máximos legibles
    cols.forEach((c, i) => {
      let w = c.w;
      if (!w) {
        let mx = String(c.h).length * 0.9;
        rows.slice(0, 300).forEach(r => { if (r && r.v) { const v = r.v[i]; const l = c.link ? 11 : String(v == null ? '' : v).length; if (l > mx) mx = l; } });
        w = Math.max(c.min || 10, Math.min(c.max || 45, Math.ceil(mx + 3)));
      }
      ws.getColumn(i + 1).width = w;
    });
    const last = ws.rowCount;
    if (last > headerRow && !opt.noFilter) ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: last, column: cols.length } };
    return ws;
  }

  // ===================================================== EXPORTAR ZONAS
  // Excel para análisis: mapa segmentado (ciudad y municipio), listado por zona y fronteras.
  const EXPORT_COLORS = ['#2D5BD7', '#D27A1F', '#1F8A6E'];

  /** Para cada asentamiento: con qué otras zonas colinda (vecino de otra zona a poca distancia) */
  function zoneBorders(r) {
    const N = r.nodes, out = new Map();
    N.forEach(n => {
      const lim = n.distKm < 10 ? 1.2 : 3;
      const near = {};
      N.forEach(m => {
        if (m === n || m.sector === n.sector) return;
        const d = C.haversineKm(n, m); if (d <= lim && (near[m.sector] == null || d < near[m.sector])) near[m.sector] = d;
      });
      const zs = Object.keys(near).map(Number).sort((a, b) => near[a] - near[b]);
      out.set(n.id, { zones: zs, centro: n.distKm <= 1.2 });
    });
    return out;
  }

  /** Dibuja el mapa segmentado en un canvas (con calles de OpenStreetMap si están disponibles) y regresa PNG base64 */
  async function zoneMapPNG(r, borders, mode) {
    const W = 1600, H = 1100, c0 = state.cfg.center;
    const pts = mode === 'ciudad' ? r.nodes.filter(n => n.distKm <= 9) : r.nodes.filter(n => n.distKm <= 60);
    const q = (arr, f) => { const a = arr.slice().sort((x, y) => x - y); return a[Math.max(0, Math.min(a.length - 1, Math.round(f * (a.length - 1))))]; };
    const lo = mode === 'ciudad' ? 0.03 : 0.01, hi = 1 - lo;
    const lat2y = (lat, z) => { const s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** z; };
    const lng2x = (lng, z) => (lng + 180) / 360 * 256 * 2 ** z;
    const lats = pts.map(p => p.lat), lngs = pts.map(p => p.lng);
    const bb = { n: Math.max(q(lats, hi), c0.lat), s: Math.min(q(lats, lo), c0.lat), e: Math.max(q(lngs, hi), c0.lng), w: Math.min(q(lngs, lo), c0.lng) };
    // zoom fraccionario: el mapa llena el lienzo (las teselas se escalan)
    let z = 16;
    while (z > 6 && (lng2x(bb.e, z) - lng2x(bb.w, z) > W * 0.9 || lat2y(bb.s, z) - lat2y(bb.n, z) > H * 0.8)) z--;
    const cx = (lng2x(bb.e, z) + lng2x(bb.w, z)) / 2, cy = (lat2y(bb.s, z) + lat2y(bb.n, z)) / 2;
    const ox = cx - W / 2, oy = cy - H / 2 + 20;
    const P = p => [lng2x(p.lng, z) - ox, lat2y(p.lat, z) - oy];
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d');
    g.fillStyle = '#F3F5F7'; g.fillRect(0, 0, W, H);
    // fondo de calles (si la red lo permite)
    let tiles = 0;
    try {
      const t0x = Math.floor(ox / 256), t1x = Math.floor((ox + W) / 256), t0y = Math.floor(oy / 256), t1y = Math.floor((oy + H) / 256), jobs = [];
      for (let tx = t0x; tx <= t1x; tx++) for (let ty = t0y; ty <= t1y; ty++) jobs.push(new Promise(res => {
        const im = new Image(); im.crossOrigin = 'anonymous'; const to = setTimeout(() => res(null), 7000);
        im.onload = () => { clearTimeout(to); res({ im, tx, ty }); }; im.onerror = () => { clearTimeout(to); res(null); };
        im.src = `https://tile.openstreetmap.org/${z}/${tx}/${ty}.png`;
      }));
      (await Promise.all(jobs)).forEach(t => { if (t) { g.drawImage(t.im, t.tx * 256 - ox, t.ty * 256 - oy); tiles++; } });
      if (tiles) { g.fillStyle = 'rgba(255,255,255,.38)'; g.fillRect(0, 0, W, H); }
    } catch (e) { tiles = 0; }
    // cuñas de zona
    const [ccx, ccy] = P(c0), Rpx = Math.hypot(W, H);
    const cuts = r.cuts.slice().sort((a, b) => a - b);
    cuts.forEach((a, j) => {
      const b = cuts[(j + 1) % cuts.length], span = ((b - a + 360) % 360) || 360, sidx = r.arcSector[j];
      g.beginPath(); g.moveTo(ccx, ccy);
      for (let t = 0; t <= span; t += 1) { const ang = (a + t) * Math.PI / 180; g.lineTo(ccx + Rpx * Math.sin(ang), ccy - Rpx * Math.cos(ang)); }
      g.closePath(); g.fillStyle = EXPORT_COLORS[sidx] + '26'; g.fill();
    });
    g.setLineDash([14, 10]); g.lineWidth = 3; g.strokeStyle = '#14213D';
    cuts.forEach(a => { const ang = a * Math.PI / 180; g.beginPath(); g.moveTo(ccx, ccy); g.lineTo(ccx + Rpx * Math.sin(ang), ccy - Rpx * Math.cos(ang)); g.stroke(); });
    g.setLineDash([]);
    // asentamientos
    const R0 = mode === 'ciudad' ? 6 : 5;
    pts.forEach(n => {
      const [x, y] = P(n); if (x < -10 || y < -10 || x > W + 10 || y > H + 10) return;
      const b = borders.get(n.id), fr = b && b.zones.length;
      g.beginPath(); g.arc(x, y, R0 + (n.visits ? Math.min(6, Math.sqrt(n.visits) * 2) : 0), 0, 2 * Math.PI);
      g.fillStyle = EXPORT_COLORS[n.sector]; g.fill();
      g.lineWidth = fr ? 3 : 1.2; g.strokeStyle = fr ? '#111111' : '#FFFFFF'; g.stroke();
    });
    // etiquetas: poblados en el mapa del municipio, zonas siempre
    g.textBaseline = 'middle'; g.font = '600 15px Archivo, Arial, sans-serif';
    const boxes = [];
    const free = (x, y, w, h) => !boxes.some(b => x < b[0] + b[2] && x + w > b[0] && y < b[1] + b[3] && y + h > b[1]);
    const [kx, ky] = P(c0); boxes.push([kx - 230, ky - 60, 460, 120]);   // deja libre el centro
    boxes.push([10, H - 160, 440, 150]);   // leyenda
    cuts.forEach((a, j) => {
      const b = cuts[(j + 1) % cuts.length], span = ((b - a + 360) % 360) || 360, mid = (a + span / 2) * Math.PI / 180, s = r.sectors[r.arcSector[j]];
      const rr = Math.min(W, H) * 0.36, x = Math.max(160, Math.min(W - 160, ccx + rr * Math.sin(mid))), y = Math.max(110, Math.min(H - 90, ccy - rr * Math.cos(mid)));
      g.font = '800 34px Archivo, Arial, sans-serif'; g.textAlign = 'center';
      g.lineWidth = 8; g.strokeStyle = 'rgba(255,255,255,.92)'; g.strokeText('Zona ' + s.name, x, y); g.fillStyle = EXPORT_COLORS[s.idx]; g.fillText('Zona ' + s.name, x, y);
      g.font = '600 20px Archivo, Arial, sans-serif'; g.lineWidth = 6; g.strokeText(s.verif, x, y + 32); g.fillStyle = '#14213D'; g.fillText(s.verif, x, y + 32);
      g.textAlign = 'left';
      boxes.push([x - 170, y - 26, 340, 76]);
    });
    g.font = '600 15px Archivo, Arial, sans-serif'; g.textBaseline = 'middle';
    if (mode !== 'ciudad') pts.filter(n => ['Pueblo', 'Poblado', 'Ejido'].includes(n.type)).sort((a, b) => a.minutes - b.minutes).forEach(n => {
      const [x, y] = P(n); if (x < 0 || y < 70 || x > W || y > H) return;
      const w = g.measureText(n.name).width + 4, h = 18;
      if (x + 8 + w > W - 10 || !free(x + 8, y - h / 2, w, h)) return;
      boxes.push([x + 8, y - h / 2, w, h]);
      g.lineWidth = 4; g.strokeStyle = 'rgba(255,255,255,.9)'; g.strokeText(n.name, x + 9, y); g.fillStyle = '#14213D'; g.fillText(n.name, x + 9, y);
    });
    // centro y base
    const mark = (p, label, fill, dy) => { const [x, y] = P(p); g.beginPath(); g.arc(x, y, 9, 0, 2 * Math.PI); g.fillStyle = fill; g.fill(); g.lineWidth = 3; g.strokeStyle = '#fff'; g.stroke();
      g.font = '700 16px Archivo, Arial, sans-serif'; const w = g.measureText(label).width;
      const lx2 = dy < 0 ? x - w - 14 : x + 14, ly2 = y + (dy < 0 ? -16 : 16);
      g.lineWidth = 5; g.strokeStyle = 'rgba(255,255,255,.95)'; g.strokeText(label, lx2, ly2); g.fillStyle = '#14213D'; g.fillText(label, lx2, ly2); };
    mark(c0, 'Catedral (centro)', '#14213D', -1); mark(base(), 'Caja Hipódromo (salida)', '#B42318', 1);
    // encabezado, leyenda, norte y escala
    g.fillStyle = 'rgba(20,33,61,.92)'; g.fillRect(0, 0, W, 54);
    g.font = '700 24px Archivo, Arial, sans-serif'; g.fillStyle = '#fff'; g.textBaseline = 'middle';
    g.fillText(mode === 'ciudad' ? 'Zonas de verificación · Ciudad de Durango' : 'Zonas de verificación · Municipio de Durango', 22, 28);
    g.font = '500 15px Archivo, Arial, sans-serif'; g.textAlign = 'right';
    g.fillText(new Date().toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' }), W - 22, 28); g.textAlign = 'left';
    const lx = 20, ly = H - 150; g.fillStyle = 'rgba(255,255,255,.95)'; g.fillRect(lx, ly, 420, 132); g.strokeStyle = '#D9DFE7'; g.lineWidth = 1; g.strokeRect(lx, ly, 420, 132);
    r.sectors.forEach((s, k) => { g.beginPath(); g.arc(lx + 20, ly + 22 + k * 26, 8, 0, 2 * Math.PI); g.fillStyle = EXPORT_COLORS[k]; g.fill();
      g.fillStyle = '#14213D'; g.font = '600 15px Archivo, Arial, sans-serif'; g.fillText(`Zona ${s.name}: ${s.verif} (${s.nodes.length} asentamientos)`, lx + 38, ly + 22 + k * 26); });
    g.beginPath(); g.arc(lx + 20, ly + 100, 8, 0, 2 * Math.PI); g.fillStyle = '#9AA5B5'; g.fill(); g.lineWidth = 3; g.strokeStyle = '#111'; g.stroke();
    g.fillStyle = '#14213D'; g.fillText('Contorno negro = hace frontera con otra zona', lx + 38, ly + 100);
    g.setLineDash([8, 6]); g.beginPath(); g.moveTo(lx + 12, ly + 122); g.lineTo(lx + 30, ly + 122); g.stroke(); g.setLineDash([]); g.fillText('Límite entre zonas', lx + 38, ly + 122);
    // norte
    g.fillStyle = '#14213D'; g.beginPath(); g.moveTo(W - 50, 80); g.lineTo(W - 62, 112); g.lineTo(W - 38, 112); g.closePath(); g.fill();
    g.font = '700 16px Archivo, Arial, sans-serif'; g.textAlign = 'center'; g.fillText('N', W - 50, 126); g.textAlign = 'left';
    // escala (metros por pixel en la latitud de Durango)
    const mpp = 156543.03 * Math.cos(c0.lat * Math.PI / 180) / 2 ** z, nice = [500, 1000, 2000, 5000, 10000, 20000].find(m => m / mpp > 120) || 20000, px = nice / mpp;
    g.fillStyle = '#14213D'; g.fillRect(W - 40 - px, H - 40, px, 6); g.font = '600 14px Archivo, Arial, sans-serif'; g.textAlign = 'right';
    g.fillText(nice >= 1000 ? nice / 1000 + ' km' : nice + ' m', W - 40, H - 54);
    g.font = '400 12px Arial'; g.fillText(tiles ? '© OpenStreetMap' : 'Sin fondo de calles (sin acceso a mapas)', W - 40, H - 18); g.textAlign = 'left';
    return { b64: cv.toDataURL('image/png').split(',')[1], tiles };
  }

  $('#btnExportZonas').addEventListener('click', async () => {
    const r = state.result; if (!r) return;
    const btn = $('#btnExportZonas'), label = btn.innerHTML; btn.disabled = true; btn.textContent = 'Generando mapa…';
    try {
      await loadExcelJS();
      if (document.fonts && document.fonts.load) { try { await document.fonts.load('700 20px Archivo'); } catch (e) {} }
      const borders = zoneBorders(r);
      const [mCity, mMun] = [await zoneMapPNG(r, borders, 'ciudad'), await zoneMapPNG(r, borders, 'municipio')];
      const wb = new ExcelJS.Workbook(); wb.creator = 'Rutas Verificadores'; wb.created = new Date();
      const zn = i => 'Zona ' + r.sectors[i].name;
      const frText = n => { const b = borders.get(n.id); if (!b) return '';
        const z = b.zones.map(k => `${zn(k)} (${r.sectors[k].verif})`).join(' y ');
        return [z ? 'Hace frontera con ' + z : '', b.centro ? 'Centro: cerca de las 3 zonas' : ''].filter(Boolean).join(' · '); };
      const typeGroup = t => ['Colonia', 'Barrio', 'Unidad habitacional', 'Condominio'].includes(t) ? 'Colonias' : t === 'Fraccionamiento' ? 'Fraccionamientos' : ['Pueblo', 'Poblado', 'Ejido'].includes(t) ? 'Poblados y ejidos' : ['Ranchería', 'Rancho', 'Granja', 'Hacienda', 'Finca', 'Paraje'].includes(t) ? 'Rancherías y ranchos' : 'Otros';

      // 1) Mapa
      const wm = wb.addWorksheet('Mapa', { pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
      wm.getColumn(1).width = 4;
      wm.getCell('B1').value = 'Mapa de zonas de verificación'; wm.getCell('B1').font = { name: FONT, bold: true, size: 16, color: { argb: 'FF14213D' } };
      wm.getCell('B2').value = `Salida: ${BASE_LABEL}. Las líneas punteadas son los límites; los puntos con contorno negro hacen frontera con otra zona.`;
      wm.getCell('B2').font = { name: FONT, size: 10, color: { argb: 'FF555555' } };
      const i1 = wb.addImage({ base64: mCity.b64, extension: 'png' }), i2 = wb.addImage({ base64: mMun.b64, extension: 'png' });
      wm.addImage(i1, { tl: { col: 1, row: 3 }, ext: { width: 1120, height: 770 } });
      wm.getCell('B44').value = 'Municipio completo'; wm.getCell('B44').font = { name: FONT, bold: true, size: 13, color: { argb: 'FF14213D' } };
      wm.addImage(i2, { tl: { col: 1, row: 45 }, ext: { width: 1120, height: 770 } });

      // 2) Resumen
      const groups = ['Colonias', 'Fraccionamientos', 'Poblados y ejidos', 'Rancherías y ranchos', 'Otros'];
      const resRows = r.sectors.map(s => {
        const cnt = g => s.nodes.filter(n => typeGroup(n.type) === g).length;
        const fr = s.nodes.filter(n => borders.get(n.id).zones.length).length;
        return { zone: s.idx, v: [zn(s.idx), s.verif, s.nodes.length, ...groups.map(cnt), fr, s.visits || ''] };
      });
      resRows.push({ bold: true, v: ['Total', '', r.nodes.length, ...groups.map(g => r.nodes.filter(n => typeGroup(n.type) === g).length), r.nodes.filter(n => borders.get(n.id).zones.length).length, r.sectors.reduce((a, s) => a + s.visits, 0) || ''] });
      addTable(wb, 'Resumen', [{ h: 'Zona', min: 16 }, { h: 'Verificador', min: 18 }, { h: 'Total', num: true, w: 9 },
        ...groups.map(g => ({ h: g, num: true, w: 14 })), { h: 'Hacen frontera', num: true, w: 12 }, { h: 'Visitas cargadas', num: true, w: 12 }],
        resRows, { title: 'Resumen por zona', subtitle: 'Asentamientos del catálogo oficial (SEPOMEX + OpenStreetMap) asignados a cada zona.', top: 3, zoneCols: [1, 2], noFilter: true });

      // 3) Una hoja por zona, alfabética, con fronteras marcadas
      const zcols = [{ h: 'Nombre', wrap: true, min: 30, max: 44 }, { h: 'Tipo', min: 14 }, { h: 'Grupo', min: 16 }, { h: 'C.P.', center: true, w: 8 }, { h: 'Ámbito', min: 9 },
        { h: 'Min desde Caja Hipódromo', num: true, w: 13 }, { h: 'Km', num: true, w: 8, fmt: '0.0' }, { h: 'Frontera', wrap: true, min: 30, max: 50 }, { h: 'Visitas', num: true, w: 9 }, { h: 'Google Maps', link: true, w: 13 }];
      r.sectors.forEach(s => {
        const rows = s.nodes.slice().sort((a, b) => a.name.localeCompare(b.name, 'es')).map(n => {
          const ft = frText(n);
          return { status: ft.startsWith('Hace frontera') ? 'Revisar' : null, v: [n.name, n.type, typeGroup(n.type), n.cp || '', n.distKm < 10 && ['Colonia', 'Fraccionamiento', 'Barrio'].includes(n.type) ? 'Urbano' : (n.ambito || ''), Math.round(n.minutes || 0), n.km ?? '', ft, n.visits || '', mapsUrl(n.lat + ',' + n.lng)] };
        });
        const ws = addTable(wb, `${zn(s.idx)} - ${s.verif}`, zcols, rows, { title: `${zn(s.idx)} · ${s.verif}`, subtitle: `${s.nodes.length} asentamientos. La columna Frontera se marca en amarillo cuando colinda con otra zona.`, top: 3, statusCol: 8, freezeCols: 1 });
        ws.getRow(4).eachCell(c => { c.fill = fill('FF' + EXPORT_COLORS[s.idx].slice(1)); });
      });

      // 4) Fronteras
      const frRows = [];
      r.sectors.forEach(s => s.nodes.filter(n => borders.get(n.id).zones.length).sort((a, b) => a.name.localeCompare(b.name, 'es')).forEach(n => {
        const b = borders.get(n.id);
        frRows.push({ zone: s.idx, v: [zn(s.idx), s.verif, n.name, n.type, n.cp || '', b.zones.map(zn).join(' y '), b.zones.map(k => r.sectors[k].verif).join(' y '), Math.round(n.minutes || 0), n.visits || '', mapsUrl(n.lat + ',' + n.lng)] });
      }));
      addTable(wb, 'Fronteras', [{ h: 'Zona', min: 15 }, { h: 'Verificador', min: 16 }, { h: 'Asentamiento', wrap: true, min: 28, max: 42 }, { h: 'Tipo', min: 14 }, { h: 'C.P.', center: true, w: 8 },
        { h: 'Colinda con', min: 16, max: 30 }, { h: 'Verificador vecino', min: 16, max: 30 }, { h: 'Min desde Caja Hipódromo', num: true, w: 13 }, { h: 'Visitas', num: true, w: 9 }, { h: 'Google Maps', link: true, w: 13 }],
        frRows, { title: 'Asentamientos en la frontera entre zonas', subtitle: 'Cualquiera de los dos verificadores puede cubrirlos para equilibrar la carga.', top: 3, zoneCols: [1, 2] });

      // 5) Todo el catálogo, alfabético
      addTable(wb, 'Catálogo completo', [{ h: 'Nombre', wrap: true, min: 30, max: 44 }, { h: 'Tipo', min: 14 }, { h: 'C.P.', center: true, w: 8 }, { h: 'Zona', min: 15 }, { h: 'Verificador', min: 16 },
        { h: 'Min desde Caja Hipódromo', num: true, w: 13 }, { h: 'Frontera', wrap: true, min: 30, max: 50 }, { h: 'Lat', num: true, w: 11, fmt: '0.000000' }, { h: 'Lng', num: true, w: 12, fmt: '0.000000' }],
        r.nodes.slice().sort((a, b) => a.name.localeCompare(b.name, 'es')).map(n => ({ zone: n.sector, v: [n.name, n.type, n.cp || '', zn(n.sector), r.sectors[n.sector].verif, Math.round(n.minutes || 0), frText(n), +(+n.lat).toFixed(6), +(+n.lng).toFixed(6)] })),
        { zoneCols: [4, 5], freezeCols: 1 });

      const buf = await wb.xlsx.writeBuffer();
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      a.download = `mapa-zonas-verificadores-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      toast(mCity.tiles ? 'Excel de zonas generado' : 'Excel generado (el mapa salió sin fondo de calles porque la red bloquea los mapas)', 5000);
    } catch (e) { toast('No se pudo generar: ' + e.message, 6000); }
    finally { btn.disabled = false; btn.innerHTML = label; }
  });

  function statusOf(v) {
    if (v.status === 'none') return 'Sin ubicar';
    if (v.status === 'fuera') return 'Fuera de radio';
    return (v.method !== 'manual' && v.options > 1 || v.method === 'aproximada' || v.method === 'en dirección' || v.method === 'por C.P.') ? 'Revisar' : 'Asignada';
  }

  $('#btnExport').addEventListener('click', async () => {
    const r = state.result; if (!r) return;
    const btn = $('#btnExport'); btn.disabled = true; const label = btn.innerHTML; btn.textContent = 'Generando…';
    try {
      await loadExcelJS();
      const wb = new ExcelJS.Workbook(); wb.creator = 'Rutas Verificadores'; wb.created = new Date();
      const x = state.excel, cfg = state.cfg;
      const fecha = new Date().toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' });
      const sec = v => v.sector != null ? r.sectors[v.sector] : null;
      const mapsQ = v => v.own ? `${v.own.lat},${v.own.lng}` : (addressOf(v) || (v.place ? `${v.place.lat},${v.place.lng}` : ''));
      const how = v => v.method === 'nombre repetido' ? `Nombre repetido (${v.options} opciones)` : v.method === 'por C.P.' ? 'Solo por código postal' : (v.method || '');

      // 1) Resumen
      const tot = r.sectors.map(s => ({ s, h: s.days.reduce((a, d) => a + d.workMin, 0) / 60, km: s.days.reduce((a, d) => a + d.km, 0) }));
      const resumenRows = tot.map(({ s, h, km }) => ({ zone: s.idx, v: [s.verif, 'Zona ' + s.name, s.visits, s.days.length, +h.toFixed(1), Math.round(km),
        state.visits.filter(v => v.sector === s.idx && statusOf(v) === 'Revisar').length, s.nodes.length] }));
      const V = state.visits;
      resumenRows.push({ bold: true, v: ['Total', '', V.filter(v => v.status === 'ok').length, Math.max(0, ...r.sectors.map(s => s.days.length)), +tot.reduce((a, t) => a + t.h, 0).toFixed(1), Math.round(tot.reduce((a, t) => a + t.km, 0)), V.filter(v => statusOf(v) === 'Revisar').length, r.nodes.length] });
      resumenRows.push({ v: ['Sin ubicar', '', V.filter(v => v.status === 'none').length, '', '', '', '', ''] });
      if (!noLimit()) resumenRows.push({ v: ['Fuera de radio', '', V.filter(v => v.status === 'fuera').length, '', '', '', '', ''] });
      addTable(wb, 'Resumen', [
        { h: 'Verificador', min: 22 }, { h: 'Zona', min: 18 }, { h: 'Visitas', num: true, w: 11 }, { h: 'Días', num: true, w: 9 },
        { h: 'Horas estimadas', num: true, w: 12, fmt: '0.0' }, { h: 'Km estimados', num: true, w: 12 }, { h: 'Por revisar', num: true, w: 12 }, { h: 'Asentamientos en la zona', num: true, w: 15 }
      ], resumenRows, { title: 'Asignación de visitas por verificador', subtitle: `${x ? x.fileName + ' · ' : ''}${fecha} · Salida: ${BASE_LABEL} · ${cfg.visitMin} min por visita, jornada ${cfg.dayH} h`, top: 3, zoneCols: [1, 2], noFilter: true });

      // 2) Asignación (tu Excel original + columnas de asignación)
      if (x) {
        const orig = x.headers.map((h, i) => ({ h, wrap: true, max: 40, min: 9, i }));
        const add = [
          { h: 'Verificador', min: 16 }, { h: 'Zona', min: 14 }, { h: 'Día', num: true, w: 7 }, { h: 'Orden parada', num: true, w: 9 },
          { h: 'Asentamiento oficial', wrap: true, min: 22, max: 40 }, { h: 'Tipo', min: 13 }, { h: 'C.P.', center: true, w: 8 },
          { h: 'Min desde Caja Hipódromo', num: true, w: 13 }, { h: 'Cómo se encontró', min: 14, max: 26, wrap: true }, { h: 'Resultado', min: 13 }, { h: 'Google Maps', link: true, w: 13 }
        ];
        const rows = V.map(v => {
          const s = sec(v), q = mapsQ(v), st = statusOf(v);
          return { zone: s ? s.idx : null, status: st, v: [...x.headers.map((_, i) => (i === x.mapping.asignado && s) ? userOf(s.idx) : (v.row[i] ?? '')), s ? s.verif : '', s ? 'Zona ' + s.name : '', v.day ?? '', v.order ?? '',
            v.place ? v.place.name : (v.own ? 'Ubicación propia' : ''), v.place ? v.place.type : '', v.place ? (v.place.cp || '') : '',
            v.minutes != null ? Math.round(v.minutes) : '', how(v), st, q ? mapsUrl(q) : ''] };
        });
        const n0 = orig.length;
        addTable(wb, 'Asignación', [...orig, ...add], rows, { zoneCols: [n0 + 1, n0 + 2], statusCol: n0 + 10, freezeCols: Math.min(2, n0) });
      }

      // 3) Una hoja por verificador, en orden de ruta y separada por día
      r.sectors.forEach(s => {
        const rows = [];
        s.days.forEach(d => {
          rows.push({ __section: `Día ${d.day} · ${d.visits} visitas · ${d.stops.length} paradas · ~${(d.workMin / 60).toFixed(1)} h · ${d.km} km` });
          d.stops.forEach((st, k) => st.visits.forEach(v => {
            const q = mapsQ(v);
            rows.push({ zone: s.idx, status: statusOf(v), v: [d.day, k + 1, st.label, st.type, Math.round(st.minutes || 0), v.id, v.nombre, v.direccion, v.telefono, v.referencias, q ? mapsUrl(q) : '', statusOf(v), state.done[v.key] ? '☑' : '☐'] });
          }));
        });
        addTable(wb, `${s.verif} - ${s.name}`, [
          { h: 'Día', num: true, w: 6 }, { h: 'Parada', num: true, w: 8 }, { h: 'Colonia / asentamiento', wrap: true, min: 22, max: 34 }, { h: 'Tipo', min: 12, max: 16 },
          { h: 'Min desde Caja Hipódromo', num: true, w: 12 }, { h: 'Folio', min: 10, max: 16 }, { h: 'Nombre', wrap: true, min: 22, max: 34 }, { h: 'Domicilio', wrap: true, min: 26, max: 40 },
          { h: 'Teléfono', min: 12, max: 16 }, { h: 'Referencias', wrap: true, min: 16, max: 34 }, { h: 'Google Maps', link: true, w: 13 }, { h: 'Resultado', min: 11 }, { h: 'Hecho', center: true, w: 8 }
        ], rows, { title: `${s.verif} · Zona ${s.name}`, subtitle: `${s.visits} visitas · ${s.days.length} día(s) · salida desde ${BASE_LABEL}`, top: 3, statusCol: 12 });
      });

      // 4) Catálogo por zona (alfabético dentro de cada zona)
      const crow = r.nodes.slice().sort((a, b) => a.sector - b.sector || a.name.localeCompare(b.name, 'es')).map(n => ({ zone: n.sector, v: [
        'Zona ' + r.sectors[n.sector].name, r.sectors[n.sector].verif, n.name, n.type, n.cp || '', Math.round(n.minutes || 0), n.km ?? '', n.visits || '',
        n.border && n.border.shared ? (n.border.reason === 'centro' ? 'Centro (comodín)' : 'Frontera con ' + (r.sectors[n.neighbor]?.verif || '')) : '',
        state.overrides[n.id] != null ? 'Manual' : 'Oficial', mapsUrl(n.lat + ',' + n.lng)] }));
      addTable(wb, 'Catálogo por zona', [
        { h: 'Zona', min: 15 }, { h: 'Verificador', min: 16 }, { h: 'Nombre', wrap: true, min: 26, max: 42 }, { h: 'Tipo', min: 13 }, { h: 'C.P.', center: true, w: 8 },
        { h: 'Min desde Caja Hipódromo', num: true, w: 13 }, { h: 'Km', num: true, w: 8, fmt: '0.0' }, { h: 'Visitas', num: true, w: 9 }, { h: 'Frontera', min: 14, max: 28, wrap: true },
        { h: 'Asignación', min: 11 }, { h: 'Google Maps', link: true, w: 13 }
      ], crow, { zoneCols: [1, 2], freezeCols: 3 });

      // 5) Estrategia
      const lvl = { clave: 'Clave', ruta: 'Ruta', compartir: 'Trabajo compartido', alerta: 'Atención' };
      addTable(wb, 'Estrategia', [{ h: 'Tipo', w: 18 }, { h: 'Recomendación', w: 42, wrap: true }, { h: 'Detalle', w: 100, wrap: true }],
        r.recs.map(rc => ({ zone: rc.sector != null && rc.level === 'ruta' ? rc.sector : null, v: [lvl[rc.level] || rc.level, rc.title, rc.body] })), { zoneCols: [1], noFilter: true });

      // 6) Pendientes
      const pend = V.filter(v => statusOf(v) !== 'Asignada');
      if (pend.length) addTable(wb, 'Pendientes', [
        { h: 'Resultado', min: 12 }, { h: 'Folio', min: 10, max: 16 }, { h: 'Nombre', wrap: true, min: 22, max: 34 }, { h: 'Domicilio', wrap: true, min: 26, max: 40 },
        { h: 'Colonia en tu Excel', wrap: true, min: 20, max: 34 }, { h: 'Se asignó a', wrap: true, min: 22, max: 36 }, { h: 'Cómo se encontró', min: 16, max: 26, wrap: true }, { h: 'Zona', min: 14 }
      ], pend.map(v => ({ status: statusOf(v), zone: v.sector, v: [statusOf(v), v.id, v.nombre, v.direccion, v.colonia, v.place ? `${v.place.name} (${v.place.type}${v.place.cp ? ', C.P. ' + v.place.cp : ''})` : '', how(v), v.sector != null ? 'Zona ' + r.sectors[v.sector].name : ''] })),
        { statusCol: 1, zoneCols: [8] });

      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = `asignacion-verificadores-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      toast('Excel generado');
    } catch (e) { toast('No se pudo generar el Excel: ' + e.message, 6000); }
    finally { btn.disabled = false; btn.innerHTML = label; }
  });
  // Plantilla original con la columna "Asignada a" (userName) llena con el usuario de cada verificador
  const userOf = idx => (state.cfg.users && state.cfg.users[idx]) || state.cfg.verifs[idx];
  /**
   * Devuelve el MISMO archivo .xlsx (estilos, comentarios, encabezados, METADATA) cambiando solo las celdas indicadas.
   * Edita el XML de la hoja directamente; agrega los textos a sharedStrings como lo haría Excel.
   */
  function patchXlsx(b64, sheetName, colIdx, assign) {
    const CFB = XLSX.CFB, dec = new TextDecoder('utf-8'), enc = new TextEncoder();
    const cfb = CFB.read(b64, { type: 'base64' });
    const get = p => { const e = CFB.find(cfb, p); return e ? { e, text: dec.decode(e.content) } : null; };
    const put = (o, text) => { o.e.content = enc.encode(text); o.e.size = o.e.content.length; };
    const wbx = get('/xl/workbook.xml'), rels = get('/xl/_rels/workbook.xml.rels');
    const escRe = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const xmlEsc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const sheetTag = wbx.text.match(new RegExp('<sheet\\b[^>]*name="' + escRe(xmlEsc(sheetName)) + '"[^>]*/>'));
    if (!sheetTag) throw new Error('No se encontró la hoja ' + sheetName);
    const rid = sheetTag[0].match(/r:id="([^"]+)"/)[1];
    const target = rels.text.match(new RegExp('<Relationship\\b[^>]*Id="' + escRe(rid) + '"[^>]*/>'))[0].match(/Target="([^"]+)"/)[1];
    const path = '/' + (target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, ''));
    const sh = get(path); if (!sh) throw new Error('No se pudo abrir la hoja');
    // sharedStrings: índice para cada usuario
    let sst = get('/xl/sharedStrings.xml'), idxOf = new Map(), added = 0;
    if (sst) {
      let n = (sst.text.match(/<si>|<si /g) || []).length, extra = '';
      new Set(assign.values()).forEach(t => { idxOf.set(t, n++); extra += '<si><t xml:space="preserve">' + xmlEsc(t) + '</t></si>'; });
      sst.text = sst.text.replace('</sst>', extra + '</sst>')
        .replace(/uniqueCount="\d+"/, 'uniqueCount="' + n + '"')
        .replace(/count="(\d+)"/, (m, c) => 'count="' + (+c + assign.size) + '"');
      put(sst, sst.text);
    }
    const colL = XLSX.utils.encode_col(colIdx);
    const colStyle = (() => { // estilo de la columna (<col style=...>) para celdas que no existían
      const m = [...sh.text.matchAll(/<col\b([^>]*)\/>/g)].map(x => x[1]).find(a => { const mn = +(/min="(\d+)"/.exec(a) || [])[1], mx = +(/max="(\d+)"/.exec(a) || [])[1]; return colIdx + 1 >= mn && colIdx + 1 <= mx; });
      const st = m && /style="(\d+)"/.exec(m); return st ? st[1] : null;
    })();
    let xml = sh.text;
    assign.forEach((text, r0) => {
      const ref = colL + (r0 + 1);
      const cellXml = s => sst ? `<c r="${ref}"${s ? ` s="${s}"` : ''} t="s"><v>${idxOf.get(text)}</v></c>`
                                : `<c r="${ref}"${s ? ` s="${s}"` : ''} t="inlineStr"><is><t>${xmlEsc(text)}</t></is></c>`;
      const rowRe = new RegExp('(<row\\b[^>]*\\br="' + (r0 + 1) + '"[^>]*>)([\\s\\S]*?)(</row>)');
      xml = xml.replace(rowRe, (m, a, body, z) => {
        const cellRe = new RegExp('<c\\b[^>]*\\br="' + ref + '"[^>]*?(?:/>|>[\\s\\S]*?</c>)');
        const old = body.match(cellRe);
        if (old) { const st = /\bs="(\d+)"/.exec(old[0]); return a + body.replace(cellRe, cellXml(st ? st[1] : colStyle)) + z; }
        // insertar en orden de columna
        const cells = [...body.matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"/g)];
        const after = cells.find(c => XLSX.utils.decode_col(c[1]) > colIdx);
        const nc = cellXml(colStyle);
        return a + (after ? body.slice(0, after.index) + nc + body.slice(after.index) : body + nc) + z;
      });
    });
    put(sh, xml);
    return CFB.write(cfb, { fileType: 'zip', type: 'array', compression: true });
  }

  // Plantilla original con la columna "Asignada a" (userName) llena con el usuario de cada verificador
  $('#btnExportTpl').addEventListener('click', () => {
    const r = state.result, x = state.excel;
    if (!r || !x || x.mapping.asignado == null) return;
    if (!x.b64) { toast('Vuelve a subir el archivo para generar la plantilla.', 5000); return; }
    try {
      const assign = new Map(); let skipped = 0;
      state.visits.forEach(v => {
        const rr = x.rowNums[v.i]; if (rr == null) return;
        if (v.sector == null) { skipped++; return; }
        assign.set(rr, userOf(v.sector));
      });
      const out = patchXlsx(x.b64, x.sheet, x.mapping.asignado, assign);
      const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = x.fileName.replace(/\.(xlsx|xls|csv)$/i, '') + '_asignada.xlsx';
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      toast(`Plantilla lista: ${assign.size} visitas asignadas${skipped ? `, ${skipped} sin ubicar quedaron igual` : ''}.`, 5000);
    } catch (e) { toast('No se pudo generar la plantilla: ' + e.message, 6000); }
  });
  const safeName = s => s.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31);

  // ============================================================== AJUSTES
  function fillCfg() {
    const c = state.cfg;
    c.users = c.users || ['', '', ''];
    $('#verifNames').innerHTML = c.verifs.map((v, i) => `<div class="vfield" style="--c:var(--v${i + 1})">
      <label><span><span class="dot"></span>Nombre del verificador ${i + 1}</span><input type="text" data-vn="${i}" value="${esc(v)}"></label>
      <label>Usuario en la plataforma<small>Lo que va en "Asignada a" de la plantilla</small><input type="text" data-vu="${i}" value="${esc(c.users[i] || '')}" placeholder="${esc(v)}"></label></div>`).join('');
    $('#cfgMaxMin').value = c.maxMin; $('#cfgTraffic').value = c.traffic; $('#cfgVisitMin').value = c.visitMin;
    $('#cfgDayH').value = c.dayH; $('#cfgMaxDay').value = c.maxPerDay; $('#cfgFarFirst').value = c.farFirst ? '1' : '0';
    $('#cfgCenter').value = `${c.center.lat}, ${c.center.lng}`; $('#cfgBase').value = c.base ? `${c.base.lat}, ${c.base.lng}` : '';
  }
  const parseLL = s => { const m = String(s).match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/); return m ? { lat: +m[1], lng: +m[2] } : null; };
  $('#btnSaveCfg').addEventListener('click', () => {
    const c = state.cfg, num = (s, d) => { const v = parseFloat($(s).value); return isNaN(v) ? d : v; };
    c.verifs = $$('[data-vn]').map((i, k) => i.value.trim() || `Verificador ${k + 1}`);
    c.users = $$('[data-vu]').map(i => i.value.trim());
    c.maxMin = num('#cfgMaxMin', 0); save('cfgMaxMinTouched', true); c.traffic = num('#cfgTraffic', 1.1); c.visitMin = num('#cfgVisitMin', 20);
    c.dayH = num('#cfgDayH', 8); c.maxPerDay = num('#cfgMaxDay', 0); c.farFirst = $('#cfgFarFirst').value === '1';
    const ce = parseLL($('#cfgCenter').value); if (ce) c.center = ce;
    c.base = parseLL($('#cfgBase').value);
    save('cfg', c);
    if (state.catalog && state.catalog.radiusKm && c.maxMin * 1.5 > state.catalog.radiusKm + 0.5) toast('Subiste el límite: genera de nuevo el catálogo para incluir lugares más lejanos.', 6000);
    else toast('Ajustes guardados');
    compute();
  });
  $('#btnMyLoc').addEventListener('click', () => {
    if (!navigator.geolocation) return toast('Tu navegador no da ubicación.');
    navigator.geolocation.getCurrentPosition(p => { $('#cfgBase').value = `${p.coords.latitude.toFixed(6)}, ${p.coords.longitude.toFixed(6)}`; toast('Ubicación lista: pulsa Guardar.'); },
      () => toast('No se pudo obtener la ubicación.'), { enableHighAccuracy: true, timeout: 10000 });
  });
  $('#btnReset').addEventListener('click', () => {
    if (!confirm('¿Borrar catálogo, Excel, ajustes y avances guardados en este dispositivo?')) return;
    Object.keys(localStorage).filter(k => k.startsWith(LS)).forEach(k => localStorage.removeItem(k));
    location.reload();
  });

  // ================================================================== PWA
  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  let deferred = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; $('#btnInstall').hidden = false; });
  $('#btnInstall').addEventListener('click', async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('#btnInstall').hidden = true; });

  // ============================================================== INICIO
  fillCfg();
  compute();
  if (state.result && state.visits.length) showTab('zonas');
})();
