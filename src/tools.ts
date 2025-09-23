export interface TerminologyHit {
  system: string;
  code: string;
  display: string;
  score?: number; // optional relevance score if provided by the server
}

/**
 * Searches for terminology codes using the local terminology server.
 * @param query The search query string (e.g., a clinical finding).
 * @param systems Optional array of FHIR system URLs to search within.
 * @param limit Maximum number of results to return (default 200).
 * @returns A promise that resolves to an array of terminology hits.
 */
import { getTerminologyServerURL } from './helpers';

type LocalTerminologySearch = {
  searchWithGuidance: (
    query: string,
    opts?: { systems?: string[]; limit?: number }
  ) => Promise<{
    query: string;
    hits: TerminologyHit[];
    count?: number;
    fullSystem?: boolean;
    guidance?: string;
  }>;
  normalizeSystem?: (input?: string) => string | undefined;
  getDb?: () => any;
};

let localTerminologySearch: LocalTerminologySearch | null = null;
let localTerminologyInit: Promise<LocalTerminologySearch | null> | null = null;
let localTerminologyWarningShown = false;

async function ensureLocalTerminologySearch(): Promise<LocalTerminologySearch | null> {
  if (localTerminologySearch) return localTerminologySearch;
  if (localTerminologyInit) return localTerminologyInit;
  const isNodeLike = typeof process !== 'undefined' && !!process?.versions && !!(process.versions.node || process.versions.bun);
  if (!isNodeLike) {
    localTerminologyInit = Promise.resolve(null);
    return localTerminologyInit;
  }
  localTerminologyInit = (async () => {
    try {
      const { join } = await import(`node:${'path'}`);
      const { access } = await import(`node:${'fs/promises'}`);
      const { constants } = await import(`node:${'fs'}`);
      const { fileURLToPath } = await import(`node:${'url'}`);

      const envCandidates = [
        process.env.TERMINOLOGY_DB_PATH,
        process.env.KILN_TERMINOLOGY_DB_PATH,
        process.env.KILN_TX_DB_PATH,
        process.env.PUBLIC_KILN_TERMINOLOGY_DB_PATH,
      ].filter((p): p is string => typeof p === 'string' && p.trim().length > 0);

      const cwd = (() => {
        try {
          return process.cwd();
        } catch {
          return '.';
        }
      })();

      const additionalCandidates = [
        join(cwd, 'server', 'db', 'terminology.sqlite'),
        join(cwd, 'db', 'terminology.sqlite'),
        (() => {
          try {
            const here = fileURLToPath(new URL('.', import.meta.url));
            return join(here, '..', 'server', 'db', 'terminology.sqlite');
          } catch {
            return null;
          }
        })(),
      ].filter((p): p is string => typeof p === 'string' && p.trim().length > 0);

      const candidates = [...envCandidates, ...additionalCandidates];

      let dbPath: string | null = null;
      for (const candidate of candidates) {
        try {
          await access(candidate, constants.F_OK);
          dbPath = candidate;
          break;
        } catch {}
      }

      if (!dbPath) {
        if (!localTerminologyWarningShown) {
          localTerminologyWarningShown = true;
          console.warn(
            '[terminology] No validation services URL configured and terminology.sqlite not found. Run `bun run scripts/load-terminology.ts` or set KILN_VALIDATION_URL to a running validator.'
          );
        }
        return null;
      }

      const { SqliteTerminologySearch } = await import('../server/src/services/terminology');
      localTerminologySearch = new SqliteTerminologySearch(dbPath) as LocalTerminologySearch;
      return localTerminologySearch;
    } catch (err) {
      if (!localTerminologyWarningShown) {
        localTerminologyWarningShown = true;
        console.warn('[terminology] Failed to initialize local terminology search fallback:', err);
      }
      return null;
    }
  })();
  const instance = await localTerminologyInit;
  if (!instance) localTerminologyInit = null;
  return instance;
}

export async function getLocalTerminologySearch(): Promise<LocalTerminologySearch | null> {
  return ensureLocalTerminologySearch();
}

export interface TerminologySearchResult {
  hits: TerminologyHit[];
  count?: number;
  guidance?: string;
  fullSystem?: boolean;
  perQuery?: Array<{ query: string; count: number }>;
  perQueryHits?: Array<{ query: string; hits: TerminologyHit[]; count?: number }>;
}

export async function searchTerminology(
  query: string | string[],
  systems?: string[],
  limit: number = 200
): Promise<TerminologySearchResult> {
  const TERMINOLOGY_SERVER = (getTerminologyServerURL() || '').trim();
  const queries = (Array.isArray(query) ? query : [query]).map((q) => String(q || '').trim());
  const filteredQueries = queries.filter((q) => q.length > 0);
  if (!filteredQueries.length) {
    return {
      hits: [],
      count: 0,
      fullSystem: false,
      perQuery: queries.map((q) => ({ query: q, count: 0 })),
      perQueryHits: queries.map((q) => ({ query: q, hits: [], count: 0 })),
    };
  }

  if (TERMINOLOGY_SERVER) {
    const body = JSON.stringify({ queries: filteredQueries, systems, limit });
    const response = await fetch(`${TERMINOLOGY_SERVER.replace(/\/$/, '')}/tx/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (!response.ok) {
      throw new Error(`Terminology search failed: ${response.status}`);
    }

    const data = await response.json();
    const results = (Array.isArray(data?.results) ? data.results : []) as Array<{
      query: string;
      hits: TerminologyHit[];
      count?: number;
      fullSystem?: boolean;
      guidance?: string;
    }>;
    const flatHits = results.flatMap((r) => (Array.isArray(r.hits) ? r.hits : []));
    const perQuery = filteredQueries.map((q) => {
      const match = results.find((r) => r.query === q);
      const hits = match?.hits ?? [];
      const count = Array.isArray(hits) ? hits.length : match?.count ?? 0;
      return { query: q, count };
    });
    const fullSystem = results.some((r) => !!r.fullSystem);
    const guidance = results.find((r) => typeof r.guidance === 'string' && String(r.guidance).trim())?.guidance as
      | string
      | undefined;
    return {
      hits: flatHits,
      count: flatHits.length,
      guidance,
      fullSystem,
      perQuery,
      perQueryHits: filteredQueries.map((q) => {
        const match = results.find((r) => r.query === q);
        const hits = Array.isArray(match?.hits) ? match!.hits : [];
        const count = match?.count ?? (Array.isArray(match?.hits) ? match!.hits.length : 0);
        return { query: q, hits, count };
      }),
    };
  }

  const local = await ensureLocalTerminologySearch();
  if (!local) {
    return {
      hits: [],
      count: 0,
      fullSystem: false,
      perQuery: queries.map((q) => ({ query: q, count: 0 })),
      perQueryHits: queries.map((q) => ({ query: q, hits: [], count: 0 })),
    };
  }

  const perQueryResults = await Promise.all(
    filteredQueries.map(async (q) => {
      try {
        return await local.searchWithGuidance(q, { systems, limit });
      } catch (err) {
        console.warn('[terminology] Local search failed for query', q, err);
        return { query: q, hits: [], count: 0 };
      }
    })
  );

  const aggregated = perQueryResults.map((entry) => {
    const hits = Array.isArray(entry?.hits) ? entry.hits : [];
    const count = typeof entry?.count === 'number' ? entry.count : hits.length;
    return {
      query: entry?.query ?? '',
      hits,
      count,
      fullSystem: !!entry?.fullSystem,
      guidance: entry?.guidance,
    };
  });
  const flatHits = aggregated.flatMap((r) => r.hits);
  const perQuery = aggregated.map((r) => ({ query: r.query, count: r.count }));
  const fullSystem = aggregated.some((r) => !!r.fullSystem);
  const guidance = aggregated.find((r) => typeof r.guidance === 'string' && r.guidance.trim())?.guidance;

  return {
    hits: flatHits,
    count: flatHits.length,
    guidance,
    fullSystem,
    perQuery,
    perQueryHits: aggregated.map(({ query, hits, count }) => ({ query, hits, count })),
  };
}
