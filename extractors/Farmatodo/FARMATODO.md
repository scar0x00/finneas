# Farmatodo (farmatodo.com.ve) — API research & scraping notes

Findings from inspecting the site's JS bundle (`main-es2018.54b69397c327b56e5e68.js`)
and probing the API on 2026-09-15. The scraper lives in `farmatodo.ts`.

## How the site loads product data

`www.farmatodo.com.ve` is an **Angular SPA**. The HTML shell contains no products;
the frontend fetches everything client-side. All product browsing/search goes through
**Algolia** (the app embeds the `algoliasearch` JS client). The transactional REST
gateway is only used for cart/checkout/user data, not for browsing products.

## The Algolia search backend

The credentials are public "search-only" keys embedded in the JS bundle:

| Setting        | Value                                        |
| -------------- | -------------------------------------------- |
| Application ID | `VCOJEYD2PO`                                 |
| Search API key | `869a91e98550dd668b8b1dc04bca9011`           |
| Index (VE)     | `products-venezuela`                         |
| Index (CO)     | `products` (same app, Colombian site)        |
| Aux indexes    | `properties-vzla`, `items_seo_vzla`          |

- Host: `https://vcojeyd2po-dsn.algolia.net` (the frontend actually routes queries
  through a proxy at `https://api-search.farmatodo.com` for Topsort sponsored-ads
  analytics, but the plain Algolia endpoint works identically).
- Site default page size: **24 hits**. Algolia's hard max is **1000 hits per page**.
- Index currently holds **43,618 products** (`nbHits` with empty query).
- Country-specific headers the frontend sends: `X-Country: VE`, `X-Custom-City: <city code>`.
  City is only needed for city-pinned pricing; raw responses already include
  per-city prices (see schema below), so the scraper doesn't send it.

## Search request format

`POST https://vcojeyd2po-dsn.algolia.net/1/indexes/products-venezuela/query`

```
headers:
  Content-Type: application/json
  x-algolia-application-id: VCOJEYD2PO
  x-algolia-api-key: 869a91e98550dd668b8b1dc04bca9011

body: {"params": "query=&hitsPerPage=24&page=0&filters=...&facets=..."}
```

`params` is a URL-encoded query string inside JSON (standard Algolia format).

### Useful parameters

| Param               | Meaning                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `query`             | Free-text search (leave empty to browse)                             |
| `hitsPerPage`       | Page size, **1–1000** (max 1000 is an Algolia limit)                 |
| `page`              | Zero-based page number; response gives `nbHits`/`nbPages`            |
| `filters`           | Facet filters, e.g. `departments:'Belleza'`                          |
| `facets`            | JSON array of facets to count, `["*"]` for all                       |
| `maxValuesPerFacet` | Max distinct facet values returned (used 100)                        |

### Category facets (verified live)

- `departments` — 7 top-level categories: `Salud y Medicamentos` (7,677),
  `Cuidado Personal` (5,359), `Belleza` (4,924), `Alimentos y Bebidas` (4,051),
  `Hogar Mascota y Otros` (3,720), `Bebé` (1,113), `None` (232).
- `categorie` — 37 second-level categories (e.g. `Cosméticos`, `Medicamentos`).
- `subCategory` — third level.
- `marca` — brands. `status` — active state. `outofstore` — `false` = sellable online.

The category page URLs (`/categorias/belleza/cosmeticos`) map to
`departments` / `categorie` / `subCategory` facet values, so scraping
"by category" = filtering on these facets. Filter syntax example:

```
filters=departments:'Belleza' AND outofstore:false
```

## Product hit schema (price-relevant fields)

```jsonc
{
  "id": "116587608",               // same as objectID
  "mediaDescription": "Cicabru Crema Dermorestauradora 30g",  // product name
  "marca": "...", "brand": "2008M-0008623",
  "barcode": "...",
  "fullPrice": 952,                // current sell price (Bs.)
  "offerPrice": 0,                 // >0 when on offer
  "unitPrice": 820.69,             // price without taxes
  "taxRate": 16, "taxes": 131.31,
  "fullPriceByCity": [ { "cityCode": "CAR", "fullPrice": 952 }, ... ],  // ~55 cities
  "offerPriceByCity": [],
  "listUrlImages": [ "https://lh3.googleusercontent.com/..." ],
  "departments": "Belleza", "categorie": "...", "subCategory": "...",  // string or array
  "status": "A",
  "outofstore": false,
  "stores_with_stock": [113, 108, ...],   // store IDs with stock
  "requirePrescription": "false",
  "lastUpdate": { "jobName": "UPDATE_STOCK", "timeStamp": 1789509798465 }
}
```

## Other backend endpoints (not needed for scraping)

The bundle references a transactional gateway
(`https://gw-backend-ve.farmatodo.com/` + `_ah/api/`) with endpoints such as:

- `categoryEndpoint/getCategoriesAndSubCategories`
- `categoryEndpoint/getProductsFromCategoryAlgolia`
- `categoryEndpoint/getProductsFromFilter`, `getMostSales`
- `productEndpoint/v2/getItem`

These require extra session params the frontend injects (`idStoreGroup`,
`idCustomerWebSafe`, `source`), and the category ones just proxy the same Algolia
index — so querying Algolia directly is simpler and sufficient.

## The scraper (`farmatodo.ts`)

Dependency-free Node 18+ TypeScript. Run with:

```bash
pnpx tsx farmatodo.ts                                    # all departments
pnpx tsx farmatodo.ts --department="Belleza"             # single department
pnpx tsx farmatodo.ts --category="Cosméticos"            # single category
pnpx tsx farmatodo.ts --hits-per-page=100 --out-dir=out  # custom paging/output
```

Behavior:

- Discovers departments via one facet query, then paginates each department
  (`outofstore:false` filter applied by default — matches what the storefront sells).
- **Throttling: sliding-window rate limiter, max 5 requests per 60s** (all HTTP
  calls go through it, including retries; the limiter also adds a small safety
  margin beyond the strict 60s wait).
- **Page size: 500 hits/request** (Algolia max is 1000). Fewer, larger pages =
  fewer total requests (~88 requests for the whole catalog ≈ 18 min at 5 req/min).
  Tune with `--hits-per-page`.
- Retries failed requests (429/5xx/network) up to 3 times with 15s/30s backoff.
- Output: one JSON file per department in `farmatodo-data/`
  (`products-<department>.json`) plus `summary.json` (per-department counts,
  category facet counts, total request count).

## Etiquette

- Total catalog ≈ 43.6k products → ~88 requests at 500/page, capped at 5 req/min.
- The key is the site's public search-only key; queries are read-only and the
  same volume the storefront generates during normal browsing.
- Avoid raising `--max-req-per-min` or lowering `--hits-per-page` unless necessary;
  both multiply request volume.
