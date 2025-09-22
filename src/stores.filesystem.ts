import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  Artifact,
  DocumentType,
  ID,
  InputsUnion,
  Job,
  Link,
  Step,
  Stores,
} from './types';
import { EventHub } from './types';
import { nowIso } from './helpers';
import { emitArtifactSaved, emitLinkSaved, emitStepSaved } from './stores.base';

const cwd = (() => {
  try {
    return typeof process !== 'undefined' && typeof process.cwd === 'function' ? process.cwd() : '.';
  } catch {
    return '.';
  }
})();

const maybeDataDir = (() => {
  try {
    return typeof process !== 'undefined' ? process.env.KILN_DATA_DIR : undefined;
  } catch {
    return undefined;
  }
})();

const DEFAULT_ROOT = maybeDataDir || join(cwd, 'kiln-data');

function safeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function ensureDir(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true });
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return undefined;
    throw err;
  }
}

async function writeJson(path: string, data: any): Promise<void> {
  await ensureDir(dirname(path));
  await fs.writeFile(path, JSON.stringify(data, null, 2), 'utf8');
}

async function deletePath(path: string): Promise<void> {
  try {
    await fs.rm(path, { recursive: true, force: true });
  } catch (err: any) {
    if (err && err.code !== 'ENOENT') throw err;
  }
}

async function listJsonFiles<T>(dir: string): Promise<T[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: T[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const value = await readJson<T>(join(dir, entry.name));
      if (value) out.push(value);
    }
    return out;
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
}

async function listSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
}

function artifactDir(root: string, jobId: ID): string {
  return join(root, 'artifacts', safeName(jobId));
}

function artifactPath(root: string, jobId: ID, artifactId: ID): string {
  return join(artifactDir(root, jobId), `${safeName(artifactId)}.json`);
}

function stepDir(root: string, jobId: ID): string {
  return join(root, 'steps', safeName(jobId));
}

function stepPath(root: string, jobId: ID, key: string): string {
  return join(stepDir(root, jobId), `${safeName(key)}.json`);
}

function linkDir(root: string, jobId: ID): string {
  return join(root, 'links', safeName(jobId));
}

function linkPath(root: string, jobId: ID, linkId: ID): string {
  return join(linkDir(root, jobId), `${safeName(linkId)}.json`);
}

export async function createFilesystemStores(rootDir: string = DEFAULT_ROOT): Promise<Stores> {
  const root = rootDir;
  await ensureDir(root);
  const jobsDir = join(root, 'jobs');
  await ensureDir(jobsDir);
  const events = new EventHub();

  async function loadJob(id: ID): Promise<Job | undefined> {
    return readJson<Job>(join(jobsDir, `${safeName(id)}.json`));
  }

  async function writeJob(job: Job): Promise<void> {
    await writeJson(join(jobsDir, `${safeName(job.id)}.json`), job);
  }

  async function allJobs(): Promise<Job[]> {
    return listJsonFiles<Job>(jobsDir);
  }

  async function findArtifactById(id: ID): Promise<Artifact | undefined> {
    const jobDirs = await listSubdirs(join(root, 'artifacts'));
    for (const dir of jobDirs) {
      const fp = join(root, 'artifacts', dir, `${safeName(id)}.json`);
      const art = await readJson<Artifact>(fp);
      if (art) return art;
    }
    return undefined;
  }

  async function findLinkById(id: ID): Promise<Link | undefined> {
    const jobDirs = await listSubdirs(join(root, 'links'));
    for (const dir of jobDirs) {
      const fp = join(root, 'links', dir, `${safeName(id)}.json`);
      const link = await readJson<Link>(fp);
      if (link) return link;
    }
    return undefined;
  }

  const stores: Stores = {
    jobs: {
      async create(id: ID, title: string, type: DocumentType, inputs: InputsUnion, dependsOn: ID[] = []) {
        const existing = await loadJob(id);
        if (existing) return;
        const now = nowIso();
        const record: Job = {
          id,
          title,
          type,
          inputs,
          status: dependsOn.length ? 'blocked' : 'queued',
          dependsOn,
          lastError: null,
          cacheVersion: 0,
          createdAt: now,
          updatedAt: now,
        };
        await writeJob(record);
        events.emit({ type: 'job_created', jobId: id, title, jobType: type } as any);
      },
      async all() {
        const items = await allJobs();
        return items.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      },
      async get(id: ID) {
        return loadJob(id);
      },
      async updateStatus(id: ID, status: Job['status'], lastError?: string | null) {
        const job = await loadJob(id);
        if (!job) return;
        const prev = job.status;
        job.status = status;
        job.lastError = lastError ?? null;
        job.updatedAt = nowIso();
        await writeJob(job);
        try {
          console.log('[job.status]', { id, from: prev, to: status });
        } catch {}
        events.emit({ type: 'job_status', jobId: id, status, lastError: job.lastError } as any);
      },
      async upsert(jobRec: Job) {
        const record = { ...jobRec, updatedAt: jobRec.updatedAt || nowIso() } as Job;
        await writeJob(record);
        try {
          console.log('[job.upsert]', {
            id: record.id,
            status: record.status,
            runCount: record.runCount,
          });
        } catch {}
        events.emit({ type: 'job_status', jobId: record.id, status: record.status, lastError: record.lastError } as any);
      },
      async setDependsOn(id: ID, dependsOn: ID[]) {
        const job = await loadJob(id);
        if (!job) return;
        job.dependsOn = dependsOn || [];
        job.updatedAt = nowIso();
        await writeJob(job);
        events.emit({ type: 'job_status', jobId: id, status: job.status, lastError: job.lastError } as any);
      },
      async delete(id: ID) {
        await deletePath(join(jobsDir, `${safeName(id)}.json`));
        events.emit({ type: 'job_deleted', jobId: id } as any);
      },
      async listByDependsOn(parentId: ID) {
        const items = await allJobs();
        return items.filter((job) => Array.isArray(job.dependsOn) && job.dependsOn.includes(parentId));
      },
    },
    artifacts: {
      async get(id: ID) {
        return findArtifactById(id);
      },
      async upsert(a: Artifact) {
        const path = artifactPath(root, a.jobId, a.id);
        await writeJson(path, a);
        emitArtifactSaved(events, a);
      },
      async listByJob(jobId: ID, pred?: (a: Artifact) => boolean) {
        const list = await listJsonFiles<Artifact>(artifactDir(root, jobId));
        const sorted = list.sort((a, b) => (a.updatedAt || '').localeCompare(b.updatedAt || ''));
        return pred ? sorted.filter(pred) : sorted;
      },
      async latestVersion(jobId: ID, kind: string, tagsKey?: string, tagsValue?: any) {
        const list = await this.listByJob(jobId, (a) => a.kind === kind && (!tagsKey || a.tags?.[tagsKey] === tagsValue));
        const sorted = list.sort((a, b) => b.version - a.version);
        return sorted.length > 0 ? sorted[0].version : null;
      },
      async deleteByJob(jobId: ID) {
        await deletePath(artifactDir(root, jobId));
        events.emit({ type: 'artifacts_cleared', jobId } as any);
      },
    },
    steps: {
      async get(jobId: ID, key: string) {
        const record = await readJson<Step & { pk?: string }>(stepPath(root, jobId, key));
        if (!record) return undefined;
        const { pk: _pk, ...rest } = record;
        return rest as Step;
      },
      async put(rec: Partial<Step>) {
        if (!rec.jobId || !rec.key) throw new Error('Step record requires jobId and key');
        const path = stepPath(root, rec.jobId, rec.key);
        const existing = (await readJson<any>(path)) || {};
        const pk = `${rec.jobId}:${rec.key}`;
        const merged = { ...existing, ...rec, pk };
        await writeJson(path, merged);
        emitStepSaved(events, {
          jobId: merged.jobId,
          key: merged.key,
          status: merged.status,
          ts: merged.ts,
          title: merged.title,
          parentKey: merged.parentKey,
          tagsJson: merged.tagsJson,
          durationMs: merged.durationMs,
          llmTokens: merged.llmTokens,
          prompt: merged.prompt,
        } as any);
      },
      async listByJob(jobId: ID) {
        const list = await listJsonFiles<Step & { pk?: string }>(stepDir(root, jobId));
        return list
          .map((rec) => {
            const { pk: _pk, ...rest } = rec;
            return rest as Step;
          })
          .sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
      },
      async listRunning() {
        const jobDirs = await listSubdirs(join(root, 'steps'));
        const all: Step[] = [];
        for (const dir of jobDirs) {
          const steps = await listJsonFiles<Step & { pk?: string }>(join(root, 'steps', dir));
          for (const rec of steps) {
            const { pk: _pk, ...rest } = rec;
            all.push(rest as Step);
          }
        }
        return all
          .filter((s) => s.status === 'running' || s.status === 'pending')
          .sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
      },
      async deleteByJob(jobId: ID) {
        await deletePath(stepDir(root, jobId));
      },
    },
    links: {
      async get(id: ID) {
        return findLinkById(id);
      },
      async upsert(l: Link) {
        const dir = linkDir(root, l.jobId);
        await ensureDir(dir);
        const existing = await listJsonFiles<Link>(dir);
        const composite = `${l.jobId}-${l.fromType}-${l.fromId}-${l.toType}-${l.toId}-${l.role}`;
        for (const rec of existing) {
          const cmp = `${rec.jobId}-${rec.fromType}-${rec.fromId}-${rec.toType}-${rec.toId}-${rec.role}`;
          if (cmp === composite && rec.id !== l.id) {
            await deletePath(linkPath(root, rec.jobId, rec.id));
          }
        }
        await writeJson(linkPath(root, l.jobId, l.id), l);
        emitLinkSaved(events, l);
      },
      async listByJob(jobId: ID) {
        const list = await listJsonFiles<Link>(linkDir(root, jobId));
        return list.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
      },
      async deleteByJob(jobId: ID) {
        await deletePath(linkDir(root, jobId));
        events.emit({ type: 'links_cleared', jobId } as any);
      },
    },
    events,
  };

  return stores;
}

export const createFileStores = createFilesystemStores;
