/* =========================================================================
   Rutas Verificadores · Servicios de mapas
   - Catálogo de asentamientos: OpenStreetMap vía Overpass (sin llave)
   - Tiempos en auto: OSRM (sin llave) o Google Routes API · Compute Route Matrix (con llave, con tráfico)
   - Geocodificación de pendientes: Nominatim (1 consulta/seg) o Google Geocoder
   ========================================================================= */
(function (root) {
  'use strict';
  const C = root.Core;

  const OVERPASS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
  ];
  const OSRM = 'https://router.project-osrm.org';
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function fetchJSON(url, opts, timeoutMs) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs || 60000);
    try {
      const r = await fetch(url, Object.assign({ signal: ctl.signal }, opts || {}));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  /** Descarga asentamientos con nombre en un radio (km) alrededor del centro */
  async function fetchSettlements(center, radiusKm, onProgress) {
    const R = Math.round(radiusKm * 1000), ll = `${center.lat},${center.lng}`;
    const q = `[out:json][timeout:120];
(
  node["place"~"^(city|town|village|hamlet|locality|suburb|neighbourhood|quarter|isolated_dwelling|farm)$"]["name"](around:${R},${ll});
  way["place"~"^(village|hamlet|locality|suburb|neighbourhood|quarter)$"]["name"](around:${R},${ll});
  relation["place"~"^(village|hamlet|suburb|neighbourhood|quarter)$"]["name"](around:${R},${ll});
  way["landuse"="residential"]["name"](around:${R},${ll});
  relation["landuse"="residential"]["name"](around:${R},${ll});
);
out center tags;`;
    let lastErr;
    for (const url of OVERPASS) {
      try {
        onProgress && onProgress(`Consultando OpenStreetMap (${new URL(url).host})…`);
        const data = await fetchJSON(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 150000);
        return dedupe(parseOverpass(data, center));
      } catch (e) { lastErr = e; }
    }
    throw new Error('No se pudo consultar OpenStreetMap: ' + (lastErr && lastErr.message));
  }

  function parseOverpass(data, center) {
    const out = [];
    (data.elements || []).forEach(el => {
      const tags = el.tags || {};
      const lat = el.lat ?? (el.center && el.center.lat), lng = el.lon ?? (el.center && el.center.lon);
      if (lat == null || !tags.name) return;
      if (tags.place === 'city') return; // la ciudad misma no es una colonia
      out.push({
        id: el.type[0] + el.id, name: tags.name.trim(), type: C.classifyPlace(tags),
        osm: tags.place || ('landuse=' + tags.landuse), lat, lng,
        distKm: +C.haversineKm(center, { lat, lng }).toFixed(2), bearing: +C.bearing(center, { lat, lng }).toFixed(1)
      });
    });
    return out;
  }

  /** Une duplicados (mismo nombre a < 1.2 km), prefiriendo nodos "place" */
  function dedupe(list) {
    const rank = p => (p.osm.startsWith('landuse') ? 1 : 0);
    list.sort((a, b) => rank(a) - rank(b));
    const kept = [];
    const byName = new Map();
    for (const p of list) {
      const k = C.normalizeName(p.name);
      const arr = byName.get(k) || [];
      if (arr.some(q => C.haversineKm(p, q) < 1.2)) continue;
      arr.push(p); byName.set(k, arr); kept.push(p);
    }
    return kept;
  }

  /** Minutos/km en auto desde el centro hacia cada lugar (OSRM, en bloques) */
  async function osrmFromCenter(center, places, onProgress) {
    const CH = 90;
    for (let i = 0; i < places.length; i += CH) {
      const chunk = places.slice(i, i + CH);
      const coords = [center, ...chunk].map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
      const url = `${OSRM}/table/v1/driving/${coords}?sources=0&annotations=duration,distance`;
      onProgress && onProgress(`Calculando tiempos en auto ${Math.min(i + CH, places.length)}/${places.length}…`);
      let data, tries = 0;
      while (!data && tries < 3) {
        try { data = await fetchJSON(url, null, 45000); if (data.code !== 'Ok') throw new Error(data.code); }
        catch (e) { data = null; tries++; await sleep(1500 * tries); }
      }
      chunk.forEach((p, j) => {
        const d = data && data.durations && data.durations[0][j + 1];
        const m = data && data.distances && data.distances[0][j + 1];
        if (d != null) { p.minutes = +(d / 60).toFixed(1); p.km = +(m / 1000).toFixed(1); p.timeSource = 'OSRM'; }
        else { p.minutes = +C.estimateDriveMin(center, p).toFixed(1); p.km = +(C.haversineKm(center, p) * 1.35).toFixed(1); p.timeSource = 'estimado'; }
      });
      await sleep(1100); // cortesía con el servidor público
    }
    return places;
  }

  // -------------------------------------------------------------- Google Maps
  let gLoading = null;
  function loadGoogle(key) {
    if (root.google && root.google.maps && root.google.maps.importLibrary) return Promise.resolve();
    if (gLoading) return gLoading;
    gLoading = new Promise((res, rej) => {
      root.__gmapsReady = () => res();
      const s = document.createElement('script');
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&libraries=routes,geocoding&language=es&region=MX&callback=__gmapsReady`;
      s.async = true; s.onerror = () => { gLoading = null; rej(new Error('No se pudo cargar Google Maps (revisa la llave)')); };
      document.head.appendChild(s);
    });
    return gLoading;
  }

  /** Próximo día hábil a las 10:00 para estimar con tráfico típico */
  function nextWorkday10() {
    const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    return d;
  }

  /** Una fila de la matriz con la librería "routes" de Maps JavaScript (Routes API) */
  async function routeMatrixJS(center, chunk, dep) {
    const { RouteMatrix } = await google.maps.importLibrary('routes');
    const { matrix } = await RouteMatrix.computeRouteMatrix({
      origins: [{ lat: center.lat, lng: center.lng }],
      destinations: chunk.map(p => ({ lat: p.lat, lng: p.lng })),
      travelMode: 'DRIVING', routingPreference: 'TRAFFIC_AWARE', departureTime: dep,
      fields: ['durationMillis', 'distanceMeters', 'condition']
    });
    const items = (matrix.rows[0] && matrix.rows[0].items) || [];
    return chunk.map((_, j) => {
      const it = items[j];
      if (!it || it.condition === 'ROUTE_NOT_FOUND' || it.durationMillis == null) return null;
      return { sec: it.durationMillis / 1000, m: it.distanceMeters };
    });
  }

  /** Respaldo: Routes API REST (computeRouteMatrix) */
  async function routeMatrixREST(key, center, chunk, dep) {
    const wp = p => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } });
    const r = await fetch('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,distanceMeters,condition' },
      body: JSON.stringify({ origins: [wp(center)], destinations: chunk.map(wp), travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE', departureTime: dep.toISOString() })
    });
    if (!r.ok) throw new Error('Routes API HTTP ' + r.status);
    const data = await r.json();
    const out = chunk.map(() => null);
    data.forEach(e => { if (e.condition === 'ROUTE_EXISTS' && e.duration) out[e.destinationIndex] = { sec: parseFloat(e.duration), m: e.distanceMeters }; });
    return out;
  }

  /** Minutos/km con tráfico desde el centro usando Google Routes API (bloques de 25) */
  async function googleFromCenter(key, center, places, onProgress) {
    await loadGoogle(key);
    const CH = 25, dep = nextWorkday10();
    let useREST = false;
    for (let i = 0; i < places.length; i += CH) {
      const chunk = places.slice(i, i + CH);
      onProgress && onProgress(`Google Maps (con tráfico) ${Math.min(i + CH, places.length)}/${places.length}…`);
      let res;
      if (!useREST) { try { res = await routeMatrixJS(center, chunk, dep); } catch (e) { useREST = true; } }
      if (useREST) res = await routeMatrixREST(key, center, chunk, dep);
      chunk.forEach((p, j) => {
        const v = res[j];
        if (v) { p.minutes = +(v.sec / 60).toFixed(1); p.km = +((v.m || 0) / 1000).toFixed(1); p.timeSource = 'Google'; }
        else { p.minutes = +C.estimateDriveMin(center, p).toFixed(1); p.km = +(C.haversineKm(center, p) * 1.35).toFixed(1); p.timeSource = 'estimado'; }
      });
      await sleep(200);
    }
    return places;
  }

  // ------------------------------------------------------------ geocodificar
  async function geocode(query, center, gKey) {
    if (gKey) {
      await loadGoogle(gKey);
      const { Geocoder } = await google.maps.importLibrary('geocoding');
      const g = new Geocoder();
      const r = await new Promise(res => g.geocode({ address: query, region: 'mx', bounds: boundsOf(center, 40) }, (x, st) => res(st === 'OK' ? x : null)));
      if (r && r[0]) { const l = r[0].geometry.location; return { lat: l.lat(), lng: l.lng(), label: r[0].formatted_address }; }
      return null;
    }
    const b = boxOf(center, 40);
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=mx&accept-language=es&bounded=1&viewbox=${b.w},${b.n},${b.e},${b.s}&q=${encodeURIComponent(query)}`;
    const r = await fetchJSON(url, null, 20000);
    if (r && r[0]) return { lat: +r[0].lat, lng: +r[0].lon, label: r[0].display_name };
    return null;
  }
  function boxOf(c, km) {
    const n = C.destination(c, 0, km), s = C.destination(c, 180, km), e = C.destination(c, 90, km), w = C.destination(c, 270, km);
    return { n: n.lat, s: s.lat, e: e.lng, w: w.lng };
  }
  function boundsOf(c, km) { const b = boxOf(c, km); return { north: b.n, south: b.s, east: b.e, west: b.w }; }

  root.Geo = { fetchSettlements, osrmFromCenter, googleFromCenter, geocode, loadGoogle, sleep };
})(window);
