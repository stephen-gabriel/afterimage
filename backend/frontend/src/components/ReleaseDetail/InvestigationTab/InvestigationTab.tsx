import { useState, useEffect, useRef } from 'react';
import type { RunDetail, RunStep, Proposal } from '../../../api/types';
import { StatusMark } from '../../StatusMark/StatusMark';
import { RecordRef } from '../../RecordRef/RecordRef';
import { Button } from '../../Button/Button';
import { formatElapsed, formatTimestamp, getStatusLabel, getProposalActionLabel, getProposalExplanation } from '../../../lib/format';
import { inferRecordType, uniqueIds } from '../../../lib/recordTypes';
import { EmptyState } from '../../EmptyState/EmptyState';
import styles from './InvestigationTab.module.css';

interface InvestigationTabProps {
  run: RunDetail | null;
  loading: boolean;
  onRunAgain: () => void;
  onApplyProposal: (proposalId: string) => void;
  proposals: Proposal[];
  onOpenInspector: (type: string, id: string) => void;
}

const TOOL_LABELS: Record<string, string> = {
  get_release_context: 'Read release context',
  find_affected_releases: 'Find affected releases',
  inspect_evidence: 'Inspect evidence',
  get_decision_history: 'Read decision history',
  evaluate_release: 'Evaluate against policy',
  propose_review_action: 'Propose an action',
};

export function InvestigationTab({
  run,
  loading,
  onRunAgain,
  onApplyProposal,
  proposals,
  onOpenInspector,
}: InvestigationTabProps) {
  const [isPolling, setIsPolling] = useState(false);
  const [traceOpen, setTraceOpen] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (run && (run.status === 'QUEUED' || run.status === 'RUNNING')) {
      setIsPolling(true);
    } else {
      setIsPolling(false);
    }
  }, [run?.status]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [run?.steps.length, traceOpen]);

  const isRunning = run?.status === 'QUEUED' || run?.status === 'RUNNING';

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.runHeader}>
          <p>Loading investigation...</p>
        </div>
      </div>
    );
  }

  if (!run) {
    return (
      <div className={styles.container}>
        <EmptyState
          message="No investigation yet. Investigate to have the agent trace the affected records."
          action={<Button onClick={onRunAgain}>Investigate</Button>}
        />
      </div>
    );
  }

  const citedIds = uniqueIds(run.steps.flatMap((s: RunStep) => s.returnedEntityIds || []));
  const isTestModel = run.provider === 'TEST MODEL' || run.model === 'deterministic-v1';

  return (
    <div className={styles.container}>
      <section className={styles.runHeader} data-testid="run-header">
        <div className={styles.runStatus}>
          <StatusMark
            status={run.status}
            variant={isRunning ? 'pending' : 'current'}
            showLabel={false}
          />
          <span className={styles.statusText}>
            Investigating <span className={styles.enum}>{run.status}</span>
          </span>
          {isPolling && <span className={styles.pollingIndicator} aria-live="polite">Polling...</span>}
        </div>

        <div className={styles.runMeta}>
          <span>Started at workspace revision {run.snapshotRevision}</span>
          {run.provider && (
            <span className={isTestModel ? styles.testModelBadge : undefined}>
              {run.provider}{isTestModel ? ' (deterministic, not a live model)' : ''}
            </span>
          )}
          {run.model && <span className={styles.model}>{run.model}</span>}
          <span className={styles.elapsed}>
            {formatElapsed(run.startedAt, run.completedAt)}
          </span>
        </div>

        {run.status === 'STALE' && (
          <div className={styles.staleNotice}>
            <p>Records changed after this run started. Run the investigation again to get a proposal for the current records.</p>
            <Button onClick={onRunAgain} variant="primary" size="small">Run again</Button>
          </div>
        )}
      </section>

      <section className={styles.findings}>
        <h3 className={styles.sectionTitle}>Findings</h3>
        {run.explanation ? (
          <div className={styles.findingsText}>
            <p>{run.explanation}</p>
            {citedIds.length > 0 && (
              <div className={styles.citedIds}>
                {citedIds.map((id: string) => (
                  <RecordRef
                    key={id}
                    type={inferRecordType(id)}
                    id={id}
                    cited={true}
                    onClick={() => onOpenInspector(inferRecordType(id), id)}
                  />
                ))}
              </div>
            )}
          </div>
        ) : (
          <p className={styles.noFindings}>No findings recorded for this run.</p>
        )}
      </section>

      {run.status === 'COMPLETED' && run.proposalIds.length === 0 && (
        <div className={styles.noProposalNotice}>
          <p>{getNoProposalMessage(run.completionReason)}</p>
        </div>
      )}

      {run.status === 'FAILED' && (
        <div className={styles.failureNotice}>
          <h4>Investigation failed</h4>
          <p>{run.completionReason}</p>
          {run.explanation && <p className={styles.failureExplain}>{run.explanation}</p>}
          <Button onClick={onRunAgain} variant="primary">Run again</Button>
        </div>
      )}

      <section className={styles.proposals}>
        <h3 className={styles.sectionTitle}>Proposals</h3>
        {proposals.map((proposal) => (
          <ProposalCard
            key={proposal.id}
            proposal={proposal}
            onApply={onApplyProposal}
            onOpenInspector={onOpenInspector}
          />
        ))}
        {proposals.length === 0 && !isRunning && (
          <p className={styles.noProposals}>No proposals from this run.</p>
        )}
      </section>

      <section className={styles.activity}>
        <h3 className={styles.sectionTitle}>
          <button
            type="button"
            className={styles.traceToggle}
            onClick={() => setTraceOpen((v) => !v)}
            aria-expanded={traceOpen}
            aria-controls="tool-activity-trace"
            data-testid="trace-toggle"
          >
            Tool activity
            <span className={styles.counter}>{run.steps.length} of 8 tool calls</span>
            <span className={styles.traceChevron} aria-hidden="true">{traceOpen ? '▲' : '▼'}</span>
          </button>
        </h3>

        {traceOpen && (
          <div
            className={styles.stepList}
            id="tool-activity-trace"
            ref={logRef}
            role="log"
            aria-label="Investigation steps"
          >
            {run.steps.map((step, index) => (
              <ToolStep
                key={index}
                step={step}
                index={index}
                citedIds={citedIds}
                onOpenInspector={onOpenInspector}
              />
            ))}
            {run.steps.length === 0 && (
              <p className={styles.emptySteps}>Waiting for tool activity...</p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function ToolStep({
  step,
  index,
  citedIds,
  onOpenInspector,
}: {
  step: RunStep;
  index: number;
  citedIds: string[];
  onOpenInspector: (type: string, id: string) => void;
}) {
  const label = TOOL_LABELS[step.tool] ?? step.tool;
  const isEvaluate = step.tool === 'evaluate_release';

  return (
    <div className={styles.step} data-testid={`tool-step-${index}`}>
      <div className={styles.stepHeader}>
        <span className={styles.stepNumber}>{index + 1}</span>
        <div className={styles.stepLabels}>
          <span className={styles.stepLabel}>{label}</span>
          <code className={styles.stepRawTool}>{step.tool}</code>
          {isEvaluate && (
            <span className={styles.policyNote}>Evaluated against policy (deterministic, not the model)</span>
          )}
        </div>
        <span className={styles.stepTime}>{formatTimestamp(step.timestamp)}</span>
      </div>

      <div className={styles.stepContent}>
        <div className={styles.stepArgs}>
          <span className={styles.stepArgsLabel}>Arguments:</span>
          <code className={styles.stepArgsCode}>{JSON.stringify(step.arguments)}</code>
        </div>
        <div className={styles.stepResult}>
          <span className={styles.stepResultLabel}>Result:</span>
          <span className={styles.stepResultText}>{step.resultSummary}</span>
        </div>
        {step.returnedEntityIds.length > 0 && (
          <div className={styles.stepEntities}>
            <span className={styles.stepEntitiesLabel}>Returned IDs:</span>
            {uniqueIds(step.returnedEntityIds).map(id => (
              <RecordRef
                key={id}
                type={inferRecordType(id)}
                id={id}
                cited={citedIds.includes(id)}
                onClick={() => onOpenInspector(inferRecordType(id), id)}
              />
            ))}
          </div>
        )}
        {step.error && (
          <div className={styles.stepError}>{step.error}</div>
        )}
      </div>
    </div>
  );
}

function ProposalCard({
  proposal,
  onApply,
  onOpenInspector,
}: {
  proposal: Proposal;
  onApply: (id: string) => void;
  onOpenInspector: (type: string, id: string) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <div className={`${styles.proposalCard} ${proposal.status === 'STALE' ? styles.stale : ''}`} data-testid={`proposal-card-${proposal.id}`}>
      <div className={styles.proposalHeader}>
        <span className={styles.proposalAction}>{getProposalActionLabel(proposal.actionType)}</span>
        <span className={`${styles.proposalStatus} ${getStatusClass(proposal.status)}`}>
          {getStatusLabel(proposal.status)}
        </span>
      </div>

      <p className={styles.proposalReason}>{proposal.reason}</p>

      <div className={styles.proposalExplanation}>
        <strong>What applying does:</strong> {getProposalExplanation(proposal.actionType)}
      </div>

      <div className={styles.proposalCited}>
        <span className={styles.citedLabel}>Cited IDs:</span>
        {uniqueIds(proposal.citedIds).map(id => (
          <RecordRef
            key={id}
            type={inferRecordType(id)}
            id={id}
            cited={true}
            onClick={() => onOpenInspector(inferRecordType(id), id)}
          />
        ))}
      </div>

      <div className={styles.proposalMeta}>
        Based on workspace revision {proposal.expectedRevision}
      </div>

      {proposal.status === 'PENDING' && !confirmOpen && (
        <Button onClick={() => setConfirmOpen(true)} variant="primary" data-testid="apply-proposal">
          Apply proposal
        </Button>
      )}

      {confirmOpen && (
        <div className={styles.confirmDialog} role="dialog" aria-modal="true">
          <h4>Apply this proposal?</h4>
          <p>{getProposalActionLabel(proposal.actionType)}</p>
          <p className={styles.confirmNote}>This updates AFTERIMAGE's internal records only.</p>
          <div className={styles.confirmActions}>
            <Button
              onClick={() => { onApply(proposal.id); setConfirmOpen(false); }}
              variant="primary"
            >
              Apply
            </Button>
            <Button onClick={() => setConfirmOpen(false)} variant="secondary">
              Cancel
            </Button>
          </div>
        </div>
      )}

      {proposal.status === 'STALE' && (
        <p className={styles.staleNote}>
          Records changed after this run started. Run the investigation again to get a proposal for the current records.
        </p>
      )}
    </div>
  );
}

function getStatusClass(status: string): string {
  if (status === 'PENDING') return styles.statusPending;
  if (status === 'APPLIED') return styles.statusApplied;
  if (status === 'STALE') return styles.statusStale;
  if (status === 'REJECTED') return styles.statusRejected;
  return '';
}

function getNoProposalMessage(completionReason: string): string {
  if (completionReason === 'NO_ACTION_NEEDED') {
    return 'The run finished without proposing an action. Completion reason: NO_ACTION_NEEDED.';
  }
  if (completionReason === 'INSUFFICIENT_EVIDENCE') {
    return "The run finished without a proposal. The retrieved evidence wasn't enough to suggest an action.";
  }
  if (completionReason === 'PROPOSED_ACTIONS') {
    return 'The run reported proposals, but none are available for this snapshot.';
  }
  return `The run finished without a proposal. Completion reason: ${completionReason || 'not reported'}.`;
}