# Rutas Verificadores · Durango

PWA estática (sin servidor) para:

1. Generar el catálogo de **colonias, fraccionamientos, poblados y rancherías a ≤ 20 min en auto** del centro de Durango.
2. Dividir ese catálogo en **3 zonas** (sectores) balanceadas por carga de trabajo, una por verificador.
3. Subir el **Excel de visitas**, detectar sus columnas y asignar cada visita a su zona.
4. Generar **rutas por día** (orden de paradas, enlaces de Google Maps, plan para WhatsApp).
5. Proponer **estrategia**: por dónde arrancar, fronteras compartidas, días de apoyo y alertas.

Todo corre en el navegador; los datos se guardan solo en el dispositivo (localStorage).

---

## 1. Publicar en GitHub Pages

```bash
# dentro de la carpeta del proyecto
git init
git add .
git commit -m "Rutas Verificadores v1"
git branch -M main
git remote add origin https://github.com/<usuario>/rutas-verificadores.git
git push -u origin main
```

1. En GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**.
2. Branch `main`, carpeta `/ (root)` → **Save**.
3. En 1–2 min queda en `https://<usuario>.github.io/rutas-verificadores/`.
4. Ábrelo en el celular → menú del navegador → **Agregar a pantalla de inicio** (o botón *Instalar* en escritorio).

> Todas las rutas son relativas; funciona en subcarpeta de Pages sin configuración extra. El archivo `.nojekyll` evita que Jekyll procese el sitio.

Prueba local: `python3 -m http.server 8080` y abre `http://localhost:8080`.

---

## 2. Uso

| Paso | Pestaña | Qué hacer |
|---|---|---|
| 1 | **Cargar** | *Generar catálogo* (1–3 min la primera vez; queda guardado). |
| 2 | **Cargar** | *Subir Excel*. Revisa el mapeo de columnas detectado y pulsa *Procesar y asignar*. |
| 3 | **Cargar** | Corrige pendientes: *Geocodificar pendientes* o escribe la colonia correcta en cada una. |
| 4 | **Zonas** | Mapa con las 3 cuñas, tarjetas de carga y catálogo **alfabético** filtrable por zona. Cambia la zona de cualquier colonia con su selector (queda marcada como *manual*). |
| 5 | **Rutas** | Elige verificador → días con paradas en orden, botones de Google Maps por tramo, casillas de avance y *Compartir* (WhatsApp). |
| 6 | **Estrategia** | Recomendaciones automáticas. |
| 7 | **⬇ Excel** | Exporta: asignación completa en el orden original, una hoja por verificador en orden de ruta, catálogo por zona, estrategia y pendientes. |

### Excel de visitas
No requiere formato fijo. Se detectan por encabezado (aunque haya títulos arriba): folio, nombre, domicilio, número, **colonia/fraccionamiento/localidad**, municipio, C.P., teléfono, referencias y, si existen, **latitud/longitud** (o una sola columna `lat, lng`). Si no hay columna de colonia, se busca el nombre de la colonia dentro del domicilio.

Hay un ejemplo en `ejemplo/visitas-ejemplo.xlsx`.

---

## 3. Cómo decide

**Radio de 20 min.** Se consultan en OpenStreetMap (Overpass) todos los asentamientos con nombre en ~30 km y se calcula el tiempo real en auto desde el centro con OSRM. Se aplica un *factor de tráfico* (default ×1.10) y se conserva lo que queda ≤ límite.

**3 zonas.** Cada colonia tiene un rumbo desde el centro (0° norte, 90° oriente…). Se buscan los 3 cortes angulares que dejan la **carga más pareja**, donde carga = visitas × (1 + minutos/60) (una visita lejana pesa más). Entre cortes equivalentes, se prefieren los que caen en huecos sin colonias (límites naturales). El nombre de cada zona sale del rumbo promedio (Norte, Oriente, Sur-poniente…).

**Fronteras.** Las colonias a ~1.2 km del límite se marcan *frontera* y el núcleo del centro (≤ 1.2 km) como *comodín*: cualquiera puede tomarlas para rellenar huecos o apoyar a quien vaya atrasado.

**Rutas.** Vecino más cercano + 2-opt desde la base, división por jornada (horas, minutos por visita y tope de visitas/día). Cada día arranca por **lo más lejano** y regresa hacia la base (configurable). Los enlaces de Google Maps usan el domicilio de cada visita (máx. 10 puntos por enlace, límite de Google).

---

## 4. Ajustes

| Ajuste | Default | Nota |
|---|---|---|
| Límite en auto | 20 min | Si lo subes, vuelve a generar el catálogo. |
| Factor de tráfico | 1.10 | 1.25–1.35 para horas pico. |
| Minutos por visita | 20 | |
| Jornada | 8 h | |
| Máx. visitas/día | 0 (sin tope) | |
| Centro | 24.0245, -104.6700 (Catedral) | Define radio y sectores. |
| Base | Caja Hipódromo Matriz (C. Tepehuanes 709, Col. Hipódromo) · 24.0244475, -104.6414927 | Oficina desde donde salen. Default en `js/config.js`. |
| Google Maps API key | vacío | Opcional, ver abajo. |

### Google Maps (opcional)
Sin llave la app es 100 % gratuita (OpenStreetMap + OSRM). Con llave:
- Tiempos con **Routes API · Compute Route Matrix con tráfico** (próximo día hábil 10:00). Distance Matrix (Legacy) ya no se puede activar en proyectos nuevos.
- Geocodificación de pendientes con Google.

Habilita *Maps JavaScript API*, *Routes API* y *Geocoding API* (proyecto `rutas-verificadores` ya configurado) en Google Cloud, y **restringe la llave por referente HTTP** a `https://<usuario>.github.io/*`. Puedes ponerla en `js/config.js` (`gKey`) para que todos los dispositivos la usen sin capturarla; es seguro solo si está restringida por dominio y por API. También se puede capturar por dispositivo en Ajustes.

---

## 5. Estructura

```
index.html              UI
css/app.css             estilos (claro/oscuro, móvil primero)
js/core.js              lógica pura: coincidencias, sectores, rutas, recomendaciones
js/geo.js               Overpass, OSRM, Google Routes API, Nominatim / Google Geocoder
js/app.js               estado, pantallas, exportación
js/vendor/              SheetJS 0.18.5, Leaflet 1.9.4 (locales, funcionan offline)
sw.js                   service worker (app offline; mapas y APIs en línea)
manifest.webmanifest    instalación PWA
ejemplo/                Excel de prueba
```

Al publicar una nueva versión, cambia `VERSION` en `sw.js` para forzar la actualización en los celulares.

## 6. Límites conocidos
- OSRM/Overpass son servidores públicos gratuitos: si están saturados, reintenta en unos minutos; los tiempos que fallen se marcan **≈ estimado**.
- La cobertura de colonias en OpenStreetMap es buena en la mancha urbana pero puede faltar algún fraccionamiento nuevo: agrégalo con *Importar catálogo* (columnas `Nombre, Tipo, Lat, Lng`) o reexporta el catálogo, edítalo y vuelve a importarlo.
- OSRM no considera tráfico; por eso existe el factor de tráfico (o usa la llave de Google).

## Catálogo oficial incluido (v1.3)

- `js/catalogo.js` trae **1,029 asentamientos** del municipio de Durango (SEPOMEX 2021 + OpenStreetMap) con **3 zonas fijas** (Noreste, Sureste, Poniente), C.P., tiempos con tráfico desde Caja Hipódromo Matriz y coordenadas.
- La app lo usa por defecto: **el cruce del Excel funciona sin internet de mapas** (útil en redes con páginas bloqueadas). "Actualizar desde mapas" es opcional.
- Límite de minutos por defecto: **0 = sin límite** (todas las colonias y poblados).
- El cruce reconoce prefijos (Col., Fracc., Ejido…), acentos, romanos/números (Huizache II = 2), "Amp."/"Ampliación" y "Zona Centro". Los nombres repetidos (p. ej. Benito Juárez) salen como **Revisar**.
- Exportación con formato (ExcelJS): hoja Resumen, Asignación (tu Excel + verificador, zona, día, orden, asentamiento, C.P., minutos, estado, liga), una hoja por verificador separada por día, Catálogo por zona, Estrategia y Pendientes.
