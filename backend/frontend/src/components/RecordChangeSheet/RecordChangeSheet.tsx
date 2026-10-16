import { useState, useEffect, useRef } from 'react';
import { postEvent, getSources, getReleases, getRelease, RevisionStore } from '../../api/client';
import type { EventType, Source, ReleaseDetail as ReleaseDetailType } from '../../api/types';
import { ScopePanel } from '../ScopePanel/ScopePanel';
import { Button } from '../Button/Button';
import { getEventTypeLabel, getEventSubmitLabel } from '../../lib/format';
import styles from './RecordChangeSheet.module.css';

interface RecordChangeSheetProps {
  onClose: () => void;
  releaseId?: string;
}

const RELEASE_SCOPED_EVENTS: EventType[] = ['DEPENDENCY_CHANGED', 'TEST_RECORDED', 'EVIDENCE_SUPERSEDED'];

function requiresReleaseScope(type: EventType | null): boolean {
  return type !== null && RELEASE_SCOPED_EVENTS.includes(type);
}

export function RecordChangeSheet({ onClose, releaseId }: RecordChangeSheetProps) {
  const [selectedType, setSelectedType] = useState<EventType | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [releases, setReleases] = useState<Array<{ id: string; name: string }>>([]);
  const [activeReleaseId, setActiveReleaseId] = useState<string | null>(releaseId ?? null);
  const [release, setRelease] = useState<ReleaseDetailType | null>(null);
  const [expectedRevision, setExpectedRevision] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<any>(null);

  // Load scope sources, the release picker options, and capture this form's
  // expectedRevision from the revision store (REVIEW_ADDENDUM: a form captures
  // its expectedRevision when it loads the scope it is editing).
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getSources().then((res) => {
        if (!cancelled) setSources(res.data);
      }),
      getReleases().then((res) => {
        if (!cancelled) setReleases(res.data.map((r) => ({ id: r.id, name: r.name })));
      }),
    ])
      .then(() => {
        if (!cancelled) setExpectedRevision(RevisionStore.get());
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!activeReleaseId) return;
    let cancelled = false;
    getRelease(activeReleaseId)
      .then((res) => {
        if (!cancelled) setRelease(res.data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeReleaseId]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  const handleSubmit = async (payload: any, idempotencyKey: string) => {
    if (expectedRevision === null) {
      setError('The workspace revision has not loaded yet. Try again in a moment.');
      return;
    }
    if (requiresReleaseScope(selectedType) && !release) {
      setError('Select a release before recording this change.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await postEvent({
        type: selectedType!,
        payload,
        expectedRevision,
        idempotencyKey,
      });
      setSuccess(result.data);
    } catch (e: any) {
      if (e?.code === 'STALE_REVISION') {
        setError(
          `${e.message}. The workspace changed after this form loaded; close and reopen the sheet to record against the current revision.`
        );
      } else if (e?.code === 'VALIDATION_ERROR' && Array.isArray(e?.fields)) {
        const fieldList = e.fields
          .map((f: any) => `${f.path}: ${f.message}`)
          .join('; ');
        setError(`${e.message}${fieldList ? ` ${fieldList}` : ''}`);
      } else {
        setError(e?.message || 'Failed to record event');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Record a change">
      <div className={styles.sheet}>
        <div className={styles.header}>
          <h2 className={styles.title}>Record a change</h2>
          <Button onClick={onClose} variant="ghost" size="small" aria-label="Close">
            ✕
          </Button>
        </div>

        {success ? (
          <div className={styles.success}>
            <p className={styles.successMessage}>Change recorded. New workspace revision: {success.newWorkspaceRevision}.</p>
            {success.affectedReleases && success.affectedReleases.length > 0 && (
              <div className={styles.affectedReleases}>
                <h3>Affected releases:</h3>
                {success.affectedReleases.map((rel: any) => (
                  <p key={rel.releaseId}>{rel.name}: {rel.status}{rel.evaluationPending ? ' (pending)' : ''}</p>
                ))}
              </div>
            )}
            <div className={styles.successActions}>
              <Button onClick={onClose} variant="primary">Close</Button>
            </div>
          </div>
        ) : !selectedType ? (
          <div className={styles.typePicker}>
            <p className={styles.instruction}>Select the type of change to record:</p>
            <div className={styles.typeList}>
              {(['DEPENDENCY_CHANGED', 'TEST_RECORDED', 'EVIDENCE_WITHDRAWN', 'EVIDENCE_SUPERSEDED'] as EventType[]).map((type) => (
                <button
                  key={type}
                  className={styles.typeButton}
                  onClick={() => setSelectedType(type)}
                  data-testid={`event-type-${type}`}
                >
                  <span className={styles.typeLabel}>{getEventTypeLabel(type)}</span>
                  <span className={styles.typeEnum}>{type}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <EventForm
            type={selectedType}
            sources={sources}
            releases={releases}
            release={release}
            activeReleaseId={activeReleaseId}
            showReleasePicker={!releaseId}
            onReleaseSelect={setActiveReleaseId}
            onSubmit={handleSubmit}
            onBack={() => setSelectedType(null)}
            loading={loading}
            error={error}
          />
        )}
      </div>
    </div>
  );
}

function toIso(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function EventForm({
  type,
  sources,
  releases,
  release,
  activeReleaseId,
  showReleasePicker,
  onReleaseSelect,
  onSubmit,
  onBack,
  loading,
  error,
}: {
  type: EventType;
  sources: Source[];
  releases: Array<{ id: string; name: string }>;
  release: ReleaseDetailType | null;
  activeReleaseId: string | null;
  showReleasePicker: boolean;
  onReleaseSelect: (releaseId: string) => void;
  onSubmit: (payload: any, idempotencyKey: string) => void;
  onBack: () => void;
  loading: boolean;
  error: string | null;
}) {
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [selections, setSelections] = useState<Record<string, string>>({});
  // The idempotency key is bound to this exact payload: it is regenerated
  // whenever the payload changes and reused on retry of an unchanged payload.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setIdempotencyKey(crypto.randomUUID());
  }, [formData]);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const updateField = (key: string, value: string) => {
    setFormData(prev => ({ ...prev, [key]: value }));
    setSelections(prev => ({ ...prev, [key]: value }));
  };

  const selectedSource = sources.find((s) => s.id === formData.sourceId);

  const buildPayload = (): Record<string, unknown> | null => {
    switch (type) {
      case 'DEPENDENCY_CHANGED':
        return {
          releaseId: activeReleaseId,
          dependencyName: formData.dependencyName,
          newVersion: formData.newVersion,
        };
      case 'TEST_RECORDED':
        if (!release) return null;
        return {
          revisionId: release.revision.id,
          requirementId: formData.requirementId,
          sourceId: formData.sourceId,
          outcome: formData.outcome,
          observedAt: toIso(formData.observedAt),
          summary: formData.summary,
        };
      case 'EVIDENCE_WITHDRAWN':
        return {
          evidenceId: formData.evidenceId,
          sourceId: formData.sourceId,
          reason: formData.reason,
        };
      case 'EVIDENCE_SUPERSEDED':
        if (!release) return null;
        return {
          oldEvidenceId: formData.oldEvidenceId,
          replacement: {
            revisionId: release.revision.id,
            requirementId: formData.requirementId,
            sourceId: formData.sourceId,
            outcome: formData.outcome,
            observedAt: toIso(formData.observedAt),
            summary: formData.summary,
          },
        };
      default:
        return null;
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const payload = buildPayload();
    if (!payload) return;
    onSubmit(payload, idempotencyKey);
  };

  const releaseRequired = RELEASE_SCOPED_EVENTS.includes(type);
  const canSubmit = (!releaseRequired || Boolean(release)) && (!showReleasePicker || Boolean(activeReleaseId) || !releaseRequired);

  return (
    <form onSubmit={handleSubmit} className={styles.form}>
      <div className={styles.formHeader}>
        <Button onClick={onBack} variant="ghost" size="small" type="button">← Back</Button>
        <h3 className={styles.formTitle}>{getEventTypeLabel(type)}</h3>
        <code className={styles.formEnum}>{type}</code>
      </div>

      {showReleasePicker && (
        <div className={styles.field}>
          <label htmlFor="event-release">Release</label>
          <select
            id="event-release"
            value={activeReleaseId || ''}
            onChange={(e) => onReleaseSelect(e.target.value)}
            required={releaseRequired}
          >
            <option value="">Select release</option>
            {releases.map((rel) => (
              <option key={rel.id} value={rel.id}>{rel.name}</option>
            ))}
          </select>
        </div>
      )}

      <ScopePanel
        eventType={type}
        selections={selections}
        releaseName={release?.name}
        revisionNumber={release?.revision.revisionNumber}
      />

      {(type === 'TEST_RECORDED' || type === 'EVIDENCE_SUPERSEDED') && (
        <div className={styles.syntheticNotice}>
          Synthetic test evidence; no CI test is executed by AFTERIMAGE.
        </div>
      )}

      {type === 'DEPENDENCY_CHANGED' && (
        <>
          <div className={styles.field}>
            <label htmlFor="dep-name">Dependency</label>
            <select
              id="dep-name"
              value={formData.dependencyName || ''}
              onChange={(e) => updateField('dependencyName', e.target.value)}
              required
            >
              <option value="">Select dependency</option>
              {release?.dependencies.map((dep) => (
                <option key={dep.id} value={dep.dependencyName}>{dep.dependencyName}</option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor="new-version">New version</label>
            <input
              id="new-version"
              type="text"
              value={formData.newVersion || ''}
              onChange={(e) => updateField('newVersion', e.target.value)}
              required
            />
          </div>
        </>
      )}

      {type === 'TEST_RECORDED' && (
        <>
          <div className={styles.field}>
            <label htmlFor="req-id">Requirement</label>
            <select
              id="req-id"
              value={formData.requirementId || ''}
              onChange={(e) => updateField('requirementId', e.target.value)}
              required
            >
              <option value="">Select requirement</option>
              {release?.requirements.map((req) => (
                <option key={req.id} value={req.id}>{req.checkKind}</option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor="source-id">Source</label>
            <select
              id="source-id"
              value={formData.sourceId || ''}
              onChange={(e) => updateField('sourceId', e.target.value)}
              required
            >
              <option value="">Select source</option>
              {sources.map((src) => (
                <option key={src.id} value={src.id}>
                  {src.name} ({src.authority})
                </option>
              ))}
            </select>
            {selectedSource && selectedSource.authority !== 'allowlisted' && (
              <p className={styles.authorityWarning}>
                Untrusted sources are recorded, but they can't grant approval or replace allowlisted evidence.
              </p>
            )}
          </div>
          <div className={styles.field}>
            <label>Outcome</label>
            <div className={styles.segmented}>
              <label className={styles.segment}>
                <input
                  type="radio"
                  name="outcome"
                  value="PASS"
                  checked={formData.outcome === 'PASS'}
                  onChange={(e) => updateField('outcome', e.target.value)}
                />
                PASS
              </label>
              <label className={styles.segment}>
                <input
                  type="radio"
                  name="outcome"
                  value="FAIL"
                  checked={formData.outcome === 'FAIL'}
                  onChange={(e) => updateField('outcome', e.target.value)}
                />
                FAIL
              </label>
            </div>
          </div>
          <div className={styles.field}>
            <label htmlFor="observed">Observed at (UTC)</label>
            <input
              id="observed"
              type="datetime-local"
              value={formData.observedAt || ''}
              onChange={(e) => updateField('observedAt', e.target.value)}
              required
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="summary">Summary</label>
            <textarea
              id="summary"
              value={formData.summary || ''}
              onChange={(e) => updateField('summary', e.target.value)}
              required
            />
          </div>
        </>
      )}

      {type === 'EVIDENCE_WITHDRAWN' && (
        <>
          <div className={styles.field}>
            <label htmlFor="evidence-id">Evidence ID</label>
            <input
              id="evidence-id"
              type="text"
              value={formData.evidenceId || ''}
              onChange={(e) => updateField('evidenceId', e.target.value)}
              required
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="withdraw-source">Source</label>
            <select
              id="withdraw-source"
              value={formData.sourceId || ''}
              onChange={(e) => updateField('sourceId', e.target.value)}
              required
            >
              <option value="">Select source</option>
              {sources.map((src) => (
                <option key={src.id} value={src.id}>
                  {src.name} ({src.authority})
                </option>
              ))}
            </select>
            {selectedSource && selectedSource.authority !== 'allowlisted' && (
              <p className={styles.authorityWarning}>
                Untrusted sources are recorded, but they can't grant approval or replace allowlisted evidence.
              </p>
            )}
          </div>
          <div className={styles.field}>
            <label htmlFor="reason">Reason</label>
            <textarea
              id="reason"
              value={formData.reason || ''}
              onChange={(e) => updateField('reason', e.target.value)}
              required
            />
          </div>
        </>
      )}

      {type === 'EVIDENCE_SUPERSEDED' && (
        <>
          <div className={styles.field}>
            <label htmlFor="old-evidence">Evidence to supersede</label>
            <input
              id="old-evidence"
              type="text"
              value={formData.oldEvidenceId || ''}
              onChange={(e) => updateField('oldEvidenceId', e.target.value)}
              required
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="sup-req">Requirement (locked to the old record's scope)</label>
            <select
              id="sup-req"
              value={formData.requirementId || ''}
              onChange={(e) => updateField('requirementId', e.target.value)}
              required
            >
              <option value="">Select requirement</option>
              {release?.requirements.map((req) => (
                <option key={req.id} value={req.id}>{req.checkKind}</option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor="sup-source">Source</label>
            <select
              id="sup-source"
              value={formData.sourceId || ''}
              onChange={(e) => updateField('sourceId', e.target.value)}
              required
            >
              <option value="">Select source</option>
              {sources.map((src) => (
                <option key={src.id} value={src.id}>
                  {src.name} ({src.authority})
                </option>
              ))}
            </select>
            {selectedSource && selectedSource.authority !== 'allowlisted' && (
              <p className={styles.authorityWarning}>
                Untrusted sources are recorded, but they can't grant approval or replace allowlisted evidence.
              </p>
            )}
          </div>
          <div className={styles.field}>
            <label>Outcome</label>
            <div className={styles.segmented}>
              <label className={styles.segment}>
                <input
                  type="radio"
                  name="sup-outcome"
                  value="PASS"
                  checked={formData.outcome === 'PASS'}
                  onChange={(e) => updateField('outcome', e.target.value)}
                />
                PASS
              </label>
              <label className={styles.segment}>
                <input
                  type="radio"
                  name="sup-outcome"
                  value="FAIL"
                  checked={formData.outcome === 'FAIL'}
                  onChange={(e) => updateField('outcome', e.target.value)}
                />
                FAIL
              </label>
            </div>
          </div>
          <div className={styles.field}>
            <label htmlFor="sup-observed">Observed at (UTC)</label>
            <input
              id="sup-observed"
              type="datetime-local"
              value={formData.observedAt || ''}
              onChange={(e) => updateField('observedAt', e.target.value)}
              required
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="sup-summary">Summary</label>
            <textarea
              id="sup-summary"
              value={formData.summary || ''}
              onChange={(e) => updateField('summary', e.target.value)}
              required
            />
          </div>
        </>
      )}

      {error && (
        <div className={styles.error} role="alert" tabIndex={-1} ref={errorRef}>
          {error}
        </div>
      )}

      <div className={styles.formActions}>
        <Button type="submit" variant="primary" loading={loading} disabled={!canSubmit} data-testid="submit-event">
          {getEventSubmitLabel(type)}
        </Button>
        <Button onClick={onBack} variant="secondary" type="button">Cancel</Button>
      </div>
    </form>
  );
}
