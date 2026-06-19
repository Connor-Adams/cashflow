import { useMemo, useState } from 'react';
import { Button } from '@cashflow/ui';

interface KeyDef {
  key: string;
  label: string;
  inputType: 'decimal' | 'integer';
}

// Mirror of backend corp override registry (backend/src/tax/scenarios/corpOverrideKeys.ts,
// introduced in P8a T2 / commit a397ba7). Backend <-> frontend sync is manual for v1 —
// P8b will move both registries to `shared/`. When a new corp override key is added to
// the backend registry, add the matching entry here.
const KEY_DEFS: KeyDef[] = [
  { key: 'corp.activeIncome', label: 'Active business income (CAD)', inputType: 'decimal' },
  { key: 'corp.passiveInvestmentIncome', label: 'Passive investment income (CAD)', inputType: 'decimal' },
  { key: 'corp.aaiiTrailing', label: 'AAII trailing (for SBD grind)', inputType: 'decimal' },
  { key: 'corp.dividendsPaidEligible', label: 'Eligible dividends paid (CAD)', inputType: 'decimal' },
  { key: 'corp.dividendsPaidNonEligible', label: 'Non-eligible dividends paid (CAD)', inputType: 'decimal' },
  { key: 'corp.salaryPaid', label: 'Total T4 salary paid (CAD)', inputType: 'decimal' },
  { key: 'corp.openingGrip', label: 'Opening GRIP (CAD)', inputType: 'decimal' },
  { key: 'corp.openingCda', label: 'Opening CDA (CAD)', inputType: 'decimal' },
];

const INTERCORP_FIELDS = ['eligible', 'nonEligible', 'capital', 'ownershipPercent'] as const;
type IntercorpField = (typeof INTERCORP_FIELDS)[number];

const INTERCORP_FIELD_LABELS: Record<IntercorpField, string> = {
  eligible: 'Eligible dividend (CAD)',
  nonEligible: 'Non-eligible dividend (CAD)',
  capital: 'Capital dividend (CAD)',
  ownershipPercent: 'Ownership % (0..100)',
};

// Default ownership % when an intercorp distribution row is first added. 100%
// matches the most common wholly-owned holdco/opco shape; user can override.
// Engine uses this for connected-vs-portfolio Part IV split (P11b T5) and GRIP
// boost calc (P11b T6).
const DEFAULT_OWNERSHIP_PERCENT = 100;

// Matches backend `INTERCORP_RE` in backend/src/tax/scenarios/overrideKeys.ts (P11a T1, P11b T4).
// Keep these in sync — backend is the source of truth for the registry shape.
const INTERCORP_KEY_RE = /^intercorp\.(\d+)\.(eligible|nonEligible|capital|ownershipPercent)$/;

function intercorpKeyFor(receiverEntityId: number, field: IntercorpField): string {
  return `intercorp.${receiverEntityId}.${field}`;
}

export interface OtherCorpOption {
  /** Entity.id of the *other* corp (receiver candidate). */
  id: number;
  /** Display name; the user picks recipients by legal name, not id. */
  legalName: string;
}

interface Props {
  overrides: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /**
   * Other corp entities in this household that can receive intercorp dividends.
   * Caller (e.g. CorpT2Tab) computes this from `useTaxEntities()` minus the
   * currently-edited corp's own entityId. When omitted or empty, the intercorp
   * section falls back to a free-text "receiver entity id" input so the wiring
   * still lands even without plan context. The router validates membership
   * server-side and surfaces a warning if the receiver isn't in the active plan.
   */
  otherCorps?: OtherCorpOption[];
}

export function CorpOverrideEditor({ overrides, onChange, otherCorps }: Props) {
  const [pendingKey, setPendingKey] = useState<string>(KEY_DEFS[0].key);
  // Partition existing override keys into the flat KEY_DEFS list vs the dynamic
  // intercorp.<id>.<field> family so each gets its own UI section. Keys not
  // matched by either are still rendered raw in the flat list with their key as
  // the label so nothing silently disappears.
  const { flatKeys, intercorpByReceiver } = useMemo(() => {
    const flat: string[] = [];
    const byReceiver: Record<string, Partial<Record<IntercorpField, number>>> = {};
    for (const k of Object.keys(overrides)) {
      const m = k.match(INTERCORP_KEY_RE);
      if (m) {
        const receiverId = m[1];
        const field = m[2] as IntercorpField;
        const v = overrides[k];
        byReceiver[receiverId] = {
          ...(byReceiver[receiverId] ?? {}),
          [field]: typeof v === 'number' ? v : 0,
        };
      } else {
        flat.push(k);
      }
    }
    return { flatKeys: flat, intercorpByReceiver: byReceiver };
  }, [overrides]);

  const available = KEY_DEFS.filter((d) => !flatKeys.includes(d.key));

  function setValue(key: string, value: unknown) {
    onChange({ ...overrides, [key]: value });
  }
  function removeKey(key: string) {
    const next = { ...overrides };
    delete next[key];
    onChange(next);
  }
  function addKey() {
    const def = KEY_DEFS.find((d) => d.key === pendingKey);
    if (!def) return;
    setValue(def.key, 0);
  }

  function setIntercorpField(receiverId: string, field: IntercorpField, value: number) {
    const id = Number(receiverId);
    if (!Number.isInteger(id) || id <= 0) return;
    setValue(intercorpKeyFor(id, field), value);
  }
  function removeIntercorpReceiver(receiverId: string) {
    const next = { ...overrides };
    for (const field of INTERCORP_FIELDS) {
      delete next[intercorpKeyFor(Number(receiverId), field)];
    }
    onChange(next);
  }

  const presentCount = flatKeys.length + Object.keys(intercorpByReceiver).length;

  return (
    <section>
      <h3>Overrides ({presentCount})</h3>
      {presentCount === 0 ? (
        <p className="muted">No overrides — using actuals.</p>
      ) : (
        <>
          {flatKeys.length > 0 && (
            <ul>
              {flatKeys.map((k) => {
                const def = KEY_DEFS.find((d) => d.key === k);
                const v = overrides[k];
                return (
                  <li key={k} className="mb-2">
                    <strong>{def?.label ?? k}</strong>{' '}
                    <input
                      type="number"
                      step="0.01"
                      value={typeof v === 'number' ? v : 0}
                      onChange={(e) => setValue(k, Number(e.target.value))}
                    />
                    <Button variant="ghost" size="sm" onClick={() => removeKey(k)} className="ml-2">×</Button>
                  </li>
                );
              })}
            </ul>
          )}
          {Object.keys(intercorpByReceiver).length > 0 && (
            <IntercorpReceiverList
              intercorpByReceiver={intercorpByReceiver}
              otherCorps={otherCorps}
              onFieldChange={setIntercorpField}
              onRemove={removeIntercorpReceiver}
            />
          )}
        </>
      )}
      {available.length > 0 && (
        <div className="mt-2">
          <select value={pendingKey} onChange={(e) => setPendingKey(e.target.value)}>
            {available.map((d) => (
              <option key={d.key} value={d.key}>{d.label}</option>
            ))}
          </select>
          <Button variant="secondary" size="sm" onClick={addKey} className="ml-2">+ Add override</Button>
        </div>
      )}
      <IntercorpDistributionAdder
        existingReceiverIds={Object.keys(intercorpByReceiver)}
        otherCorps={otherCorps}
        onAdd={(receiverId) => {
          // Seed all 4 fields so the receiver row is fully editable on first
          // render — dividend fields default to 0, ownershipPercent defaults to
          // 100 (most-common wholly-owned case). User can change any of them.
          const next = { ...overrides };
          for (const field of INTERCORP_FIELDS) {
            next[intercorpKeyFor(receiverId, field)] =
              field === 'ownershipPercent' ? DEFAULT_OWNERSHIP_PERCENT : 0;
          }
          onChange(next);
        }}
      />
    </section>
  );
}

interface IntercorpReceiverListProps {
  intercorpByReceiver: Record<string, Partial<Record<IntercorpField, number>>>;
  otherCorps?: OtherCorpOption[];
  onFieldChange: (receiverId: string, field: IntercorpField, value: number) => void;
  onRemove: (receiverId: string) => void;
}

function IntercorpReceiverList({
  intercorpByReceiver,
  otherCorps,
  onFieldChange,
  onRemove,
}: IntercorpReceiverListProps) {
  const nameById = new Map((otherCorps ?? []).map((c) => [String(c.id), c.legalName]));
  return (
    <div className="mt-3">
      <h4 className="mb-1 mt-0">Intercorp dividend distribution</h4>
      <p className="muted mb-2">
        Dividends routed from this corp to another corp in the same household
        plan. Recipients receive Part IV tax treatment automatically; the
        household-plan compute warns if the receiver has no scenario in the
        active plan.
      </p>
      <ul>
        {Object.entries(intercorpByReceiver).map(([receiverId, fields]) => {
          const name = nameById.get(receiverId);
          const label = name ? `${name} (entity #${receiverId})` : `Entity #${receiverId}`;
          return (
            <li key={receiverId} className="mb-3">
              <div>
                <strong>→ {label}</strong>
                <Button variant="ghost" size="sm" onClick={() => onRemove(receiverId)} className="ml-2">×</Button>
              </div>
              <div className="mt-1 flex flex-wrap gap-2">
                {INTERCORP_FIELDS.map((field) => {
                  // ownershipPercent is a 0..100 integer percentage; the other
                  // 3 are CAD amounts (decimal). Distinct input props clamp the
                  // value at the UI; backend `assertNumber` only enforces
                  // finiteness, so the UI is the primary range guard for v1.
                  const isPercent = field === 'ownershipPercent';
                  const fallback = isPercent ? DEFAULT_OWNERSHIP_PERCENT : 0;
                  return (
                    <label key={field} className="flex items-center gap-1">
                      <span>{INTERCORP_FIELD_LABELS[field]}</span>
                      <input
                        type="number"
                        step={isPercent ? 1 : 0.01}
                        min={isPercent ? 0 : undefined}
                        max={isPercent ? 100 : undefined}
                        value={fields[field] ?? fallback}
                        onChange={(e) => onFieldChange(receiverId, field, Number(e.target.value))}
                      />
                    </label>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface IntercorpDistributionAdderProps {
  existingReceiverIds: string[];
  otherCorps?: OtherCorpOption[];
  onAdd: (receiverId: number) => void;
}

function IntercorpDistributionAdder({
  existingReceiverIds,
  otherCorps,
  onAdd,
}: IntercorpDistributionAdderProps) {
  const existing = new Set(existingReceiverIds);
  // Plan-context path: caller knows the household's other corps. Show a select
  // by legal name. Filter out receivers that already have a row so each receiver
  // appears at most once.
  const selectableCorps = (otherCorps ?? []).filter((c) => !existing.has(String(c.id)));
  const hasPlanContext = (otherCorps ?? []).length > 0;
  const [pendingReceiverId, setPendingReceiverId] = useState<string>('');
  const [freeTextReceiverId, setFreeTextReceiverId] = useState<string>('');

  // Seed the select default once corps load so a click-to-add doesn't no-op on
  // the empty initial value. Re-derive whenever the available list changes.
  const defaultReceiverId = selectableCorps[0]?.id ? String(selectableCorps[0].id) : '';
  const effectivePendingReceiverId = pendingReceiverId || defaultReceiverId;

  if (hasPlanContext) {
    if (selectableCorps.length === 0) {
      return (
        <p className="muted mt-2">
          All other corps in this household already have intercorp distributions.
        </p>
      );
    }
    return (
      <div className="mt-2">
        <label>
          Route dividend to:{' '}
          <select
            value={effectivePendingReceiverId}
            onChange={(e) => setPendingReceiverId(e.target.value)}
          >
            {selectableCorps.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.legalName} (entity #{c.id})
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            const id = Number(effectivePendingReceiverId);
            if (!Number.isInteger(id) || id <= 0) return;
            onAdd(id);
            // Reset to default so subsequent adds pick the next available corp.
            setPendingReceiverId('');
          }}
          className="ml-2"
        >
          + Add intercorp distribution
        </Button>
      </div>
    );
  }

  // Fallback path: no household context wired in. Users with multiple corps
  // can still set up intercorp routing by typing the receiver entity id.
  return (
    <div className="mt-2">
      <label>
        Intercorp receiver entity id:{' '}
        <input
          type="number"
          min={1}
          step={1}
          value={freeTextReceiverId}
          onChange={(e) => setFreeTextReceiverId(e.target.value)}
          placeholder="e.g. 7"
        />
      </label>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          const id = Number(freeTextReceiverId);
          if (!Number.isInteger(id) || id <= 0) return;
          if (existing.has(String(id))) return;
          onAdd(id);
          setFreeTextReceiverId('');
        }}
        className="ml-2"
      >
        + Add intercorp distribution
      </Button>
    </div>
  );
}
