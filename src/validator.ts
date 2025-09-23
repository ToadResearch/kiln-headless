import { getFhirValidatorBaseURL, sha256 } from './helpers';
import type { Context } from './types';

type LocalValidator = {
  validate: (resource: any, profile?: string) => Promise<{
    valid: boolean;
    issues: Array<{ severity: string; code?: string; details?: string; location?: string | string[] }>;
  }>;
  stop: () => void;
};

let localValidatorInstance: LocalValidator | null = null;
let localValidatorService: any = null;
let localValidatorInit: Promise<LocalValidator | null> | null = null;
let localValidatorWarned = false;

async function ensureLocalValidator(): Promise<LocalValidator | null> {
  if (localValidatorInstance) return localValidatorInstance;
  if (localValidatorInit) return localValidatorInit;
  const isNodeLike = typeof process !== 'undefined' && !!process?.versions && !!(process.versions.node || process.versions.bun);
  if (!isNodeLike) {
    localValidatorInit = Promise.resolve(null);
    return localValidatorInit;
  }

  localValidatorInit = (async () => {
    try {
      const { join } = await import(`node:${'path'}`);
      const { access } = await import(`node:${'fs/promises'}`);
      const { constants } = await import(`node:${'fs'}`);
      const { fileURLToPath } = await import(`node:${'url'}`);

      const envCandidates = [
        process.env.VALIDATOR_JAR,
        process.env.KILN_VALIDATOR_JAR,
        process.env.PUBLIC_KILN_VALIDATOR_JAR,
      ].filter((p): p is string => typeof p === 'string' && p.trim().length > 0);

      const cwd = (() => {
        try {
          return process.cwd();
        } catch {
          return '.';
        }
      })();

      const additionalCandidates = [
        join(cwd, 'server', 'validator.jar'),
        (() => {
          try {
            const here = fileURLToPath(new URL('.', import.meta.url));
            return join(here, '..', 'server', 'validator.jar');
          } catch {
            return null;
          }
        })(),
      ].filter((p): p is string => typeof p === 'string' && p.trim().length > 0);

      const candidates = [...envCandidates, ...additionalCandidates];
      let jarPath: string | null = null;
      for (const candidate of candidates) {
        try {
          await access(candidate, constants.F_OK);
          jarPath = candidate;
          break;
        } catch {}
      }

      if (!jarPath) {
        if (!localValidatorWarned) {
          localValidatorWarned = true;
          console.warn(
            '[validator] No validation services URL configured and validator.jar not found. Run `bun run server/scripts/setup.ts` or set KILN_VALIDATION_URL to a running validator.'
          );
        }
        return null;
      }

      const { ValidatorService } = await import('../server/src/services/validator');
      const heap = process.env.VALIDATOR_HEAP || process.env.KILN_VALIDATOR_HEAP || '2g';
      const service = new ValidatorService(jarPath, heap, { silent: true });
      localValidatorService = service;
      const stopService = () => {
        try {
          service.stop();
        } catch {}
      };
      try {
        const exitEvents: Array<NodeJS.Signals | 'exit'> = ['exit', 'SIGINT', 'SIGTERM'];
        for (const ev of exitEvents) {
          process.once(ev as any, stopService);
        }
      } catch {}
      localValidatorInstance = {
        async validate(resource: any, profile?: string) {
          const result = await service.validate(resource, profile);
          return {
            valid: !!result.valid,
            issues: Array.isArray(result.issues) ? result.issues : [],
          };
        },
        stop: stopService,
      };
      return localValidatorInstance;
    } catch (err) {
      if (!localValidatorWarned) {
        localValidatorWarned = true;
        console.warn('[validator] Failed to initialize local validator fallback:', err);
      }
      return null;
    }
  })();

  const instance = await localValidatorInit;
  if (!instance) localValidatorInit = null;
  return instance;
}

export function shutdownLocalValidator(): void {
  try {
    if (localValidatorInstance) localValidatorInstance.stop();
  } catch {}
  localValidatorInstance = null;
  localValidatorService = null;
  localValidatorInit = null;
}

export interface ValidationIssue {
  severity: 'error' | 'warning' | 'information';
  code?: string;
  details: string;
  location?: string; // single path string
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

// Strict client: expect normalized shape from unified server
export async function validateResource(resource: any, ctx?: Context): Promise<ValidationResult> {
  const doValidate = async (): Promise<ValidationResult> => {
    const baseRaw = (getFhirValidatorBaseURL() || '').trim();
    if (!baseRaw) {
      const local = await ensureLocalValidator();
      if (!local) {
        return { valid: true, issues: [] };
      }
      try {
        const res = await local.validate(resource);
        const issues: ValidationIssue[] = (Array.isArray(res.issues) ? res.issues : []).map((iss: any) => ({
          severity:
            String(iss?.severity || 'error').toLowerCase() === 'fatal' ?
              'error'
            : (String(iss?.severity || 'error').toLowerCase() as any),
          code: iss?.code ? String(iss.code) : 'invalid',
          details: String(iss?.details || 'Validation error'),
          location: Array.isArray(iss?.location) ? String(iss.location[0]) : String(iss?.location || ''),
        }));
        const valid = !!res.valid && issues.length === 0;
        return { valid, issues };
      } catch (err: any) {
        return {
          valid: false,
          issues: [
            {
              severity: 'error',
              code: 'exception',
              details: String(err?.message || err || 'validator error'),
              location: '',
            },
          ],
        };
      }
    }
    const base = baseRaw.replace(/\/$/, '');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const resp = await fetch(`${base}/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ resource }),
        signal: ctrl.signal as AbortSignal,
      } as RequestInit);
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        return {
          valid: false,
          issues: [
            {
              severity: 'error',
              code: 'http_error',
              details: `HTTP ${resp.status} ${resp.statusText}${text ? ` — ${text.slice(0, 200)}` : ''}`,
              location: '',
            },
          ],
        };
      }
      const data = await resp.json().catch(() => ({}));
      const rawIssues = Array.isArray(data?.issues) ? data.issues : [];
      const issues: ValidationIssue[] = rawIssues.map((iss: any) => ({
        severity:
          String(iss?.severity || 'error').toLowerCase() === 'fatal' ?
            'error'
          : (String(iss?.severity || 'error').toLowerCase() as any),
        code: iss?.code ? String(iss.code) : 'invalid',
        details: String(iss?.details || 'Validation error'),
        location: iss?.location ? String(iss.location) : '',
      }));
      const valid = Boolean(data?.valid) && issues.length === 0;
      return { valid, issues };
    } catch (e: any) {
      const isAbort = e?.name === 'AbortError';
      return {
        valid: false,
        issues: [
          {
            severity: 'error',
            code: 'network',
            details: isAbort ? 'timeout' : String(e?.message || e),
            location: '',
          },
        ],
      };
    } finally {
      clearTimeout(timer);
    }
  };

  if (!ctx) return await doValidate();

  const hash = await sha256(JSON.stringify(resource));
  const rtype = resource?.resourceType || 'resource';
  const stepKey = `validate:${rtype}:${hash.slice(0, 16)}`;
  return await ctx.step(stepKey, doValidate, {
    title: `Validate ${rtype}`,
    tags: { phase: 'validation', resourceType: rtype, inputHash: hash },
  });
}
