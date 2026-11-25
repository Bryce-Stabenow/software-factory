import type { Plan, Request } from '../../../../packages/contracts/src/index.js';

export interface AgentAdapter {
  readonly id: string;
  health(): { available: boolean; simulation: boolean };
  plan(request: Request, feedback: string[]): Plan;
}

// Deterministic simulation: no provider, repository reads, subprocesses, or source edits.
export class FakeAgent implements AgentAdapter {
  readonly id = 'fake';
  health() { return { available: true, simulation: true }; }
  plan(request: Request, feedback: string[]): Plan {
    return {
      summary: `Proposed approach: ${request.title}`,
      assumptions: ['This is a simulated proposal for testing the workflow.', ...feedback.map(note => `Revision feedback: ${note}`)],
      questions: [],
      steps: ['Inspect the relevant source and existing conventions in a read-only planning session.', `Implement the approved scope: ${request.title}.`, 'Run configured checks and request an independent review.'],
      affectedAreas: ['To be identified by the real planner'],
      acceptanceCriteria: JSON.parse(request.acceptance_criteria_json),
      testStrategy: ['Run the project’s configured validation commands.', 'Check each acceptance criterion against the resulting diff.'],
      risks: ['No repository analysis has been performed.', 'Implementation and validation are not enabled in this milestone.'],
    };
  }
}
