# TuZonaMarket — Internal API notes

Reverse-engineered notes for scraping product data from **tuzonamarket.com** via its private REST API. Companion script: `tunzonamarketExtractor.ts` (same folder).

> Findings date: 2026-09-15. The site is an Angular SPA; if endpoints break, the recipe in "How this was discovered" below shows how to re-derive them from the frontend bundle.

## TL;DR

- The site is a client-rendered Angular app. The HTML you GET from `tuzonamarket.com/...` is a ~5 KB shell with **no product data**.
- All data comes from a public REST API: **`https://api.tuzonamarket.com`**.
- **No authentication, no signing, no special headers** required for read endpoints (verified with bare `curl`).
- Category listing endpoint (the one to scrape):

  ```
  GET https://api.tuzonamarket.com/api/categoria/supermercado/{zonaId}/{categorySlugPath}?pag={n}
  ```

- Pagination is server-side: 96 items per page (fixed), response reports `pag` / `maxpag`.
- There is **no parameter to change the page size**. Unknown query params are rejected with HTTP 400:

  ```json
  {"limit":{"errors":["This field was not expected."]}}
  ```

  Only `pag` is accepted. Being "gentle" is achieved by using `pag` (fewest possible requests) + throttling, not by a page-size param.

## How this was discovered

The Angular bundle (downloaded from `tuzonamarket.com/main-<hash>.js` + its `chunk-*.js` imports) contains all service definitions. Useful recipes:

```bash
# find API hosts + endpoints
grep -hoE '"https?://[^"]+"' *.js | sort -u
grep -hoE '`?/api/[a-zA-Z0-9/${}.:_-]+' *.js | sort -u

# see how an endpoint is called (params, pagination, shape)
grep -oE '.{300}categoria/supermercado.{500}' <chunk>.js
```

Relevant env config found in the bundle:

```js
{ production: true, host: "https://api.tuzonamarket.com", web: "https://tuzonamarket.com", ... }
```

A previous copy of the downloaded bundle lives in `/tmp/opencode/tzm` (ephemeral).

## Zones

`GET /api/zona/listadoapi` → array of zones:

| id | nombre | slug |
|----|-----------|----------|
| 2 | Carabobo | `carabobo` |
| 3 | Lara | `lara` |

The zone is the first segment of site URLs: `/carabobo/supermercado/...`.

## Category tree

`GET /api/categoria/menuwebsite` → plain array of 28 root categories (Alimentos, Farmacia, Licoreria, ...), each with nested `subcategoria[]`. Every node has `id`, `nombre`, `slug`, `estatus`.

A category's "slug path" is its chain of slugs joined by `/`, e.g.:

- Root: `alimentos`
- Sub: `alimentos/pan-harinas-cereales`
- Leaf: `alimentos/pan-harinas-cereales/pan-y-harinas`

This mirrors the site URL: `/carabobo/supermercado/alimentos/pan-harinas-cereales` (the literal `supermercado` segment is not part of the API path).

## Main endpoint: products by category

```
GET /api/categoria/supermercado/{zonaId}/{slugPath}?pag={n}
```

- `slugPath` may be 1–3 segments deep. A **parent path returns the products of its entire subtree** (e.g. `alimentos` → ~3,000+ items across 33 pages; `alimentos/pan-harinas-cereales` → 151 items; its leaf `pan-y-harinas` → 64).
- `pag` starts at 1.
- Page size: fixed 96 items (server-controlled; not configurable).
- The frontend calls this exactly like the script does: `supermercadoService(zona.id, slugPath, pagina)`.

Response shape:

```jsonc
{
  "categoria": [ /* the requested category subtree */ ],
  "producto": {
    "pag": 1,
    "maxpag": 2,          // total pages for this query
    "data": [ /* ≤96 products */ ]
  }
}
```

### Product object (relevant fields)

```jsonc
{
  "id": 4643,
  "nombre": "Harina Maiz Blanco Libre de Gluten Pan 1 Kg",
  "sku": "7591002200145",
  "slug": "harina-maiz-blanco-libre-de-gluten-pan-1-kg",
  "descripcion": "...",
  "principalImagen": "https://assets.tuzonamarket.com/images/producto/....jpg",
  "updatedAt": "2026-01-15 09:26:52",
  "inventario": [{ "existencia": 2349, "minimo": 2, ... }],   // stock
  "categoria": [ /* categories this product belongs to (leaf nodes with id/slug/nombre) */ ],
  "etiqueta": [ /* tags */ ],
  "precio": [
    {
      "precio": 126,             // list price in USD cents (126 = $1.26), tax-inclusive
      "oferta": 113,             // discounted price in cents; 0/absent = no offer
      "impuesto": { "nombre": "Exento", "porcentaje": 0 },      // or "IVA 16%", porcentaje: 1600 (percent × 100)
      "modalidadVenta": { "unidad": 1, "minimo": 1, "maximo": 100 },
      "usuarioTipo": { "nombre": "Prime" }   // price tier: "Basico" | "Prime"
    }
  ]
}
```

Notes on prices:

- There is one `precio[]` entry per `usuarioTipo` tier (usually `Basico` and `Prime`, often identical).
- **All monetary amounts (`precio`, `oferta`) come in USD cents** (206 = $2.06, as rendered by the frontend). Divide by 100.
- **Effective price = `oferta` if `oferta > 0`, else `precio`.** Beware `oferta: 0` means "no offer" (not free!).
- Prices are shown tax-inclusive on the site (frontend renders an "IVA Incluido" badge when `impuesto.porcentaje > 0`). The raw `porcentaje` is percent×100 (1600 = 16%, 0 = exento); the UI never prints it directly.

## Other public endpoints (from the bundle)

| Endpoint | Purpose |
|---|---|
| `GET /api/producto/slug/{slug}/zona/{zonaId}` | Product detail + related products |
| `GET /api/producto/oferta/zona/{zonaId}/{pag}` | Deals, paginated `{pag, maxpag, data}` (verified) |
| `GET /api/producto/masvendidos/zona/{zonaId}` | Best sellers (verified) |
| `GET /api/producto/recientes/zona/{zonaId}` | Recently added |
| `GET /api/producto/buscar/zona/{zonaId}?q={text}&pag={n}` | Search |
| `GET /api/producto/buscar/autocompletado/zona/{zonaId}?...` | Autocomplete |
| `GET /api/producto/etiqueta/{tagSlug}/zona/{zonaId}?...` | By tag |
| `GET /api/website/inicio/{zonaId}` | Home page payload |
| `GET /api/website/destacado/{a}/{b}` | Featured |
| `GET /api/listarapida/zona/{zonaId}/listadowebsite` | Quick lists |
| `GET /api/moneda/mercado` | Exchange rates (site showed 842.21 Bs/USD) |
| `GET /api/zona/sector`, `/api/website/direccion/formdata` | Delivery zones/addresses |

Admin endpoints (`/admin/...`, `/login_check`) exist in the bundle but require auth and are out of scope.

**Algolia** is used for search autocomplete: app `7YEGNNSZF7`, search-only key `3e9cfcecf16e1deac9cc7bc5b7a7e9b4`, index `prod_TZM` (search-only key, fine to use for discovery of product slugs/names). There's also an Algolia Agent Studio gateway (`external-api-bldo3ynb.uk.gateway.dev`) — not needed for scraping.

## Recommended scraping strategy

1. `GET /api/categoria/menuwebsite` — build the category tree.
2. Scrape only the **28 root paths** (`alimentos`, `farmacia`, ...): each root returns its whole subtree, so this is the minimum number of requests for full coverage. Products carry their own `categoria[]` membership, so nothing is lost by skipping children.
3. For each root: `?pag=1..maxpag`.
4. **Deduplicate by product `id`** — the same product appears in several roots/subtrees (e.g. `importado`, `saludable` overlap with `alimentos`).
5. Throttle: the script enforces ≥12 s between requests (5 req/min max) and backs off on 429/5xx with `Retry-After` support.

Rough cost of a full scrape at 5 req/min: ~130–180 requests (28 roots, avg ~5 pages each) ≈ 30–40 minutes. Use `--categoria=<path>` to scrape a single subtree instead.

Etiquette: GET-only public catalog data, no concurrency, honor errors rather than retrying storms. Unknown params cause HTTP 400 — never "explore" the API by brute-forcing params.

## Using the script

```bash
# full site, zone Carabobo (default)
node tunzonamarketExtractor.ts

# other zone
node tunzonamarketExtractor.ts --zona=lara        # or --zona=3

# single category (full path, or bare slug if unambiguous)
node tunzonamarketExtractor.ts --categoria=alimentos/pan-harinas-cereales

# custom output file
node tunzonamarketExtractor.ts --out=productos.json
```

Runs on Node ≥ 22 (type-stripped native `.ts`, no dependencies). Typecheck with pnpm:

```bash
pnpm exec tsc --noEmit --strict --target es2024 --module es2022 --moduleResolution bundler --types node tunzonamarketExtractor.ts
```

Output JSON:

```jsonc
{
  "fuente": "https://api.tuzonamarket.com",
  "extraidoEn": "...",
  "zona": { "id": 2, "nombre": "Carabobo", "slug": "carabobo" },
  "totalProductos": 1234,
  "peticionesRealizadas": 140,
  "duracionSegundos": 1680,
  "categorias": [{ "ruta": "alimentos", "id": 34, "nombre": "Alimentos", "paginas": 33, "productos": 3168 }],
  "productos": [
    {
      "id": 4643, "nombre": "...", "sku": "...", "slug": "...",
      "imagen": "...", "actualizadoEn": "...", "stock": 2349,
      "categorias": [{ "id": 3562, "slug": "pan-y-harinas", "nombre": "Harinas" }],
      "precios": [
        {
          "usuarioTipo": "Basico",
          "precioRaw": 126,        // cents, as the API sends it
          "precio": 1.26,          // dollars (precioRaw / 100)
          "ofertaRaw": null,       // null when API sends 0
          "oferta": null,          // dollars
          "precioEfectivo": 1.13,  // dollars; oferta if any, else precio
          "impuestoNombre": "IVA 16%",
          "impuestoPorcentajeRaw": 1600,  // percent × 100, as the API sends it
          "impuestoPorcentaje": 16,
          "venta": { "unidad": 1, "minimo": 1, "maximo": 100 }
        }
      ]
    }
  ]
}
```

## Quirks observed

- Query params are strictly validated: any param besides `pag` (where applicable) → HTTP 400 `{"<param>":{"errors":["This field was not expected."]}}`.
- Repeat browser visits show no XHR traffic in devtools — responses are served from HTTP/browser cache; the API itself is plain GETs.
- `impuesto.porcentaje` is stored ×100 (1600 = 16%). The UI only uses it as a boolean (>0 → "IVA Incluido" badge).
- Monetary amounts are stored in cents (see "Notes on prices"); the extractor emits `precio`/`oferta` in dollars and keeps the cent values as `precioRaw`/`ofertaRaw`.
- Some timestamps in seed data are `"-0001-11-30"` (pre-epoch placeholder).
- Product `updatedAt` looks like a reliable "price changed" signal (checked when diffing runs).
