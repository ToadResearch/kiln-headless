import type { DocumentWorkflow, NarrativeInputs, FhirInputs } from '../types';
import { registry } from './registry';
import { buildNarrativeWorkflow } from '../workflows/narrative';
import { buildFhirWorkflow } from '../workflows/fhir';

function buildNoteAndFhirWorkflow(inputs: { sketch: string }): DocumentWorkflow<NarrativeInputs> {
  return [
    ...buildNarrativeWorkflow({ sketch: inputs.sketch }),
    async (ctx) => {
      const release = await ctx.stores.artifacts.listByJob(ctx.jobId, (a) => a.kind === 'ReleaseCandidate');
      const latest = release.sort((a, b) => b.version - a.version)[0];
      if (!latest?.content) throw new Error('Finalized note not found for FHIR conversion.');
      const fhirWorkflow = buildFhirWorkflow({ noteText: latest.content as string, source: { jobId: ctx.jobId, artifactId: latest.id } } as FhirInputs);
      for (const step of fhirWorkflow) await step(ctx);
    },
  ];
}

registry.register('note_and_fhir', {
  inputsShape: { sketch: '' },
  buildWorkflow: buildNoteAndFhirWorkflow,
});
