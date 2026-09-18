/**
 * tuzonamarketExtractor.ts
 *
 * Scrapea productos y precios de TuZonaMarket (tuzonamarket.com) a través de su
 * API REST privada (https://api.tuzonamarket.com), la misma que consume el
 * frontend Angular. No requiere autenticación.
 *
 * Uso:
 *   node tuzonamarketExtractor.ts
 *   node tuzonamarketExtractor.ts --zona=lara
 *   node tuzonamarketExtractor.ts --zona=2 --out=productos.json
 *   node tuzonamarketExtractor.ts --categoria=alimentos/pan-harinas-cereales
 *
 * Cortesía con el servidor:
 *   - Máximo 5 peticiones/minuto (intervalo mínimo de 12 s entre peticiones).
 *   - Reintentos con retroceso ante 429/5xx y errores de red.
 *   - Solo se envía el parámetro `pag`; la API rechaza con HTTP 400 cualquier
 *     parámetro no esperado, y no expone ningún parámetro para el tamaño de
 *     página (fijo en 96 ítems por el servidor).
 */
import { writeFileSync } from "node:fs";

const API_BASE = "https://api.tuzonamarket.com";
const MIN_REQUEST_INTERVAL_MS = 12_000;
const RETRY_BACKOFF_MS = 30_000;
const MAX_RETRIES = 3;
const USER_AGENT =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

interface Zona {
    id: number;
    nombre: string;
    slug: string;
}

interface CategoriaNodo {
    id: number;
    nombre: string;
    slug: string;
    estatus: number;
    subcategoria?: CategoriaNodo[];
}

interface PrecioApi {
    precio: number;
    oferta?: number | null;
    impuesto?: { porcentaje?: number; nombre?: string };
    modalidadVenta?: { unidad?: number; minimo?: number; maximo?: number };
    usuarioTipo?: { nombre?: string };
}

interface ProductoApi {
    id: number;
    nombre: string;
    sku: string;
    slug: string;
    descripcion?: string;
    principalImagen?: string;
    updatedAt?: string;
    inventario?: { existencia?: number }[];
    precio?: PrecioApi[];
    categoria?: CategoriaNodo[];
}

interface RespuestaCategoria {
    producto?: { pag?: number; maxpag?: number; data?: ProductoApi[] };
}

interface ProductoExtraido {
    id: number;
    nombre: string;
    sku: string;
    slug: string;
    descripcion: string | null;
    imagen: string | null;
    actualizadoEn: string | null;
    stock: number | null;
    categorias: { id: number; slug: string; nombre: string }[];
    precios: {
        usuarioTipo: string | null;
        precioRaw: number;
        precio: number;
        ofertaRaw: number | null;
        oferta: number | null;
        precioEfectivo: number;
        impuestoNombre: string | null;
        impuestoPorcentajeRaw: number;
        impuestoPorcentaje: number;
        venta: {
            unidad: number | null;
            minimo: number | null;
            maximo: number | null;
        } | null;
    }[];
}

interface ResumenCategoria {
    ruta: string;
    id: number;
    nombre: string;
    paginas: number;
    productos: number;
}

class ErrorHttp extends Error {
    readonly status: number;
    constructor(status: number, mensaje: string) {
        super(mensaje);
        this.name = "ErrorHttp";
        this.status = status;
    }
}

let lastRequestAt = 0;
let requestCount = 0;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(mensaje: string): void {
    console.log(`[${new Date().toISOString()}] ${mensaje}`);
}

async function apiGet<T>(ruta: string): Promise<T> {
    const url = `${API_BASE}${ruta}`;
    for (let intento = 1;; intento++) {
        const espera = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
        if (espera > 0) await sleep(espera);
        lastRequestAt = Date.now();
        requestCount++;
        let respuesta: Response;
        try {
            respuesta = await fetch(url, {
                headers: {
                    "User-Agent": USER_AGENT,
                    Accept: "application/json",
                },
            });
        } catch (error) {
            if (intento >= MAX_RETRIES) throw error;
            log(`error de red (${intento}/${MAX_RETRIES}); reintentando en ${
                RETRY_BACKOFF_MS / 1000
            } s`);
            await sleep(RETRY_BACKOFF_MS);
            continue;
        }
        if (respuesta.status === 429 || respuesta.status >= 500) {
            if (intento >= MAX_RETRIES) {
                throw new ErrorHttp(
                    respuesta.status,
                    `HTTP ${respuesta.status} en ${ruta}`,
                );
            }
            const retryAfter = Number(respuesta.headers.get("retry-after"));
            const pausa = Number.isFinite(retryAfter) && retryAfter > 0
                ? retryAfter * 1000
                : RETRY_BACKOFF_MS;
            log(`HTTP ${respuesta.status} (${intento}/${MAX_RETRIES}); reintentando en ${
                Math.round(pausa / 1000)
            } s`);
            await sleep(pausa);
            continue;
        }
        if (!respuesta.ok) {
            const cuerpo = await respuesta.text();
            throw new ErrorHttp(
                respuesta.status,
                `HTTP ${respuesta.status} en ${ruta}: ${cuerpo.slice(0, 300)}`,
            );
        }
        return (await respuesta.json()) as T;
    }
}

async function resolverZona(argumento: string): Promise<Zona> {
    const zonas = await apiGet<Zona[]>("/api/zona/listadoapi");
    const buscado = argumento.toLowerCase();
    const zona = zonas.find(
        (z) =>
            z.slug.toLowerCase() === buscado ||
            z.nombre.toLowerCase() === buscado ||
            String(z.id) === argumento,
    );
    if (!zona) {
        throw new Error(
            `Zona desconocida: "${argumento}". Disponibles: ${
                zonas
                    .map((z) => `${z.slug} (id ${z.id})`)
                    .join(", ")
            }`,
        );
    }
    return zona;
}

function mapearCategorias(
    nodos: CategoriaNodo[],
    prefijo: string[],
    salida: Map<string, CategoriaNodo>,
): void {
    for (const nodo of nodos) {
        const ruta = [...prefijo, nodo.slug];
        salida.set(ruta.join("/"), nodo);
        if (nodo.subcategoria && nodo.subcategoria.length > 0) {
            mapearCategorias(nodo.subcategoria, ruta, salida);
        }
    }
}

function normalizar(p: ProductoApi): ProductoExtraido {
    return {
        id: p.id,
        nombre: p.nombre,
        sku: p.sku,
        slug: p.slug,
        descripcion: p.descripcion ?? null,
        imagen: p.principalImagen ?? null,
        actualizadoEn: p.updatedAt ?? null,
        stock: p.inventario?.[0]?.existencia ?? null,
        categorias: (p.categoria ?? []).map((c) => ({
            id: c.id,
            slug: c.slug,
            nombre: c.nombre,
        })),
        precios: (p.precio ?? []).map((pr) => {
            // oferta == 0 significa "sin oferta"; no confundir con precio gratis
            const ofertaRaw = pr.oferta && pr.oferta > 0 ? pr.oferta : null;
            // la API devuelve los montos en centavos (206 = $2,06); el
            // frontend los divide por 100 al renderizar
            const monto = (centavos: number): number => centavos / 100;
            // impuesto.porcentaje viene en puntos base (1600 = 16%, 0 = exento)
            const porcentaje = pr.impuesto?.porcentaje ?? 0;
            return {
                usuarioTipo: pr.usuarioTipo?.nombre ?? null,
                precioRaw: pr.precio,
                precio: monto(pr.precio),
                ofertaRaw,
                oferta: ofertaRaw === null ? null : monto(ofertaRaw),
                precioEfectivo: monto(ofertaRaw ?? pr.precio),
                impuestoNombre: pr.impuesto?.nombre ?? null,
                impuestoPorcentajeRaw: porcentaje,
                impuestoPorcentaje: porcentaje / 100,
                venta: pr.modalidadVenta
                    ? {
                        unidad: pr.modalidadVenta.unidad ?? null,
                        minimo: pr.modalidadVenta.minimo ?? null,
                        maximo: pr.modalidadVenta.maximo ?? null,
                    }
                    : null,
            };
        }),
    };
}

async function extraerRuta(
    zonaId: number,
    ruta: string,
    nodo: CategoriaNodo,
    productos: Map<number, ProductoExtraido>,
    resumen: ResumenCategoria[],
): Promise<void> {
    let pagina = 1;
    let maxpag = 1;
    let nuevos = 0;
    do {
        const datos = await apiGet<RespuestaCategoria>(
            `/api/categoria/supermercado/${zonaId}/${ruta}?pag=${pagina}`,
        );
        const lote = datos.producto?.data ?? [];
        maxpag = Math.max(1, datos.producto?.maxpag ?? 1);
        for (const producto of lote) {
            if (!productos.has(producto.id)) {
                productos.set(producto.id, normalizar(producto));
                nuevos++;
            }
        }
        log(
            `[petición ${requestCount}] ${ruta} · página ${pagina}/${maxpag} · ` +
                `${lote.length} productos (${nuevos} nuevos, ${productos.size} únicos acumulados)`,
        );
        pagina++;
    } while (pagina <= maxpag);
    resumen.push({
        ruta,
        id: nodo.id,
        nombre: nodo.nombre,
        paginas: maxpag,
        productos: nuevos,
    });
}

interface Opciones {
    zona: string;
    categoria: string | null;
    salida: string | null;
}

function parseArgs(argv: string[]): Opciones {
    const opciones: Opciones = {
        zona: "carabobo",
        categoria: null,
        salida: null,
    };
    for (const arg of argv) {
        const valor = (clave: string): string => {
            if (arg.startsWith(`--${clave}=`)) {
                return arg.slice(clave.length + 3);
            }
            throw new Error(
                `El argumento --${clave} espera un valor: --${clave}=<valor>`,
            );
        };
        if (arg.startsWith("--zona=")) opciones.zona = valor("zona");
        else if (arg.startsWith("--categoria=")) {
            opciones.categoria = valor("categoria");
        } else if (arg.startsWith("--out=")) opciones.salida = valor("out");
        else {
            throw new Error(
                `Argumento no reconocido: ${arg}\n` +
                    "Uso: node tuzonamarketExtractor.ts [--zona=carabobo|lara|<id>] " +
                    "[--categoria=<ruta/de/slugs>] [--out=<archivo.json>]",
            );
        }
    }
    return opciones;
}

async function main(): Promise<void> {
    const opciones = parseArgs(process.argv.slice(2));
    const inicio = Date.now();
    log(`Extracción de ${API_BASE}`);

    const zona = await resolverZona(opciones.zona);
    log(`Zona: ${zona.nombre} (id ${zona.id})`);

    log("Obteniendo árbol de categorías...");
    const raices = await apiGet<CategoriaNodo[]>("/api/categoria/menuwebsite");

    let objetivos: { ruta: string; nodo: CategoriaNodo }[];
    if (opciones.categoria) {
        const mapa = new Map<string, CategoriaNodo>();
        mapearCategorias(raices, [], mapa);
        const clave = opciones.categoria.replace(/^\/+|\/+$/g, "");
        let nodo = mapa.get(clave);
        if (!nodo) {
            const coincidencias = [...mapa.entries()].filter(([ruta]) =>
                ruta.split("/").pop() === clave
            );
            if (coincidencias.length === 1) nodo = coincidencias[0][1];
            else if (coincidencias.length > 1) {
                throw new Error(
                    `Slug ambiguo: "${clave}" coincide con ${coincidencias.length} categorías ` +
                        `(${
                            coincidencias.map(([r]) => r).join(", ")
                        }). Usa la ruta completa.`,
                );
            }
        }
        if (!nodo) {
            throw new Error(
                `Categoría desconocida: "${clave}". Consulta TU_ZONA_MARKET_API.md o usa una ruta válida como "alimentos/pan-harinas-cereales"`,
            );
        }
        const rutaNodo = [...mapa.entries()].find(([, n]) =>
            n.id === nodo.id
        )![0];
        objetivos = [{ ruta: rutaNodo, nodo }];
    } else {
        objetivos = raices.map((raiz) => ({ ruta: raiz.slug, nodo: raiz }));
    }
    log(
        `Categorías a consultar: ${objetivos.length} (por defecto solo las 28 raíces: cada raíz ` +
            "devuelve todo su subárbol; se deduplican productos por id)",
    );

    const productos = new Map<number, ProductoExtraido>();
    const resumen: ResumenCategoria[] = [];

    for (const objetivo of objetivos) {
        try {
            await extraerRuta(
                zona.id,
                objetivo.ruta,
                objetivo.nodo,
                productos,
                resumen,
            );
        } catch (error) {
            log(`AVISO: se omite "${objetivo.ruta}": ${
                error instanceof Error ? error.message : String(error)
            }`);
        }
    }

    const duracionSegundos = Math.round((Date.now() - inicio) / 1000);
    const salida = opciones.salida ??
        `tuzonamarket-productos-${zona.slug}.json`;
    const resultado = {
        fuente: API_BASE,
        extraidoEn: new Date().toISOString(),
        zona: { id: zona.id, nombre: zona.nombre, slug: zona.slug },
        totalProductos: productos.size,
        peticionesRealizadas: requestCount,
        duracionSegundos,
        categorias: resumen,
        productos: [...productos.values()],
    };
    writeFileSync(salida, JSON.stringify(resultado, null, 2));
    log(
        `OK: ${productos.size} productos únicos → ${salida} ` +
            `(${requestCount} peticiones, ${duracionSegundos} s)`,
    );
}

void main().catch((error) => {
    console.error(
        `ERROR: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
});
