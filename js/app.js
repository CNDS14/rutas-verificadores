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
    base: null, maxMin: 20, traffic: 1.1, visitMin: 20, dayH: 8, maxPerDay: 0, farFirst: true,
    verifs: ['Verificador 1', 'Verificador 2', 'Verificador 3'], gKey: ''
  };
  const APP = window.APP_CONFIG || {};
  if (APP.base) DEFAULT_CFG.base = APP.base;
  if (APP.gKey) DEFAULT_CFG.gKey = APP.gKey;
  const BASE_LABEL = APP.baseLabel || 'Base de salida';
  const ROLES = [
    ['id', 'Folio / ID'], ['nombre', 'Nombre'], ['direccion', 'Domicilio / calle'], ['numero', 'Número ext.'],
    ['colonia', 'Colonia / fracc. / poblado'], ['municipio', 'Municipio / ciudad'], ['cp', 'C.P.'],
    ['lat', 'Latitud'], ['lng', 'Longitud'], ['coords', 'Coordenadas "lat, lng"'], ['telefono', 'Teléfono'], ['referencias', 'Referencias']
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
  const colors = () => ['--v1', '--v2', '--v3'].map(v => getComputedStyle(document.documentElement).getPropertyValue(v).trim());
  const base = () => state.cfg.base || state.cfg.center;
  const eff = m => m == null ? null : m * state.cfg.traffic;

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
    const inR = cat.places.filter(p => eff(p.minutes) <= state.cfg.maxMin);
    const byType = {};
    inR.forEach(p => { byType[p.type] = (byType[p.type] || 0) + 1; });
    const moved = C.haversineKm(cat.center, state.cfg.center) > 0.3;
    el.className = 'status ok';
    el.innerHTML = `<b>${inR.length}</b> asentamientos a ≤ ${state.cfg.maxMin} min (de ${cat.places.length} consultados) · ` +
      Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} ${esc(t)}`).join(' · ') +
      `<br><small class="muted">Tiempos: ${esc(cat.source)} · factor tráfico ×${state.cfg.traffic} · ${new Date(cat.fetchedAt).toLocaleString('es-MX')}</small>` +
      (moved ? '<br><b style="color:var(--warn)">El centro cambió: vuelve a generar el catálogo.</b>' : '');
  }

  $('#btnCatalog').addEventListener('click', async () => {
    const btn = $('#btnCatalog'); btn.disabled = true;
    const cfg = state.cfg, center = cfg.center;
    const radiusKm = Math.min(60, Math.max(15, cfg.maxMin * 1.5));
    try {
      progress('#catProgress', 5, 'Consultando OpenStreetMap…');
      let places = await G.fetchSettlements(center, radiusKm, t => progress('#catProgress', 10, t));
      progress('#catProgress', 25, `${places.length} asentamientos encontrados. Calculando tiempos…`);
      // descarta lo que ni a 100 km/h en línea recta llega en el límite
      const far = [], near = [];
      places.forEach(p => (p.distKm / 100 * 60 > cfg.maxMin * 1.2 ? far : near).push(p));
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
      state.catalog = { places, center: Object.assign({}, center), radiusKm, source, fetchedAt: Date.now() };
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
      state.catalog = { places, center: Object.assign({}, center), radiusKm: 0, source: 'Catálogo importado', fetchedAt: Date.now() };
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
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array', cellDates: true });
      state.workbook = wb;
      const counts = wb.SheetNames.map(n => (XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1 }) || []).length);
      const sheet = wb.SheetNames[counts.indexOf(Math.max(...counts))];
      readSheet(f.name, sheet);
    } catch (e) { toast('No se pudo leer el archivo: ' + e.message, 6000); }
    ev.target.value = '';
  });

  function readSheet(fileName, sheet) {
    const wb = state.workbook;
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, defval: '', raw: false, blankrows: false });
    const hr = C.findHeaderRow(rows);
    const width = Math.max(...rows.slice(hr, hr + 50).map(r => r.length), 1);
    const headers = Array.from({ length: width }, (_, i) => String((rows[hr] || [])[i] ?? '').trim() || ('Columna ' + (i + 1)));
    const data = rows.slice(hr + 1).filter(r => r.some(c => String(c).trim() !== ''));
    const mapping = C.detectColumns(headers, data.slice(0, 60));
    state.excel = { fileName, sheet, sheets: wb.SheetNames, headers, data, mapping };
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
    const inRange = p => p && eff(p.minutes) != null && eff(p.minutes) <= cfg.maxMin;
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
        let r = v.colonia ? C.matchPlace(v.colonia, state.index, center) : null;
        if (!r) r = C.scanAddress([v.direccion, v.colonia, v.referencias].join(' '), state.index, center);
        if (r) { v.place = r.place; v.method = r.method; v.score = r.score; }
      }
      v.minutes = v.own && !v.place ? eff(C.estimateDriveMin(center, v.own)) : (v.place ? eff(v.place.minutes) : null);
      v.status = (!v.place && !v.own) ? 'none' : (v.minutes > cfg.maxMin ? 'fuera' : 'ok');
    });

    // 2) nodos: asentamientos en radio + visitas con coordenadas propias sin asentamiento
    const nodes = new Map();
    places.filter(inRange).forEach(p => nodes.set(p.id, {
      id: p.id, name: p.name, type: p.type, lat: p.lat, lng: p.lng, minutes: eff(p.minutes), km: p.km,
      distKm: p.distKm, bearing: p.bearing, timeSource: p.timeSource, list: []
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
    let part = C.orderSectors(C.partitionSectors(N, 3), N, 3);
    const cuts = part.cuts;
    const names = C.sectorNames(part.means);
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
    if (map && $('#tab-zonas').classList.contains('active')) drawMap();
    const r = state.result;
    $('#subtitle').textContent = r ? `${r.sectors.map(s => s.name).join(' · ')}` : 'Durango · 3 zonas';
  }

  function renderMatch() {
    const V = state.visits, card = $('#matchCard');
    if (!V.length) { card.hidden = true; return; }
    card.hidden = false;
    const c = k => V.filter(k).length;
    const exact = c(v => v.status === 'ok' && ['exacta', 'coordenadas', 'manual'].includes(v.method));
    const approx = c(v => v.status === 'ok' && !['exacta', 'coordenadas', 'manual'].includes(v.method));
    const fuera = c(v => v.status === 'fuera'), none = c(v => v.status === 'none');
    $('#matchKpis').innerHTML = `
      <div class="kpi ok"><b>${exact}</b><span>Ubicadas exactas</span></div>
      <div class="kpi"><b>${approx}</b><span>Aproximadas / en dirección / geocodificadas</span></div>
      <div class="kpi warn"><b>${fuera}</b><span>Fuera de ${state.cfg.maxMin} min</span></div>
      <div class="kpi bad"><b>${none}</b><span>Sin ubicar</span></div>`;
    const pend = V.filter(v => v.status === 'none');
    const fz = V.filter(v => v.status === 'fuera');
    $('#pendActions').innerHTML = (pend.length ? `<button class="btn primary sm" id="btnGeo">Geocodificar pendientes (${pend.length})</button>` : '') +
      (approx ? `<button class="btn ghost sm" id="btnShowApprox">Revisar aproximadas (${approx})</button>` : '');
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
      const ap = V.filter(v => v.status === 'ok' && !['exacta', 'coordenadas', 'manual'].includes(v.method));
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
      cards.innerHTML = `<div class="card empty" style="grid-column:1/-1">Genera el catálogo y sube el Excel para ver las 3 zonas.</div>`;
      $('#catTable tbody').innerHTML = ''; $('#legend').innerHTML = ''; return;
    }
    const totalW = r.sectors.reduce((a, s) => a + s.days.reduce((x, d) => x + d.workMin, 0), 0) || 1;
    const totalN = r.nodes.length;
    cards.innerHTML = r.sectors.map(s => {
      const w = s.days.reduce((x, d) => x + d.workMin, 0);
      const cnt = t => s.nodes.filter(n => t(n.type)).length;
      const share = state.visits.length ? w / totalW : s.nodes.length / totalN;
      return `<div class="zcard" style="--c:${s.color}">
        <h3><span>${esc(s.verif)}</span><span class="tag">Zona ${esc(s.name)}</span></h3>
        <div class="meta"><span><b>${s.visits}</b> visitas</span><span><b>${s.days.length}</b> día(s)</span><span><b>${(w / 60).toFixed(1)}</b> h</span></div>
        <div class="meta"><span>${cnt(t => t === 'Colonia')} col.</span><span>${cnt(t => t === 'Fraccionamiento')} fracc.</span><span>${cnt(t => RURAL.includes(t))} poblados/ranchos</span></div>
        <div class="bar"><i style="width:${Math.round(share * 100)}%"></i></div></div>`;
    }).join('');
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
        <td>${esc(n.type)}</td><td class="num">${Math.round(n.minutes)}${n.timeSource === 'estimado' ? '<span class="tag est">≈</span>' : ''}</td><td class="num">${n.km ?? ''}</td><td class="num">${n.visits || ''}</td>
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
      const rad = Math.max(5, Math.max(0, ...inArc.map(n => n.distKm)) + 1.5);
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
      m.addTo(layer); bounds.push([n.lat, n.lng]);
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
    if (!r) { $('#verifChips').innerHTML = ''; $('#routeSummary').innerHTML = '<div class="empty">Sin rutas todavía.</div>'; $('#routeDays').innerHTML = ''; return; }
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
          <h4>${esc(st.label)} <span class="tag">${esc(st.type)}</span> <span class="muted small">${Math.round(st.minutes || 0)} min del centro</span></h4>
          <ul>${st.visits.map(v => `<li class="${state.done[v.key] ? 'done' : ''}"><input type="checkbox" data-done="${esc(v.key)}" ${state.done[v.key] ? 'checked' : ''}><span><b>${esc(v.nombre || 'Visita ' + v.id)}</b>${v.direccion ? ' — ' + esc(v.direccion) : ''}${v.telefono ? ` · <a href="tel:${esc(v.telefono)}">${esc(v.telefono)}</a>` : ''}</span></li>`).join('')}</ul>
        </div></div>`).join('')}
      </article>`;
    }).join('') : '<div class="card empty">Esta zona no tiene visitas asignadas.</div>';
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
    if (!r) { $('#recs').innerHTML = '<div class="card empty">Las recomendaciones aparecen al procesar el Excel.</div>'; return; }
    const lbl = { clave: 'Clave', ruta: 'Ruta', compartir: 'Trabajo compartido', alerta: 'Atención' };
    $('#recs').innerHTML = r.recs.map(x => {
      const c = x.level === 'ruta' && x.sector != null ? r.sectors[x.sector].color : null;
      return `<div class="rec ${x.level}" ${c ? `style="--c:${c}"` : ''}><h3><span class="lvl">${lbl[x.level]}</span>${esc(x.title)}</h3><p>${esc(x.body)}</p></div>`;
    }).join('');
  }

  // ============================================================ EXPORTAR
  $('#btnExport').addEventListener('click', () => {
    const r = state.result; if (!r) return;
    const wb = XLSX.utils.book_new();
    const x = state.excel;
    const sec = v => v.sector != null ? r.sectors[v.sector] : null;
    const mapsQ = v => v.own ? `${v.own.lat},${v.own.lng}` : (addressOf(v) || (v.place ? `${v.place.lat},${v.place.lng}` : ''));
    if (x) {
      const head = [...x.headers, 'Verificador', 'Zona', 'Día', 'Orden parada', 'Asentamiento detectado', 'Tipo', 'Min desde centro', 'Método', 'Estado', 'Google Maps'];
      const rows = state.visits.map(v => {
        const s = sec(v), q = mapsQ(v);
        return [...x.headers.map((_, i) => v.row[i] ?? ''), s ? s.verif : '', s ? s.name : '', v.day ?? '', v.order ?? '',
          v.place ? v.place.name : (v.own ? 'Ubicación propia' : ''), v.place ? v.place.type : '', v.minutes != null ? Math.round(v.minutes) : '',
          v.method, { ok: 'Asignada', fuera: 'Fuera de radio', none: 'Sin ubicar' }[v.status],
          q ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q) : ''];
      });
      XLSX.utils.book_append_sheet(wb, sheet([head, ...rows]), 'Asignación');
      r.sectors.forEach(s => {
        const h = ['Día', 'Orden', 'Asentamiento', 'Tipo', 'Min', 'Folio', 'Nombre', 'Domicilio', 'Teléfono', 'Referencias', 'Google Maps', 'Hecho'];
        const rr = [];
        s.days.forEach(d => d.stops.forEach((st, k) => st.visits.forEach(v => {
          const q = mapsQ(v);
          rr.push([d.day, k + 1, st.label, st.type, Math.round(st.minutes || 0), v.id, v.nombre, v.direccion, v.telefono, v.referencias,
            q ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q) : '', state.done[v.key] ? 'Sí' : '']);
        })));
        XLSX.utils.book_append_sheet(wb, sheet([h, ...rr]), safeName(`${s.verif} - ${s.name}`));
      });
    }
    const ch = ['Zona', 'Verificador', 'Nombre', 'Tipo', 'Min (con tráfico)', 'Km', 'Visitas', 'Frontera', 'Asignación', 'Lat', 'Lng'];
    const cr = r.nodes.slice().sort((a, b) => a.sector - b.sector || a.name.localeCompare(b.name, 'es')).map(n => [
      r.sectors[n.sector].name, r.sectors[n.sector].verif, n.name, n.type, Math.round(n.minutes), n.km, n.visits,
      n.border.shared ? (n.border.reason === 'centro' ? 'Centro (comodín)' : 'Con ' + (r.sectors[n.neighbor]?.verif || '')) : '',
      state.overrides[n.id] != null ? 'Manual' : 'Automática', n.lat, n.lng]);
    XLSX.utils.book_append_sheet(wb, sheet([ch, ...cr]), 'Catálogo por zona');
    XLSX.utils.book_append_sheet(wb, sheet([['Tipo', 'Título', 'Detalle'], ...r.recs.map(x => [x.level, x.title, x.body])]), 'Estrategia');
    const pend = state.visits.filter(v => v.status !== 'ok');
    if (pend.length) XLSX.utils.book_append_sheet(wb, sheet([['Estado', 'Folio', 'Nombre', 'Domicilio', 'Colonia', 'Asentamiento más parecido', 'Min'],
      ...pend.map(v => [v.status === 'fuera' ? 'Fuera de radio' : 'Sin ubicar', v.id, v.nombre, v.direccion, v.colonia, v.place ? v.place.name : '', v.minutes != null ? Math.round(v.minutes) : ''])]), 'Pendientes');
    const d = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `asignacion-verificadores-${d}.xlsx`);
  });
  function sheet(aoa) {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = aoa[0].map((_, i) => ({ wch: Math.min(48, Math.max(8, ...aoa.slice(0, 200).map(r => String(r[i] ?? '').length))) }));
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: aoa[0].length - 1 } }) };
    return ws;
  }
  const safeName = s => s.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31);

  // ============================================================== AJUSTES
  function fillCfg() {
    const c = state.cfg;
    $('#verifNames').innerHTML = c.verifs.map((v, i) => `<label style="--c:var(--v${i + 1})"><span><span class="dot"></span>Verificador ${i + 1}</span><input type="text" data-vn="${i}" value="${esc(v)}"></label>`).join('');
    $('#cfgMaxMin').value = c.maxMin; $('#cfgTraffic').value = c.traffic; $('#cfgVisitMin').value = c.visitMin;
    $('#cfgDayH').value = c.dayH; $('#cfgMaxDay').value = c.maxPerDay; $('#cfgFarFirst').value = c.farFirst ? '1' : '0';
    $('#cfgCenter').value = `${c.center.lat}, ${c.center.lng}`; $('#cfgBase').value = c.base ? `${c.base.lat}, ${c.base.lng}` : '';
    $('#cfgGKey').value = c.gKey || '';
  }
  const parseLL = s => { const m = String(s).match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/); return m ? { lat: +m[1], lng: +m[2] } : null; };
  $('#btnSaveCfg').addEventListener('click', () => {
    const c = state.cfg, num = (s, d) => { const v = parseFloat($(s).value); return isNaN(v) ? d : v; };
    c.verifs = $$('[data-vn]').map((i, k) => i.value.trim() || `Verificador ${k + 1}`);
    c.maxMin = num('#cfgMaxMin', 20); c.traffic = num('#cfgTraffic', 1.1); c.visitMin = num('#cfgVisitMin', 20);
    c.dayH = num('#cfgDayH', 8); c.maxPerDay = num('#cfgMaxDay', 0); c.farFirst = $('#cfgFarFirst').value === '1';
    const ce = parseLL($('#cfgCenter').value); if (ce) c.center = ce;
    c.base = parseLL($('#cfgBase').value);
    c.gKey = $('#cfgGKey').value.trim();
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
