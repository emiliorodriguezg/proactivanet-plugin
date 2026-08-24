const DEFAULT_SERVIDOR = "127.0.0.1:8010";
// El Servidor guardado puede ser "host:puerto" (uso local/manual, de
// siempre) o una URL completa "https://..." (túnel Cloudflare -- ver
// web/run_tunnel.py, MEMORIA_PROYECTO.md 2026-08-24: el IP de LAN no es
// alcanzable desde todas las redes/VPN, el túnel sí). Sin protocolo se
// asume http:// (comportamiento de siempre); con protocolo, se usa tal cual.
function baseUrl(servidor) {
  return /^https?:\/\//.test(servidor) ? servidor.replace(/\/$/, "") : `http://${servidor}`;
}
// ProactivaNet se accede por varias URLs distintas según la red del usuario
// (IP directa, hostname interno, o vía pasarela VPN con prefijo de ruta) --
// ver MEMORIA_PROYECTO.md 2026-08-24. En vez de fijar una sola, se detecta
// en caliente a partir de la URL real de los frames de la pestaña activa:
// todo lo que hay hasta el último "/proactivanet/" incluido, que es común
// a las 3 variantes conocidas. RE_GUID_EN_FRAME no necesita esto -- ya es
// independiente de dominio (busca solo el patrón de query string).
const RE_PROACTIVA_BASE = /^(https:\/\/[^\s"]+\/proactivanet\/)/;
const PROACTIVA_BASE_FALLBACK = "https://10.176.10.12/proactivanet/";
let ultimaBaseProactivaNet = null;

function detectarBaseProactivaNet(frames) {
  for (const f of frames) {
    const m = (f.url || "").match(RE_PROACTIVA_BASE);
    if (m) return m[1];
  }
  return null;
}

const RE_GUID_EN_FRAME = /pawData=id(?:%3D|=)([0-9a-fA-F-]{36})/;

// Fichero servidor.txt en un repo público de GitHub (raw.githubusercontent.com
// es un dominio FIJO, alcanzable desde cualquier red con salida a Internet --
// a diferencia de SharePoint/OneDrive, que no era alcanzable desde equipos
// conectados solo a la VPN de Clece, ver MEMORIA_PROYECTO.md 2026-08-24).
// web/run_tunnel.py lo actualiza cada vez que el túnel Cloudflare cambia de
// URL. Vacío desactiva el autodescubrimiento (se usa solo el campo manual).
const SERVIDOR_DISCOVERY_URL = "https://raw.githubusercontent.com/emiliorodriguezg/proactivanet-servidor/main/servidor.txt";
const SERVIDOR_DISCOVERY_TTL_MS = 60 * 60 * 1000;

async function getServidor() {
  const { servidor } = await chrome.storage.local.get("servidor");
  return servidor || DEFAULT_SERVIDOR;
}

// Actualiza el Servidor guardado a partir del fichero publicado en GitHub,
// si hace más de SERVIDOR_DISCOVERY_TTL_MS que no se consulta. Si cambia de
// host, invalida sesionTs (la cookie de sesión es específica de host). Si
// falla o no hay URL configurada, se sigue usando el valor ya guardado
// (manual o el último descubierto) -- nunca bloquea el resto del plugin.
// Se puede desactivar por completo desde Configuración (checkbox
// "Autorefresco/autodetección") -- por defecto activo (autodetectar
// ausente en storage = true), para no cambiar el comportamiento de nadie
// que no haya tocado la opción todavía.
async function actualizarServidorDesdeDescubrimiento() {
  if (!SERVIDOR_DISCOVERY_URL) return;
  const { autodetectar } = await chrome.storage.local.get("autodetectar");
  if (autodetectar === false) return;
  const ahora = Date.now();
  const { descubrimientoTs } = await chrome.storage.local.get("descubrimientoTs");
  if (descubrimientoTs && ahora - descubrimientoTs < SERVIDOR_DISCOVERY_TTL_MS) return;
  try {
    const res = await fetch(SERVIDOR_DISCOVERY_URL, { cache: "no-store" });
    if (res.ok) {
      const texto = (await res.text()).trim();
      const esValido = /^[\w.-]+:\d+$/.test(texto) || /^https?:\/\/[\w.-]+(:\d+)?$/.test(texto);
      if (esValido && texto !== (await getServidor())) {
        await chrome.storage.local.set({ servidor: texto });
        await chrome.storage.local.remove("sesionTs");
      }
    }
  } catch {}
  await chrome.storage.local.set({ descubrimientoTs: ahora });
}

// Repo de distribución del plugin -- sin sincronización automática (a
// diferencia del servidor, que usa OneDrive): el usuario tiene que
// descargar el ZIP y sustituir la carpeta a mano cuando haya una versión
// nueva. Este chequeo solo avisa de que existe, comparando version.txt del
// repo contra la version del manifest.json ya instalado.
const VERSION_CHECK_URL = "https://raw.githubusercontent.com/emiliorodriguezg/proactivanet-plugin/main/version.txt";
const PLUGIN_REPO_URL = "https://github.com/emiliorodriguezg/proactivanet-plugin";
const VERSION_CHECK_TTL_MS = 60 * 60 * 1000;

async function comprobarVersion() {
  const ahora = Date.now();
  const { versionCheckTs } = await chrome.storage.local.get("versionCheckTs");
  if (versionCheckTs && ahora - versionCheckTs < VERSION_CHECK_TTL_MS) return;
  try {
    const res = await fetch(VERSION_CHECK_URL, { cache: "no-store" });
    if (res.ok) {
      const versionRemota = (await res.text()).trim();
      const versionLocal = chrome.runtime.getManifest().version;
      const banner = document.getElementById("version-banner");
      if (versionRemota && versionRemota !== versionLocal) {
        document.getElementById("version-link").href = PLUGIN_REPO_URL;
        banner.hidden = false;
      } else {
        banner.hidden = true;
      }
    }
  } catch {}
  await chrome.storage.local.set({ versionCheckTs: ahora });
}

async function getToken() {
  const { token } = await chrome.storage.local.get("token");
  return token || "";
}

async function fetchApi(path, servidor) {
  const token = await getToken();
  const headers = token ? { "X-Plugin-Token": token } : {};
  return fetch(`${baseUrl(servidor)}${path}`, { headers });
}

// Abre una página propia (Monitor/Buscar/Estadísticas/Ver detalles). La
// cookie de sesión ya está en el navegador antes de este punto -- la puso
// asegurarSesion() al cargar el Escáner (ver cargarEscaner), así que la
// pestaña nueva la lleva automáticamente sin nada en la URL.
async function abrirPagina(path) {
  const servidor = await getServidor();
  chrome.tabs.create({ url: `${baseUrl(servidor)}${path}` });
}

// Extrae el usuario real logueado en ProactivaNet. El botón
// #pawTheUserInfoBtn (frame menuTop.paw) requiere un clic REAL -- ni
// fetch() ni cargar su app:url en un iframe aislado sirven, ProactivaNet
// devuelve un error de aplicación (el framework "Paw" necesita el estado
// de la SPA ya arrancado). Para no interrumpir la pantalla del usuario, el
// clic no se hace en su pestaña visible: se arranca una copia completa de
// la app en un iframe oculto (display:none) -- misma sesión/cookies por ser
// mismo origen -- se hace clic ahí dentro y se descarta. Invisible para el
// usuario, verificado en pruebas reales 2026-08-23 (ver MEMORIA_PROYECTO.md).
async function usuarioActivo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return null;
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
    const base = detectarBaseProactivaNet(frames);
    if (!base) return null;
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      func: (appUrl) =>
        new Promise((resolve) => {
          const ifr = document.createElement("iframe");
          ifr.style.display = "none";
          // sandbox SIN allow-top-navigation/allow-popups: ProactivaNet
          // tiene código anti-iframe que fuerza window.top.location al
          // detectar que está embebido -- sin esto, ese "escape" navega la
          // pestaña real y visible del usuario (confirmado en pruebas
          // reales 2026-08-23, ver MEMORIA_PROYECTO.md). allow-same-origin
          // se mantiene para que las cookies de sesión y el acceso a
          // contentDocument sigan funcionando.
          ifr.sandbox = "allow-scripts allow-same-origin";
          ifr.onload = () => {
            setTimeout(() => {
              try {
                const doc = ifr.contentDocument;
                const menuTopFrame = Array.from(doc.querySelectorAll("iframe,frame")).find((f) =>
                  (f.src || "").includes("menuTop.paw")
                );
                const menuDoc = menuTopFrame && menuTopFrame.contentDocument;
                const btn = menuDoc && menuDoc.querySelector("#pawTheUserInfoBtn");
                if (!btn) {
                  resolve(null);
                  ifr.remove();
                  return;
                }
                btn.click();
                setTimeout(() => {
                  const leer = (etiqueta) => {
                    const td = menuDoc.querySelector(`td[paw\\:rowlabel="${etiqueta}"]`);
                    const span = td && td.nextElementSibling && td.nextElementSibling.querySelector(".pawDFTexView");
                    return ((span && span.textContent) || "").trim();
                  };
                  const correo = leer("Email");
                  const usuario = leer("Nombre completo") || leer("Nombre de usuario");
                  resolve(correo ? { correo, usuario } : null);
                  ifr.remove();
                }, 1500);
              } catch {
                resolve(null);
                ifr.remove();
              }
            }, 2500);
          };
          ifr.src = appUrl;
          document.body.appendChild(ifr);
        }),
      args: [`${base}servicedesk/default.paw`],
    });
    return results[0]?.result || null;
  } catch {
    return null;
  }
}

// Establece la cookie de sesión antes de usar el plugin, a partir del correo
// real de ProactivaNet (servidor valida whitelist de dominio/correo, ver
// web/app.py:api_sesion). Fail-closed: si no se detecta el correo, no se
// llama al servidor y las peticiones API seguirán devolviendo 403. Se
// cachea SESION_TTL_CACHE_MS para no repetir la llamada (y el registro de
// acceso) en cada cambio de pestaña -- corto a propósito (no los 12h de
// SESION_TTL_SEGUNDOS del servidor): si el servidor se reinicia, su sesión
// en memoria se pierde (ver web/app.py:SESIONES) pero este caché seguiría
// "vivo" sin saberlo, dejando Monitor/Buscar/Estadísticas rotos hasta que
// expire -- visto en pruebas reales 2026-08-23.
const SESION_TTL_CACHE_MS = 5 * 60 * 1000;
async function asegurarSesion() {
  const ahora = Date.now();
  const { sesionTs } = await chrome.storage.local.get("sesionTs");
  if (sesionTs && ahora - sesionTs < SESION_TTL_CACHE_MS) return;
  const usuario = await usuarioActivo();
  if (!usuario) return;
  const [servidor, token] = await Promise.all([getServidor(), getToken()]);
  try {
    const res = await fetch(`${baseUrl(servidor)}/api/sesion`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(token ? { "X-Plugin-Token": token } : {}) },
      body: JSON.stringify(usuario),
    });
    if (res.ok) await chrome.storage.local.set({ sesionTs: ahora });
  } catch {}
}

async function guidActivo() {
  // El guid no está en la URL de la pestaña (ProactivaNet no la cambia al
  // navegar) sino en la URL de un iframe interno
  // (.../formIncidents.paw?pawData=id=...) -- se lee con webNavigation,
  // sin necesidad de content script.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return null;
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
    const base = detectarBaseProactivaNet(frames);
    if (base) ultimaBaseProactivaNet = base;
    for (const f of frames) {
      const m = (f.url || "").match(RE_GUID_EN_FRAME);
      if (m) return m[1];
    }
  } catch {
    // sin permiso/tab no disponible -- se ignora, cae al campo manual
  }
  return null;
}

async function buscarPorUrl(url, etiquetaError) {
  // El servidor devuelve el HTML de las tarjetas ya construido -- el plugin
  // solo lo inyecta, sin plantilla propia (ver web/app.py: _similares_card_html).
  const status = document.getElementById("escaner-status");
  const list = document.getElementById("escaner-list");
  status.textContent = "Cargando…";
  list.innerHTML = "";
  const servidor = await getServidor();
  try {
    const res = await fetchApi(url, servidor);
    if (res.status === 403) {
      status.textContent = "Este equipo no está autorizado a usar el plugin.";
      return;
    }
    if (res.status === 404) {
      status.textContent = `${etiquetaError} no está todavía en la base de conocimiento.`;
      return;
    }
    if (!res.ok) throw new Error(String(res.status));
    status.textContent = "";
    list.innerHTML = await res.text();
  } catch (err) {
    status.textContent = `Error conectando con el servidor (${servidor}): ${err.message}`;
  }
}

async function buscarPorGuid(guid) {
  // Rellena el campo con el código real (no el guid) para que el usuario
  // vea claramente qué incidencia está consultando.
  const servidor = await getServidor();
  try {
    const res = await fetchApi(`/api/incidencias/${encodeURIComponent(guid)}`, servidor);
    if (res.ok) {
      const data = await res.json();
      document.getElementById("esc-codigo").value = data.ticket?.codigo || "";
    }
  } catch {
    // si falla, seguimos igualmente a por los similares
  }
  return buscarPorUrl(`/api/incidencias/${encodeURIComponent(guid)}/similares/html`, "Esta incidencia");
}

function buscarPorCodigo(codigo) {
  if (!codigo) {
    document.getElementById("escaner-status").textContent = "Introduce un código de incidencia.";
    return;
  }
  return buscarPorUrl(`/api/incidencias/por-codigo/${encodeURIComponent(codigo)}/similares/html`, `"${codigo}"`);
}

async function cargarEscaner() {
  await actualizarServidorDesdeDescubrimiento();
  await asegurarSesion();
  const guid = await guidActivo();
  if (guid) {
    buscarPorGuid(guid);
  } else {
    document.getElementById("escaner-status").textContent =
      "No se detectó ninguna incidencia en la página. Introduce el código y pulsa Buscar.";
    document.getElementById("escaner-list").innerHTML = "";
  }
}

document.getElementById("escaner-list").addEventListener("click", (e) => {
  const btnIa = e.target.closest(".btn-ia");
  if (btnIa) {
    const ac = document.getElementById(`ac-${btnIa.dataset.guid}`);
    ac.hidden = !ac.hidden;
    return;
  }
  const btnAbrir = e.target.closest(".btn-abrir");
  if (btnAbrir) {
    const base = ultimaBaseProactivaNet || PROACTIVA_BASE_FALLBACK;
    chrome.tabs.create({
      url: `${base}servicedesk/incidents/formIncidents/formIncidents.paw?pawData=id%3D${btnAbrir.dataset.guid}`,
    });
    return;
  }
  const btnDetalle = e.target.closest(".btn-detalle");
  if (btnDetalle) {
    abrirPagina(`/incidencias/${encodeURIComponent(btnDetalle.dataset.guid)}`);
  }
});

document.getElementById("esc-buscar").addEventListener("click", () => {
  buscarPorCodigo(document.getElementById("esc-codigo").value.trim());
});
document.getElementById("esc-codigo").addEventListener("keydown", (e) => {
  if (e.key === "Enter") buscarPorCodigo(document.getElementById("esc-codigo").value.trim());
});

document.getElementById("cfg-guardar").addEventListener("click", async () => {
  const servidor = document.getElementById("cfg-servidor").value.trim();
  const token = document.getElementById("cfg-token").value.trim();
  const autodetectar = document.getElementById("cfg-autodetectar").checked;
  // La cookie de sesión es específica del host -- si cambia el servidor (o
  // el token) el bootstrap cacheado de asegurarSesion() ya no vale, aunque
  // esté "reciente" (dentro de los 30 min), o nunca se repetiría contra el
  // host nuevo.
  await chrome.storage.local.set({ servidor: servidor || DEFAULT_SERVIDOR, token, autodetectar });
  await chrome.storage.local.remove("sesionTs");
  document.getElementById("cfg-status").textContent = "Guardado.";
});

document.getElementById("menu").addEventListener("click", async (e) => {
  const btnOpen = e.target.closest("button[data-open]");
  if (btnOpen) {
    abrirPagina(btnOpen.dataset.open);
    return;
  }
  const btn = e.target.closest("button[data-view]");
  if (!btn) return;
  document.querySelectorAll("#menu button[data-view]").forEach((b) => b.classList.toggle("active", b === btn));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${btn.dataset.view}`));
  if (btn.dataset.view === "escaner") cargarEscaner();
});

async function init() {
  // Descubrir el servidor ANTES de rellenar el campo -- en una instalación
  // nueva (sin nada en storage todavía), rellenarlo antes mostraba el
  // valor por defecto (127.0.0.1:8010) durante la primera apertura, aunque
  // el autodescubrimiento lo corrigiera un instante después por debajo.
  await actualizarServidorDesdeDescubrimiento();
  document.getElementById("cfg-servidor").value = await getServidor();
  document.getElementById("cfg-token").value = await getToken();
  const { autodetectar } = await chrome.storage.local.get("autodetectar");
  document.getElementById("cfg-autodetectar").checked = autodetectar !== false;
  document.getElementById("cfg-version").textContent = `Versión instalada: ${chrome.runtime.getManifest().version}`;
  comprobarVersion();
  cargarEscaner();
  chrome.tabs.onActivated.addListener(() => cargarEscaner());
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === "complete") cargarEscaner();
  });
}
init();
