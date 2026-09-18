#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ALGOLIA_APP_ID = "VCOJEYD2PO";
const ALGOLIA_API_KEY = "869a91e98550dd668b8b1dc04bca9011";
const ALGOLIA_HOST = "https://vcojeyd2po-dsn.algolia.net";
const INDEX_NAME = "products-venezuela";

const DEFAULT_HITS_PER_PAGE = 500;
const DEFAULT_MAX_REQUESTS_PER_MINUTE = 5;
const DEFAULT_OUT_DIR = "farmatodo-data";
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 15_000;

interface CliArgs {
  hitsPerPage: number;
  maxRequestsPerMinute: number;
  outDir: string;
  department?: string;
  category?: string;
  includeNone: boolean;
  includeOutOfStore: boolean;
}

interface PriceByCity {
  cityCode: string;
  fullPrice?: number;
  offerPrice?: number;
}

interface ProductHit {
  id?: string;
  objectID?: string;
  mediaDescription?: string;
  largeDescription?: string;
  brand?: string;
  marca?: string;
  barcode?: string;
  barcodeList?: string[];
  departments?: string | string[];
  categorie?: string | string[];
  subCategory?: string | string[];
  fullPrice?: number;
  offerPrice?: number;
  unitPrice?: number;
  taxRate?: number;
  taxes?: number;
  fullPriceByCity?: PriceByCity[];
  offerPriceByCity?: PriceByCity[];
  listUrlImages?: string[];
  mediaImageUrl?: string;
  status?: string;
  requirePrescription?: string;
  outofstore?: boolean;
  stores_with_stock?: number[];
  lastUpdate?: { jobName?: string; timeStamp?: number };
}

interface Facets {
  [facet: string]: { [value: string]: number };
}

interface AlgoliaPage {
  hits: ProductHit[];
  nbHits: number;
  page: number;
  nbPages: number;
  hitsPerPage: number;
  facets?: Facets;
}

interface SlimProduct {
  id: string;
  name: string;
  description?: string;
  brand?: string;
  barcode?: string;
  departments: string[];
  categories: string[];
  subCategories: string[];
  prices: {
    full?: number;
    offer?: number;
    unit?: number;
    taxRate?: number;
    taxes?: number;
    byCity?: PriceByCity[];
  };
  images: string[];
  status?: string;
  requiresPrescription: boolean;
  outOfStore: boolean;
  storeCountWithStock: number;
  lastUpdate?: { jobName?: string; timeStamp?: number };
}

interface DepartmentResult {
  department: string;
  scrapedAt: string;
  totalHits: number;
  requestsUsed: number;
  categoryCounts: Facets["categorie"];
  subCategoryCounts: Facets["subCategory"];
  products: SlimProduct[];
}

class RateLimiter {
  private requestStarts: number[] = [];
  totalRequests = 0;

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
  ) {}

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.requestStarts = this.requestStarts.filter(
        (t) => now - t < this.windowMs,
      );
      if (this.requestStarts.length < this.maxRequests) {
        this.requestStarts.push(now);
        this.totalRequests += 1;
        return;
      }
      const waitMs = this.windowMs - (now - this.requestStarts[0]) + 250;
      console.log(
        `  rate limit: waiting ${
          (waitMs / 1000).toFixed(1)
        }s (max ${this.maxRequests} req/${this.windowMs / 1000}s)`,
      );
      await sleep(waitMs);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    hitsPerPage: DEFAULT_HITS_PER_PAGE,
    maxRequestsPerMinute: DEFAULT_MAX_REQUESTS_PER_MINUTE,
    outDir: DEFAULT_OUT_DIR,
    includeNone: false,
    includeOutOfStore: false,
  };
  for (const raw of argv) {
    const [key, value] = raw.replace(/^--/, "").split("=", 2);
    switch (key) {
      case "hits-per-page":
        args.hitsPerPage = Number(value);
        break;
      case "max-req-per-min":
        args.maxRequestsPerMinute = Number(value);
        break;
      case "out-dir":
        args.outDir = value ?? args.outDir;
        break;
      case "department":
        args.department = value;
        break;
      case "category":
        args.category = value;
        break;
      case "include-none":
        args.includeNone = true;
        break;
      case "include-outofstore":
        args.includeOutOfStore = true;
        break;
      default:
        throw new Error(`Unknown argument: --${key}`);
    }
  }
  if (
    !Number.isFinite(args.hitsPerPage) || args.hitsPerPage < 1 ||
    args.hitsPerPage > 1000
  ) {
    throw new Error(
      "--hits-per-page must be between 1 and 1000 (Algolia max is 1000)",
    );
  }
  if (
    !Number.isFinite(args.maxRequestsPerMinute) || args.maxRequestsPerMinute < 1
  ) {
    throw new Error("--max-req-per-min must be >= 1");
  }
  return args;
}

function encodeParams(params: Record<string, string | number>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    search.set(key, String(value));
  }
  return search.toString();
}

async function queryAlgolia(
  limiter: RateLimiter,
  params: Record<string, string | number>,
): Promise<AlgoliaPage> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    await limiter.acquire();
    try {
      const response = await fetch(
        `${ALGOLIA_HOST}/1/indexes/${INDEX_NAME}/query`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-algolia-application-id": ALGOLIA_APP_ID,
            "x-algolia-api-key": ALGOLIA_API_KEY,
            "X-Country": "VE",
          },
          body: JSON.stringify({ params: encodeParams(params) }),
        },
      );
      if (response.status === 429 || response.status >= 500) {
        throw new Error(`HTTP ${response.status} from Algolia`);
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }
      return (await response.json()) as AlgoliaPage;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * attempt;
        console.log(
          `  request failed (${
            error instanceof Error ? error.message : error
          }); retrying in ${delay / 1000}s`,
        );
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

function toArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function toSlimProduct(hit: ProductHit): SlimProduct {
  return {
    id: hit.id ?? hit.objectID ?? "",
    name: hit.mediaDescription ?? "",
    description: hit.largeDescription || undefined,
    brand: hit.marca ?? hit.brand,
    barcode: hit.barcode,
    departments: toArray(hit.departments),
    categories: toArray(hit.categorie),
    subCategories: toArray(hit.subCategory),
    prices: {
      full: hit.fullPrice,
      offer: hit.offerPrice || undefined,
      unit: hit.unitPrice,
      taxRate: hit.taxRate,
      taxes: hit.taxes,
      byCity: hit.fullPriceByCity,
    },
    images: hit.listUrlImages ?? (hit.mediaImageUrl ? [hit.mediaImageUrl] : []),
    status: hit.status,
    requiresPrescription: hit.requirePrescription === "true",
    outOfStore: Boolean(hit.outofstore),
    storeCountWithStock: hit.stores_with_stock?.length ?? 0,
    lastUpdate: hit.lastUpdate,
  };
}

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildFilters(args: CliArgs, department?: string): string {
  const clauses: string[] = [];
  if (department) {
    clauses.push(`departments:'${department.replace(/'/g, "\\'")}'`);
  }
  if (args.category) {
    clauses.push(`categorie:'${args.category.replace(/'/g, "\\'")}'`);
  }
  if (!args.includeOutOfStore) {
    clauses.push("outofstore:false");
  }
  return clauses.join(" AND ");
}

async function scrapeDepartment(
  limiter: RateLimiter,
  args: CliArgs,
  department: string,
): Promise<DepartmentResult> {
  const filters = buildFilters(args, department);
  const baseParams: Record<string, string | number> = {
    query: "",
    hitsPerPage: args.hitsPerPage,
    filters,
    maxValuesPerFacet: 100,
    facets: JSON.stringify(["categorie", "subCategory"]),
  };

  const firstPage = await queryAlgolia(limiter, { ...baseParams, page: 0 });
  const totalPages = firstPage.nbPages;
  const categoryCounts = firstPage.facets?.categorie ?? {};
  const subCategoryCounts = firstPage.facets?.subCategory ?? {};

  console.log(
    `[${department}] ${firstPage.nbHits} products across ${totalPages} page(s)`,
  );

  const hits: ProductHit[] = [...firstPage.hits];
  for (let page = 1; page < totalPages; page += 1) {
    const result = await queryAlgolia(limiter, { ...baseParams, page });
    hits.push(...result.hits);
    console.log(
      `[${department}] page ${
        page + 1
      }/${totalPages} fetched (${hits.length}/${firstPage.nbHits} products)`,
    );
  }

  return {
    department,
    scrapedAt: new Date().toISOString(),
    totalHits: firstPage.nbHits,
    requestsUsed: totalPages,
    categoryCounts,
    subCategoryCounts,
    products: hits.map(toSlimProduct),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const limiter = new RateLimiter(args.maxRequestsPerMinute, 60_000);
  await mkdir(args.outDir, { recursive: true });

  console.log(
    `Scraping Farmatodo VE index "${INDEX_NAME}" | hitsPerPage=${args.hitsPerPage} | max ${args.maxRequestsPerMinute} req/min`,
  );

  let departments: string[];
  if (args.department) {
    departments = [args.department];
  } else {
    const facetsPage = await queryAlgolia(limiter, {
      query: "",
      hitsPerPage: 1,
      maxValuesPerFacet: 100,
      facets: JSON.stringify(["departments"]),
    });
    departments = Object.keys(facetsPage.facets?.departments ?? {})
      .filter((d) => args.includeNone || d !== "None")
      .sort();
    console.log(
      `Found ${departments.length} departments: ${departments.join(", ")}`,
    );
  }

  const results: DepartmentResult[] = [];
  for (const department of departments) {
    results.push(await scrapeDepartment(limiter, args, department));
    const result = results[results.length - 1];
    const filePath = join(args.outDir, `products-${slugify(department)}.json`);
    await writeFile(filePath, JSON.stringify(result, null, 2), "utf8");
    console.log(
      `[${department}] saved ${result.products.length} products -> ${filePath}`,
    );
  }

  const summary = {
    index: INDEX_NAME,
    scrapedAt: new Date().toISOString(),
    totalRequests: limiter.totalRequests,
    filters: buildFilters(args) || undefined,
    departments: results.map((r) => ({
      department: r.department,
      totalHits: r.totalHits,
      productsSaved: r.products.length,
      requestsUsed: r.requestsUsed,
      categories: r.categoryCounts,
    })),
  };
  const summaryPath = join(args.outDir, "summary.json");
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(
    `Done. ${limiter.totalRequests} total requests. Summary -> ${summaryPath}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
