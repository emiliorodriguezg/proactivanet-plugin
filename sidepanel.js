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

async function postApi(path, servidor, body) {
  const token = await getToken();
  const headers = { "Content-Type": "application/json", ...(token ? { "X-Plugin-Token": token } : {}) };
  return fetch(`${baseUrl(servidor)}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
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
          // Sondeo en vez de espera fija: cuánto tarda la SPA en arrancar
          // dentro del iframe varía (justo tras recargar la extensión, o
          // con carga del servidor, puede tardar más de los 2.5s fijos que
          // había antes -- confirmado en real 2026-08-24: a los 4s
          // menuTop.paw ya existía como frame pero su contenido interno
          // -- el botón -- aún no estaba listo). Comprueba cada 300ms hasta
          // 8s antes de rendirse.
          const esperarHasta = (comprobar, maxMs) =>
            new Promise((res) => {
              const t0 = Date.now();
              const tick = () => {
                let valor;
                try {
                  valor = comprobar();
                } catch {
                  valor = null;
                }
                if (valor || Date.now() - t0 > maxMs) {
                  res(valor || null);
                } else {
                  setTimeout(tick, 300);
                }
              };
              tick();
            });

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
          ifr.onload = async () => {
            const doc = ifr.contentDocument;
            const buscarMenuDoc = () => {
              const menuTopFrame = Array.from(doc.querySelectorAll("iframe,frame")).find((f) =>
                (f.src || "").includes("menuTop.paw")
              );
              return menuTopFrame && menuTopFrame.contentDocument;
            };
            const btn = await esperarHasta(() => {
              const menuDoc = buscarMenuDoc();
              return menuDoc && menuDoc.querySelector("#pawTheUserInfoBtn");
            }, 8000);
            if (!btn) {
              resolve(null);
              ifr.remove();
              return;
            }
            btn.click();
            const correo = await esperarHasta(() => {
              const menuDoc = buscarMenuDoc();
              const td = menuDoc && menuDoc.querySelector('td[paw\\:rowlabel="Email"]');
              const span = td && td.nextElementSibling && td.nextElementSibling.querySelector(".pawDFTexView");
              return ((span && span.textContent) || "").trim() || null;
            }, 5000);
            let usuario = null;
            if (correo) {
              const menuDoc = buscarMenuDoc();
              const leer = (etiqueta) => {
                const td = menuDoc.querySelector(`td[paw\\:rowlabel="${etiqueta}"]`);
                const span = td && td.nextElementSibling && td.nextElementSibling.querySelector(".pawDFTexView");
                return ((span && span.textContent) || "").trim();
              };
              usuario = leer("Nombre completo") || leer("Nombre de usuario");
            }
            // ProactivaNet recuerda el panel actual A NIVEL DE SESIÓN en el
            // servidor, no solo en este DOM -- si no se pulsa "Atrás" antes
            // de descartar el iframe, la próxima vez que la pestaña REAL
            // recargue menuTop.paw el servidor le sirve el mismo panel de
            // usuario que dejamos aquí, esta vez visible de verdad
            // (confirmado en real 2026-08-24: navegar a otra web y volver a
            // ProactivaNet mostraba el panel). Se pulsa SIEMPRE que se hizo
            // clic en el botón, haya ido bien la lectura del correo o no.
            try {
              const menuDoc = buscarMenuDoc();
              const atras = menuDoc
                ? Array.from(menuDoc.querySelectorAll("*")).find((el) => el.textContent.trim() === "Atrás" && el.children.length === 0)
                : null;
              if (atras) {
                (atras.closest("a,button,[paw\\:ctrl]") || atras).click();
                // Da tiempo a que la petición de "Atrás" llegue al servidor
                // antes de quitar el iframe -- si se retira antes, se
                // cancela la petición en curso y no sirve de nada.
                await new Promise((r) => setTimeout(r, 800));
              }
            } catch {}
            resolve(correo ? { correo, usuario } : null);
            ifr.remove();
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
  // usuarioActivo() devuelve null si no hay VPN/ProactivaNet accesible --
  // antes eso cortaba aquí y Monitor/Buscar/Estadísticas se quedaban sin
  // sesión. Desde 2026-08-25 se pide sesión igualmente, con correo vacío: el
  // servidor la concede solo con el token válido (ver web/app.py:api_sesion),
  // marcando el acceso como "sin verificar" en vez de rechazarlo -- así el
  // plugin entero funciona sin VPN, no solo el Escáner.
  const usuario = (await usuarioActivo()) || {};
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

async function buscarPorUrl(urlSimilares, urlSolucion, etiquetaError) {
  // El servidor devuelve el HTML de las tarjetas ya construido -- el plugin
  // solo lo inyecta, sin plantilla propia (ver web/app.py: _similares_card_html,
  // _ticket_solucion_html). urlSolucion es la solución/propuesta_ia de la
  // PROPIA incidencia buscada, no de los similares (esos ya llevan la suya
  // en su acordeón) -- petición 2026-08-28, ver MEMORIA_PROYECTO.md: antes
  // se pedía y descartaba sin mostrarla.
  const status = document.getElementById("escaner-status");
  const solucionDiv = document.getElementById("escaner-solucion");
  const list = document.getElementById("escaner-list");
  status.textContent = "Cargando…";
  solucionDiv.innerHTML = "";
  list.innerHTML = "";
  const servidor = await getServidor();
  try {
    const res = await fetchApi(urlSimilares, servidor);
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
    // Best-effort: si falla, se queda sin ese bloque pero la lista de
    // similares (lo principal) ya se ha mostrado igualmente.
    try {
      const resSol = await fetchApi(urlSolucion, servidor);
      if (resSol.ok) solucionDiv.innerHTML = await resSol.text();
    } catch {}
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
    } else if (res.status === 404) {
      // Ticket todavía no sincronizado -- ingesta bajo demanda (ver
      // MEMORIA_PROYECTO.md 2026-08-28): se encola en el servidor (sin
      // scrapear en el momento, evita chocar con el login de
      // auto_incremental.py/refresco_listado.py) y
      // src/procesar_ingesta_pendiente.py la procesa por su cuenta en su
      // propio ciclo de n8n. No se sigue a "similares" -- todavía no hay
      // nada que mostrar para este ticket.
      await ingestarBajoDemanda(guid);
      return;
    }
  } catch {
    // si falla, seguimos igualmente a por los similares
  }
  return buscarPorUrl(
    `/api/incidencias/${encodeURIComponent(guid)}/similares/html`,
    `/api/incidencias/${encodeURIComponent(guid)}/solucion/html`,
    "Esta incidencia"
  );
}

async function ingestarBajoDemanda(guid) {
  const status = document.getElementById("escaner-status");
  const list = document.getElementById("escaner-list");
  list.innerHTML = "";
  const servidor = await getServidor();
  try {
    const res = await postApi(`/api/incidencias/${encodeURIComponent(guid)}/ingestar`, servidor, {});
    if (!res.ok) throw new Error(String(res.status));
    status.textContent =
      "Estamos incorporando esta incidencia a la base de datos. El proceso puede tardar unos minutos. Gracias por tu paciencia mientras termina.";
  } catch (err) {
    status.textContent = `Error conectando con el servidor (${servidor}): ${err.message}`;
  }
}

function buscarPorCodigo(codigo) {
  if (!codigo) {
    document.getElementById("escaner-status").textContent = "Introduce un código de incidencia.";
    return;
  }
  return buscarPorUrl(
    `/api/incidencias/por-codigo/${encodeURIComponent(codigo)}/similares/html`,
    `/api/incidencias/por-codigo/${encodeURIComponent(codigo)}/solucion/html`,
    `"${codigo}"`
  );
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

// Botón "Ver detalles" del propio Escáner (junto al de Buscar) -- abre
// directamente la ficha del código escrito, sin pasar por la lista de
// similares. ProactivaNet no da el guid a partir del código (solo al
// revés, ver guidActivo()), así que hace falta resolverlo primero contra
// /api/incidencias/por-codigo/{codigo}.
document.getElementById("esc-detalle").addEventListener("click", async () => {
  const codigo = document.getElementById("esc-codigo").value.trim();
  const status = document.getElementById("escaner-status");
  if (!codigo) {
    status.textContent = "Introduce un código de incidencia.";
    return;
  }
  const servidor = await getServidor();
  try {
    const res = await fetchApi(`/api/incidencias/por-codigo/${encodeURIComponent(codigo)}`, servidor);
    if (res.status === 404) {
      status.textContent = `"${codigo}" no está todavía en la base de conocimiento.`;
      return;
    }
    if (!res.ok) throw new Error(String(res.status));
    const { guid } = await res.json();
    abrirPagina(`/incidencias/${encodeURIComponent(guid)}`);
  } catch (err) {
    status.textContent = `Error conectando con el servidor (${servidor}): ${err.message}`;
  }
});

// Asistente IA: RAG local (ver web/rag.py) -- ~15-20s de respuesta (2
// llamadas secuenciales a Ollama en el servidor), de ahí el aviso de
// espera explícito. La lista de similares solo se muestra si el propio
// backend consideró que había una referencia real (tiene_similares) --
// nunca se muestra "de adorno" si la solución fue el mensaje fijo de "no
// puedo ayudarte".
async function preguntarAsistente() {
  const texto = document.getElementById("ast-texto").value.trim();
  const boton = document.getElementById("ast-buscar");
  const espera = document.getElementById("ast-espera");
  const solucionWrap = document.getElementById("ast-solucion-wrap");
  const similaresWrap = document.getElementById("ast-similares-wrap");
  if (!texto) return;

  boton.disabled = true;
  espera.hidden = false;
  solucionWrap.hidden = true;
  similaresWrap.hidden = true;

  const servidor = await getServidor();
  try {
    const res = await postApi("/api/asistente-ia", servidor, { texto });
    if (res.status === 403) {
      document.getElementById("ast-solucion").value = "Este equipo no está autorizado a usar el plugin.";
      solucionWrap.hidden = false;
      return;
    }
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    document.getElementById("ast-solucion").value = data.solucion;
    solucionWrap.hidden = false;
    if (data.tiene_similares) {
      document.getElementById("ast-similares-list").innerHTML = data.similares_html;
      similaresWrap.hidden = false;
    }
  } catch (err) {
    document.getElementById("ast-solucion").value = `Error conectando con el servidor (${servidor}): ${err.message}`;
    solucionWrap.hidden = false;
  } finally {
    boton.disabled = false;
    espera.hidden = true;
  }
}
document.getElementById("ast-buscar").addEventListener("click", preguntarAsistente);

document.getElementById("ast-similares-list").addEventListener("click", (e) => {
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

// Acción compartida por la barra de iconos (#menu) y el menú de texto
// (#menu-texto) -- mismos data-open/data-view, dos superficies distintas
// para llegar a lo mismo (petición 2026-08-30, ver MEMORIA_PROYECTO.md).
// data-open-externo (accesos SAP, 2026-08-30) es de solo el menú de
// texto por ahora, pero se maneja aquí igual por si el futuro lo pide en
// la barra de iconos también -- chrome.tabs.create directo, SIN pasar
// por abrirPagina()/baseUrl(): son URLs externas absolutas, no rutas de
// nuestro propio servidor.
function manejarClicNavegacion(target) {
  const btnOpen = target.closest("button[data-open]");
  if (btnOpen) {
    abrirPagina(btnOpen.dataset.open);
    return true;
  }
  const btnOpenExterno = target.closest("button[data-open-externo]");
  if (btnOpenExterno) {
    chrome.tabs.create({ url: btnOpenExterno.dataset.openExterno });
    return true;
  }
  const btnView = target.closest("button[data-view]");
  if (btnView) {
    document.querySelectorAll("#menu button[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === btnView.dataset.view));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${btnView.dataset.view}`));
    if (btnView.dataset.view === "escaner") cargarEscaner();
    return true;
  }
  return false;
}

document.getElementById("menu").addEventListener("click", (e) => {
  manejarClicNavegacion(e.target);
});

// Menú de texto tipo aplicación: cada palabra despliega su lista, un clic
// fuera o en una opción lo cierra.
const menuTexto = document.getElementById("menu-texto");
function cerrarDropdownsMenuTexto() {
  menuTexto.querySelectorAll(".menu-texto-dropdown").forEach((d) => { d.hidden = true; });
  menuTexto.querySelectorAll(".menu-texto-titulo").forEach((t) => t.classList.remove("abierto"));
}
menuTexto.addEventListener("click", (e) => {
  const titulo = e.target.closest(".menu-texto-titulo");
  if (titulo) {
    const dropdown = menuTexto.querySelector(`[data-menu-dropdown="${titulo.dataset.menu}"]`);
    const yaAbierto = !dropdown.hidden;
    cerrarDropdownsMenuTexto();
    dropdown.hidden = yaAbierto;
    titulo.classList.toggle("abierto", !yaAbierto);
    return;
  }
  const manejado = manejarClicNavegacion(e.target);
  if (manejado) cerrarDropdownsMenuTexto();
});
document.addEventListener("click", (e) => {
  if (!menuTexto.contains(e.target)) cerrarDropdownsMenuTexto();
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
