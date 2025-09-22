#!/usr/bin/env bun
import '../headless/globals';
import * as fs from 'node:fs/promises';
import { join, relative } from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { createStores } from '../stores.adapter';
import { config as appConfig } from '../config';
import { createJob, startJob } from '../jobs';
import type { Artifact, ID, Job, Stores } from '../types';

// Ensure document types are registered before jobs run.
import '../documentTypes/narrative';
import '../documentTypes/fhir';
import '../documentTypes/noteAndFhir';

process.env.KILN_STORAGE_MODE = process.env.KILN_STORAGE_MODE || 'filesystem';

interface JobTracker {
  id: ID;
  title: string;
  type: string;
  status: string;
  lastError: string | null;
  steps: Map<string, { status: string; title?: string | null; phase: PhaseId; tokens?: number }>;
  updatedAt: number;
  currentStepKey?: string;
  currentStepLabel?: string;
  totalTokens?: number;
}

const trackers = new Map<ID, JobTracker>();
const completionResolvers = new Map<ID, (result: { status: string; lastError: string | null }) => void>();
const jobLayouts = new Map<ID, { layout: ExportLayout; saveIntermediate: boolean }>();
const jobArtifactsWritten = new Map<ID, {
  final: Map<string, WrittenArtifact>;
  intermediate: Map<string, WrittenArtifact>;
}>();

function safeSegment(value: string, fallback = 'artifact'): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned.slice(0, 80) : fallback;
}

function normalizeFhirNoteInput(text: string): string {
  if (/^\s*#+/m.test(text)) return text;
  const lines = text.split(/\r?\n/);
  const sections: Array<{ title: string; lines: string[] }> = [];
  const headingRegex = /^([A-Za-z][A-Za-z0-9 /,-]{1,60})\s*:\s*(.*)$/;
  let current: { title: string; lines: string[] } | null = null;

  const beginSection = (title: string) => {
    if (current && current.lines.length === 0 && sections.length > 0) {
      sections[sections.length - 1].lines.push('');
    }
    current = { title: title.trim() || 'Note', lines: [] };
    sections.push(current);
  };

  for (const raw of lines) {
    const match = headingRegex.exec(raw.trim());
    if (match) {
      beginSection(match[1]);
      const remainder = match[2];
      if (remainder) current!.lines.push(remainder.trim());
      continue;
    }
    if (!current) beginSection('Note');
    current.lines.push(raw);
  }

  if (sections.length === 0) sections.push({ title: 'Note', lines: [text] });

  return sections
    .map((section) => `## ${section.title}\n${section.lines.join('\n')}`.trim())
    .join('\n\n')
    .trim();
}

const FINAL_ARTIFACT_KINDS = new Set([
  'FhirBundle',
  'ValidationReport',
  'CodingValidationReport',
  'ReleaseCandidate',
  'FinalNote',
  'NarrativeFinal',
  'NarrativeRelease',
]);

type ArtifactClass = 'final' | 'intermediate';

type PhaseId = 'planning' | 'sections' | 'assembly' | 'note_review' | 'finalized' | 'fhir' | 'terminology' | 'other';

const PHASE_DIRS: Record<PhaseId, string> = {
  planning: 'planning',
  sections: 'sections',
  assembly: 'assembly',
  note_review: 'note_review',
  finalized: 'finalized',
  fhir: 'fhir',
  terminology: 'terminology',
  other: 'other',
};

const PHASE_LABELS: Record<PhaseId, string> = {
  planning: 'Planning',
  sections: 'Sections',
  assembly: 'Assembly',
  note_review: 'Note Review',
  finalized: 'Finalized',
  fhir: 'FHIR',
  terminology: 'Terminology',
  other: 'Other',
};

const KEYWORD_PHASES: Array<{ phase: PhaseId; keywords: string[] }> = [
  { phase: 'planning', keywords: ['plan_outline', 'planning', 'outline', 'brief'] },
  { phase: 'sections', keywords: ['sectiondraft', 'draft_section', 'critique_section', 'sections'] },
  { phase: 'assembly', keywords: ['assemble', 'assembly', 'assemble_note', 'note_draft'] },
  { phase: 'note_review', keywords: ['note_review', 'review', 'critique_note', 'note feedback'] },
  { phase: 'finalized', keywords: ['finalized', 'finalize', 'release', 'final_note', 'final'] },
  { phase: 'terminology', keywords: ['terminology', 'coding', 'codes', 'loinc', 'snomed', 'tx/', 'concept'] },
  { phase: 'fhir', keywords: ['fhir', 'bundle', 'resource', 'validate', 'refine', 'composition'] },
];

function classifyArtifact(artifact: Artifact): ArtifactClass {
  const kind = String(artifact?.kind || '');
  const tags = (artifact?.tags || {}) as Record<string, any>;
  if (FINAL_ARTIFACT_KINDS.has(kind)) return 'final';
  if (tags.final === true || tags.stage === 'release' || tags.phase === 'final') return 'final';
  if (/bundle/i.test(kind) && tags.phase === 'fhir') return 'final';
  return 'intermediate';
}

function derivePhase(tags?: Record<string, any>, fallback?: string): PhaseId {
  const raw = typeof tags?.phase === 'string' ? tags.phase.toLowerCase() : '';
  if (raw && raw in PHASE_DIRS) return raw as PhaseId;
  if (raw === 'final') return 'finalized';
  if (raw === 'terminology') return 'terminology';

  const matchKeywords = (value: string): PhaseId => {
    const lowered = value.toLowerCase();
    const byPrefix = /phase:([a-z_]+)/.exec(lowered);
    if (byPrefix) {
      const candidate = byPrefix[1];
      if (candidate in PHASE_DIRS) return candidate as PhaseId;
    }
    for (const { phase, keywords } of KEYWORD_PHASES) {
      if (keywords.some((kw) => lowered.includes(kw))) return phase;
    }
    return 'other';
  };

  const fallbackText = fallback ? fallback.toLowerCase() : '';
  if (fallbackText) {
    const phaseFromFallback = matchKeywords(fallbackText);
    if (phaseFromFallback !== 'other') return phaseFromFallback;
  }

  const stage = typeof tags?.stage === 'string' ? tags.stage : '';
  if (stage) {
    const phaseFromStage = matchKeywords(stage);
    if (phaseFromStage !== 'other') return phaseFromStage;
  }

  return 'other';
}

interface WrittenArtifact {
  absolute: string;
  relative: string;
  artifact: Artifact;
  classification: ArtifactClass;
  phase: PhaseId;
}

interface ExportLayout {
  jobRoot: string;
  metadataPath: string;
  phaseDirs: Record<PhaseId, string>;
  rel: (absolute: string) => string;
}

interface ArtifactSummary {
  path: string;
  kind: string;
  version: number;
  classification: ArtifactClass;
  phase: PhaseId;
}

interface JobMetadata {
  jobId: ID;
  type: string;
  title: string;
  status: string;
  lastError?: string | null;
  inputs: any;
  createdAt?: string;
  updatedAt?: string;
  completedAt: string;
  metrics?: {
    totalTokens?: number;
    llmInTokens?: number;
    llmOutTokens?: number;
  };
  outputs: {
    final: ArtifactSummary[];
    intermediate?: ArtifactSummary[];
  };
  config: {
    baseURL: string;
    model: string;
    temperature: number;
    llmMaxConcurrency?: number;
  };
  cli: Record<string, any>;
}

interface RunResult {
  status: string;
  lastError: string | null;
  jobId: ID;
  title: string;
  final: WrittenArtifact[];
  intermediate: WrittenArtifact[];
  metadataPath: string;
  metadata: JobMetadata;
}

interface RunJobOptions {
  buildLayout: (jobId: ID) => ExportLayout | Promise<ExportLayout>;
  saveIntermediate: boolean;
  config: ReturnType<typeof appConfig.get>;
  cliContext: Record<string, any>;
}

function ensureTracker(jobId: ID, init?: Partial<JobTracker>): JobTracker {
  const existing = trackers.get(jobId);
  if (existing) {
    existing.updatedAt = Date.now();
    if (init?.title) existing.title = init.title;
    if (init?.type) existing.type = init.type;
    if (init?.status) existing.status = init.status;
    if (init?.lastError !== undefined) existing.lastError = init.lastError;
    if (init?.currentStepLabel) existing.currentStepLabel = init.currentStepLabel;
    return existing;
  }
  const tracker: JobTracker = {
    id: jobId,
    title: init?.title || jobId,
    type: init?.type || 'job',
    status: init?.status || 'queued',
    lastError: init?.lastError ?? null,
    steps: new Map(),
    updatedAt: Date.now(),
    currentStepLabel: init?.currentStepLabel ?? init?.status ?? 'queued',
  };
  trackers.set(jobId, tracker);
  return tracker;
}

function render(): void {
  if (!output.isTTY) return;
  const sorted = Array.from(trackers.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  process.stdout.write('\x1b[2J\x1b[0f');
  const lines: string[] = ['Kiln Headless CLI', ''.padEnd(22, '=')];
  for (const job of sorted) {
    const steps = Array.from(job.steps.values());
    const done = steps.filter((s) => s.status === 'done').length;
    const failed = steps.filter((s) => s.status === 'failed').length;
    const running = steps.filter((s) => s.status === 'running').length;
    const pending = steps.filter((s) => s.status === 'pending').length;
    const total = Math.max(done + failed + running + pending, 1);
    const width = 28;
    const ratio = done / total;
    const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
    const bar = `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}]`;
    lines.push(`[${job.type.toUpperCase()}] ${job.title}`);
    const stepLabel = job.currentStepLabel ? ` | ${job.currentStepLabel}` : '';
    lines.push(`  ${bar} ${done}/${total}  running:${running}  failed:${failed}${stepLabel}`);
    const phaseTotals = new Map<PhaseId, { done: number; total: number }>();
    for (const info of steps) {
      const summary = phaseTotals.get(info.phase) || { done: 0, total: 0 };
      summary.total += 1;
      if (info.status === 'done') summary.done += 1;
      phaseTotals.set(info.phase, summary);
    }
    if (phaseTotals.size > 0) {
      const phaseParts = Array.from(phaseTotals.entries())
        .filter(([, v]) => v.total > 0)
        .map(([phase, v]) => `${PHASE_LABELS[phase]} ${v.done}/${v.total}`);
      if (phaseParts.length) lines.push(`    Phases: ${phaseParts.join('  ')}`);
    }
    if (job.totalTokens != null) lines.push(`    Tokens: ${job.totalTokens}`);
    if (job.lastError) {
      lines.push(`  last error: ${job.lastError}`);
    }
  }
  console.log(lines.join('\n'));
}

function trackEvents(stores: Stores): void {
  stores.events.subscribe((ev: any) => {
    switch (ev.type) {
      case 'job_created': {
        ensureTracker(ev.jobId, {
          title: ev.title,
          type: ev.jobType,
          status: 'queued',
          currentStepLabel: 'queued',
        });
        console.log(`Queued job ${ev.title}`);
        break;
      }
      case 'job_status': {
        const tracker = ensureTracker(ev.jobId);
        tracker.status = ev.status;
        tracker.lastError = ev.lastError ?? null;
        tracker.updatedAt = Date.now();
        if (ev.status === 'running' && !tracker.currentStepLabel) tracker.currentStepLabel = 'starting';
        if (ev.status === 'done') {
          tracker.currentStepLabel = 'done';
        } else if (ev.status === 'failed') {
          tracker.currentStepLabel = 'failed';
        }
        if (ev.status === 'done' || ev.status === 'failed') {
          const resolver = completionResolvers.get(ev.jobId);
          if (resolver) {
            completionResolvers.delete(ev.jobId);
            resolver({ status: ev.status, lastError: tracker.lastError });
          }
        }
        break;
      }
      case 'step_saved': {
        const tracker = ensureTracker(ev.jobId);
        const prev = tracker.steps.get(ev.key);
        const tags = (ev.tags || {}) as Record<string, any>;
        const phase = derivePhase(tags, `${ev.key || ''} ${ev.title || ''}`);
        const prevTokens = prev?.tokens || 0;
        let newTokens = prevTokens;
        if (typeof ev.llmTokens === 'number') {
          newTokens = ev.llmTokens;
          const existing = tracker.totalTokens || 0;
          tracker.totalTokens = existing - prevTokens + ev.llmTokens;
        }
        tracker.steps.set(ev.key, { status: ev.status, title: ev.title, phase, tokens: newTokens });
        tracker.updatedAt = Date.now();
        if (ev.status === 'running' && (!prev || prev.status !== 'running')) {
          const label = ev.title || ev.key;
          tracker.currentStepKey = ev.key;
          tracker.currentStepLabel = label;
          const message = `→ ${tracker.title}: ${label}`;
          console.log(message);
        } else if (tracker.currentStepKey === ev.key && ev.status !== 'running') {
          tracker.currentStepLabel = `${ev.status}`;
        }
        break;
      }
      case 'artifact_saved': {
        void (async () => {
          try {
            await persistArtifact(stores, ev);
          } catch (err) {
            console.error('Failed to persist artifact', err);
          }
        })();
        break;
      }
      default:
        break;
    }
    render();
  });
}

async function persistArtifact(stores: Stores, ev: any): Promise<void> {
  const layoutEntry = jobLayouts.get(ev.jobId);
  if (!layoutEntry) return;
  const { layout, saveIntermediate } = layoutEntry;
  const artifact = await stores.artifacts.get(ev.id);
  if (!artifact) return;
  const tags = (artifact.tags || {}) as Record<string, any>;
  const phase = derivePhase(tags, `${ev.phase || ''} ${ev.kind || ''}`);
  const classification = classifyArtifact(artifact);
  if (classification === 'intermediate' && !saveIntermediate) return;
  const targetDir = layout.phaseDirs[phase] || layout.phaseDirs.other;

  await fs.mkdir(targetDir, { recursive: true });
  const content = artifact.content ?? '';
  const ext = (() => {
    if (typeof content === 'string') {
      try {
        JSON.parse(content);
        return 'json';
      } catch {
        return 'txt';
      }
    }
    return 'json';
  })();
  const baseName = `${safeSegment(artifact.kind)}-v${artifact.version}-${safeSegment(artifact.id)}`;
  const filePath = join(targetDir, `${baseName}.${ext}`);
  const data = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  await fs.writeFile(filePath, data, 'utf8');
  const relPath = layout.rel(filePath).replace(/\\/g, '/');

  let record = jobArtifactsWritten.get(ev.jobId);
  if (!record) {
    record = { final: new Map(), intermediate: new Map() };
    jobArtifactsWritten.set(ev.jobId, record);
  }
  const targetMap = classification === 'final' ? record.final : record.intermediate;
  const entry: WrittenArtifact = {
    absolute: filePath,
    relative: relPath,
    artifact,
    classification,
    phase,
  };
  targetMap.set(artifact.id, entry);
  if (classification === 'final') {
    record.intermediate.delete(artifact.id);
  }

  if (classification === 'final') {
    console.log(`📄 [${PHASE_LABELS[phase]}] Final artifact saved: ${filePath}`);
  }
}

function logJobSummary(result: RunResult, saveIntermediate: boolean): void {
  if (result.status === 'done') {
    console.log(`✅ ${result.title} completed.`);
  } else {
    console.error(`❌ ${result.title} failed: ${result.lastError || 'Unknown error'}`);
  }
  const tokenTotal = result.metadata.metrics?.totalTokens;
  if (tokenTotal != null) {
    console.log(`Total LLM tokens: ${tokenTotal}`);
    const tracker = trackers.get(result.jobId);
    if (tracker) tracker.totalTokens = tokenTotal;
  }
  const summaryList = (items: WrittenArtifact[]) =>
    items.length ? items.map((f) => `  - [${PHASE_LABELS[f.phase]}] ${f.relative}`).join('\n') : '  (none)';
  console.log('Final artifacts:\n' + summaryList(result.final));
  if (saveIntermediate) console.log('Intermediate artifacts:\n' + summaryList(result.intermediate));
  console.log(`Metadata: ${result.metadataPath}`);
  render();
}

async function waitForCompletion(stores: Stores, jobId: ID): Promise<{ status: string; lastError: string | null }> {
  const current = await stores.jobs.get(jobId);
  if (current && (current.status === 'done' || current.status === 'failed')) {
    return { status: current.status, lastError: current.lastError ?? null };
  }
  return new Promise((resolve) => {
    completionResolvers.set(jobId, resolve);
  });
}

interface ParsedArgs {
  mode?: 'single' | 'batch';
  type?: 'fhir' | 'narrative' | 'note_and_fhir';
  text?: string;
  file?: string;
  dataDir?: string;
  llmUrl?: string;
  model?: string;
  temperature?: number;
  finalOnly?: boolean;
  fhirConcurrency?: number;
  llmMaxConcurrency?: number;
  help?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--single':
      case '-s':
        parsed.mode = 'single';
        break;
      case '--batch':
      case '-b':
        parsed.mode = 'batch';
        break;
      case '--type':
      case '-t':
        parsed.type = (argv[++i]?.toLowerCase() as 'fhir' | 'narrative' | 'note_and_fhir') || undefined;
        break;
      case '--text':
        parsed.text = argv[++i];
        break;
      case '--file':
      case '-f':
        parsed.file = argv[++i];
        break;
      case '--output':
      case '-o':
        parsed.dataDir = argv[++i];
        break;
      case '--llm-url':
      case '--llm':
        parsed.llmUrl = argv[++i];
        break;
      case '--model':
        parsed.model = argv[++i];
        break;
      case '--temperature':
      case '--temp':
        {
          const raw = argv[++i];
          const value = raw != null ? Number(raw) : NaN;
          if (!Number.isFinite(value)) {
            throw new Error(`Invalid temperature value: ${raw ?? ''}`);
          }
          parsed.temperature = value;
        }
        break;
      case '--fhir-concurrency':
        {
          const raw = argv[++i];
          const value = raw != null ? Number(raw) : NaN;
          if (!Number.isFinite(value) || value <= 0) {
            throw new Error(`Invalid FHIR concurrency value: ${raw ?? ''}`);
          }
          parsed.fhirConcurrency = Math.floor(value);
        }
        break;
      case '--llm-max-concurrency':
        {
          const raw = argv[++i];
          const value = raw != null ? Number(raw) : NaN;
          if (!Number.isFinite(value) || value <= 0) {
            throw new Error(`Invalid LLM max concurrency value: ${raw ?? ''}`);
          }
          parsed.llmMaxConcurrency = Math.floor(value);
        }
        break;
      case '--final-only':
      case '--no-intermediate':
        parsed.finalOnly = true;
        break;
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      default:
        break;
    }
  }
  return parsed;
}

function usage(): string {
  return `Kiln headless CLI
Usage:
  bun run headless [--single|--batch] [options]

Options:
  --single, -s            Process a single narrative (default when not specified)
  --batch, -b             Process a batch file (narratives separated by lines starting with '---')
  --type, -t <narrative|fhir|note_and_fhir>  Document type to generate (default: fhir)
  --text <value>          Narrative text to process in single mode
  --file, -f <path>       File containing batch narratives
  --output, -o <dir>      Directory for job/batch folders (default: $KILN_DATA_DIR or ./kiln-data)
  --llm-url <url>         Override PUBLIC_KILN_LLM_URL for this run (also sets KILN_BASE_URL if unset)
  --model <id>            Override PUBLIC_KILN_MODEL / KILN_MODEL
  --temperature <value>   Override PUBLIC_KILN_TEMPERATURE / KILN_TEMPERATURE
  --fhir-concurrency <n>  Override PUBLIC_KILN_FHIR_GEN_CONCURRENCY / KILN_FHIR_CONCURRENCY
  --llm-max-concurrency <n> Override PUBLIC_KILN_LLM_MAX_CONCURRENCY / KILN_LLM_MAX_CONCURRENCY
  --final-only            Save only final artifacts (skip intermediate outputs)
  --help, -h              Show this message
`;
}

async function readMultiline(rl: readline.Interface, prompt: string): Promise<string> {
  console.log(prompt);
  console.log('Finish input with a single line containing only a period (.)');
  const lines: string[] = [];
  while (true) {
    const line = await rl.question('> ');
    if (line.trim() === '.') break;
    lines.push(line);
  }
  return lines.join('\n').trim();
}

async function readBatchFile(path: string): Promise<string[]> {
  const raw = await fs.readFile(path, 'utf8');
  const entries = raw
    .split(/\n\s*---+\s*\n/g)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
  if (!entries.length) {
    throw new Error('Batch file does not contain any narratives (use --- as a separator).');
  }
  return entries;
}

async function runJob(
  stores: Stores,
  type: 'fhir' | 'narrative' | 'note_and_fhir',
  narrative: string,
  label: string,
  opts: RunJobOptions
): Promise<RunResult> {
  const trimmed = narrative.trim();
  if (!trimmed) throw new Error('Narrative text cannot be empty.');
  const baseTitle =
    type === 'fhir' ?
      `FHIR: ${label}`
    : type === 'note_and_fhir' ?
      `Note+FHIR: ${label}`
    : `Narrative: ${label}`;
  const title = baseTitle.slice(0, 120);
  const normalized = type === 'fhir' ? normalizeFhirNoteInput(trimmed) : trimmed;
  const inputs = type === 'fhir' ? { noteText: normalized } : ({ sketch: normalized } as Record<string, string>);
  const jobId = await createJob(stores, type, inputs as any, title);
  ensureTracker(jobId, { title, type });
  render();

  const layout = await opts.buildLayout(jobId);
  await fs.mkdir(layout.jobRoot, { recursive: true });
  for (const dir of Object.values(layout.phaseDirs)) {
    await fs.mkdir(dir, { recursive: true });
  }
  jobLayouts.set(jobId, { layout, saveIntermediate: opts.saveIntermediate });
  jobArtifactsWritten.set(jobId, { final: new Map(), intermediate: new Map() });

  try {
    await startJob(stores, jobId);
    const result = await waitForCompletion(stores, jobId);
    const jobRecord: Job | undefined = await stores.jobs.get(jobId);
    const completedAt = new Date().toISOString();

    const record = jobArtifactsWritten.get(jobId);
    const finalArtifacts = record ? Array.from(record.final.values()) : [];
    const intermediateArtifacts = record ? Array.from(record.intermediate.values()) : [];

    let totalTokens = 0;
    try {
      const steps = await stores.steps.listByJob(jobId);
      for (const step of steps) totalTokens += Number(step.llmTokens || 0);
    } catch {}

    const outputs: JobMetadata['outputs'] = {
      final: finalArtifacts.map(({ relative, artifact, classification, phase }) => ({
        path: relative,
        kind: artifact.kind,
        version: artifact.version,
        classification,
        phase,
      })),
    };
    if (opts.saveIntermediate && intermediateArtifacts.length > 0) {
      outputs.intermediate = intermediateArtifacts.map(({ relative, artifact, classification, phase }) => ({
        path: relative,
        kind: artifact.kind,
        version: artifact.version,
        classification,
        phase,
      }));
    }

    const metadata: JobMetadata = {
      jobId,
      type,
      title,
      status: jobRecord?.status ?? result.status,
      lastError: jobRecord?.lastError ?? result.lastError,
      inputs: jobRecord?.inputs ?? inputs,
      createdAt: jobRecord?.createdAt,
      updatedAt: jobRecord?.updatedAt,
      completedAt,
      metrics: {
        totalTokens,
      },
      outputs,
      config: {
        baseURL: opts.config.baseURL,
        model: opts.config.model,
        temperature: opts.config.temperature,
        llmMaxConcurrency: opts.config.llmMaxConcurrency,
      },
      cli: {
        ...opts.cliContext,
        label,
      },
    };

    await fs.writeFile(layout.metadataPath, JSON.stringify(metadata, null, 2), 'utf8');

    const tracker = trackers.get(jobId);
    if (tracker) tracker.totalTokens = totalTokens;

    render();

    return {
      status: result.status,
      lastError: result.lastError,
      jobId,
      title,
      final: finalArtifacts,
      intermediate: intermediateArtifacts,
      metadataPath: layout.metadataPath,
      metadata,
    };
  } finally {
    jobLayouts.delete(jobId);
    jobArtifactsWritten.delete(jobId);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const rl = readline.createInterface({ input, output });
  try {
    if (!args.mode) {
      const answer = (await rl.question('Select mode ([1] single, [2] batch): ')).trim();
      args.mode = answer === '2' ? 'batch' : 'single';
    }
    if (!args.type) {
      const answer = (await rl.question('Generate which document type? ([1] fhir, [2] narrative, [3] note_and_fhir): ')).trim();
      args.type = answer === '2' ? 'narrative' : answer === '3' ? 'note_and_fhir' : 'fhir';
    }
    if (args.mode === 'single' && !args.text) {
      args.text = await readMultiline(rl, 'Enter the clinical narrative to process.');
    }
    if (args.mode === 'batch' && !args.file) {
      args.file = (await rl.question('Enter the path to the batch file: ')).trim();
    }
  } finally {
    rl.close();
  }

  args.mode = args.mode || 'single';
  const saveIntermediate = !args.finalOnly;

  const dataRoot = args.dataDir || process.env.KILN_DATA_DIR || join(process.cwd(), '.kiln-data');
  process.env.KILN_DATA_DIR = dataRoot;

  if (args.llmUrl) {
    process.env.PUBLIC_KILN_LLM_URL = args.llmUrl;
    if (!process.env.KILN_BASE_URL) process.env.KILN_BASE_URL = args.llmUrl;
  }
  if (args.model) {
    process.env.PUBLIC_KILN_MODEL = args.model;
    process.env.KILN_MODEL = args.model;
  }
  if (typeof args.temperature === 'number') {
    const t = String(args.temperature);
    process.env.PUBLIC_KILN_TEMPERATURE = t;
    process.env.KILN_TEMPERATURE = t;
  }
  if (typeof args.fhirConcurrency === 'number') {
    const v = String(args.fhirConcurrency);
    process.env.PUBLIC_KILN_FHIR_GEN_CONCURRENCY = v;
    process.env.KILN_FHIR_CONCURRENCY = v;
  }
  if (typeof args.llmMaxConcurrency === 'number') {
    const v = String(args.llmMaxConcurrency);
    process.env.PUBLIC_KILN_LLM_MAX_CONCURRENCY = v;
    process.env.KILN_LLM_MAX_CONCURRENCY = v;
  }

  await fs.mkdir(dataRoot, { recursive: true });
  await fs.mkdir(join(dataRoot, 'jobs'), { recursive: true });
  await fs.mkdir(join(dataRoot, 'batches'), { recursive: true });

  await appConfig.init();
  const cfg = appConfig.get();

  const stores = await createStores();
  trackEvents(stores);
  render();

  const cliBase = {
    mode: args.mode,
    type: args.type || 'fhir',
    finalOnly: !saveIntermediate,
    llmUrlOverride: args.llmUrl ?? null,
    temperatureOverride: args.temperature ?? null,
    modelOverride: args.model ?? null,
    dataRoot,
  };

  if (args.mode === 'batch') {
    if (!args.file) throw new Error('Batch mode requires a --file path.');
    const narratives = await readBatchFile(args.file);
    console.log(`Processing ${narratives.length} narratives from ${args.file}...`);

    const batchId = `batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const batchRoot = join(dataRoot, 'batches', batchId);
    await fs.mkdir(batchRoot, { recursive: true });

    const batchContext = { ...cliBase, batchId, sourceFile: args.file };
    const results: Array<{ result?: RunResult; error?: any; label: string }> = [];

    const layoutBuilder = (jobId: ID): ExportLayout => {
      const jobFolder = safeSegment(jobId);
      const jobRoot = join(batchRoot, 'jobs', jobFolder);
      const metadataPath = join(jobRoot, 'metadata.json');
      const phaseDirs: Record<PhaseId, string> = {
        planning: join(jobRoot, PHASE_DIRS.planning),
        sections: join(jobRoot, PHASE_DIRS.sections),
        assembly: join(jobRoot, PHASE_DIRS.assembly),
        note_review: join(jobRoot, PHASE_DIRS.note_review),
        finalized: join(jobRoot, PHASE_DIRS.finalized),
        fhir: join(jobRoot, PHASE_DIRS.fhir),
        terminology: join(jobRoot, PHASE_DIRS.terminology),
        other: join(jobRoot, PHASE_DIRS.other),
      };
      return {
        jobRoot,
        metadataPath,
        phaseDirs,
        rel: (abs: string) => relative(jobRoot, abs),
      };
    };

    for (let i = 0; i < narratives.length; i++) {
      const raw = narratives[i];
      const label = `${safeSegment(raw.slice(0, 40) || `item-${i + 1}`)} (${i + 1}/${narratives.length})`;
      try {
        const result = await runJob(stores, args.type || 'fhir', raw, label, {
          buildLayout: layoutBuilder,
          saveIntermediate,
          config: cfg,
          cliContext: { ...batchContext, itemIndex: i + 1 },
        });
        results.push({ result, label });
        logJobSummary(result, saveIntermediate);
      } catch (err: any) {
        results.push({ error: err, label });
        console.error(`❌ Failed to process batch item ${i + 1}: ${err?.message || err}`);
      }
    }

    const toBatchRelative = (absPath: string) => relative(batchRoot, absPath).replace(/\\/g, '/');

    const batchMetadata = {
      batchId,
      createdAt: new Date().toISOString(),
      sourceFile: args.file,
      narrativeCount: narratives.length,
      config: {
        baseURL: cfg.baseURL,
        model: cfg.model,
        temperature: cfg.temperature,
        llmMaxConcurrency: cfg.llmMaxConcurrency,
      },
      cli: batchContext,
      jobs: results.map((entry, idx) => {
        if (entry.result) {
          const res = entry.result;
          return {
            index: idx + 1,
            jobId: res.jobId,
            title: res.title,
            status: res.metadata.status,
            lastError: res.metadata.lastError,
            finalOutputs: res.final.map((f) => toBatchRelative(f.absolute)),
            intermediateOutputs: saveIntermediate ? res.intermediate.map((f) => toBatchRelative(f.absolute)) : undefined,
            metadata: toBatchRelative(res.metadataPath),
          };
        }
        return {
          index: idx + 1,
          label: entry.label,
          status: 'error',
          error: String(entry.error?.message || entry.error || 'Unknown error'),
        };
      }),
    };

    const batchMetadataPath = join(batchRoot, 'metadata.json');
    await fs.writeFile(batchMetadataPath, JSON.stringify(batchMetadata, null, 2), 'utf8');
    console.log(`Batch metadata written to ${batchMetadataPath}`);
  } else {
    const narrative = args.text ?? '';
    const label = safeSegment(narrative.slice(0, 40) || 'single');
    const layoutBuilder = (jobId: ID): ExportLayout => {
      const folder = safeSegment(jobId);
      const jobRoot = join(dataRoot, 'jobs', folder);
      const metadataPath = join(jobRoot, 'metadata.json');
      const phaseDirs: Record<PhaseId, string> = {
        planning: join(jobRoot, PHASE_DIRS.planning),
        sections: join(jobRoot, PHASE_DIRS.sections),
        assembly: join(jobRoot, PHASE_DIRS.assembly),
        note_review: join(jobRoot, PHASE_DIRS.note_review),
        finalized: join(jobRoot, PHASE_DIRS.finalized),
        fhir: join(jobRoot, PHASE_DIRS.fhir),
        terminology: join(jobRoot, PHASE_DIRS.terminology),
        other: join(jobRoot, PHASE_DIRS.other),
      };
      return {
        jobRoot,
        metadataPath,
        phaseDirs,
        rel: (abs: string) => relative(jobRoot, abs),
      };
    };

    const result = await runJob(stores, args.type || 'fhir', narrative, label, {
      buildLayout: layoutBuilder,
      saveIntermediate,
      config: cfg,
      cliContext: cliBase,
    });

    logJobSummary(result, saveIntermediate);
  }
}

main().catch((err) => {
  console.error('Headless CLI failed:', err);
  process.exitCode = 1;
});
