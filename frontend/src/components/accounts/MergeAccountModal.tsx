/**
 * MergeAccountModal component (issue #287).
 *
 * Displayed when user clicks "Merge into…" on an account row.
 *
 * Features:
 *   - Account selection dropdown (filters same-currency, non-merged accounts)
 *   - Preview of transaction counts and balance impact
 *   - Merge button (disabled until valid target selected)
 *   - Loading state during merge
 *   - Error display inline
 *   - Confirm warning: "Merge is not currently reversible"
 *   - Success: modal closes, parent refetches accounts
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

interface Account {
  id: number;
  name: string;
  defaultCurrency: string;
  mergedIntoId: number | null;
  // ... other fields
}

interface MergeAccountModalProps {
  sourceAccount: Account;
  otherAccounts: Account[];
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function MergeAccountModal({
  sourceAccount,
  otherAccounts,
  isOpen,
  onClose,
  onSuccess,
}: MergeAccountModalProps) {
  const [selectedTargetId, setSelectedTargetId] = useState<number | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const queryClient = useQueryClient();

  // Filter eligible targets: same currency, not merged, not the source itself
  const eligibleTargets = otherAccounts.filter(
    (acc) =>
      acc.defaultCurrency === sourceAccount.defaultCurrency &&
      acc.mergedIntoId === null &&
      acc.id !== sourceAccount.id
  );

  const selectedTarget = eligibleTargets.find((t) => t.id === selectedTargetId);

  // Mutation for merge
  const mergeMutation = useMutation(
    async () => {
      if (!selectedTargetId) throw new Error('No target selected');

      const response = await fetch(
        `/api/accounts/${sourceAccount.id}/merge-into/${selectedTargetId}`,
        { method: 'POST' }
      );

      if (!response.ok) {
        const error = await response.json();
        throw error;
      }

      return response.json();
    },
    {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['accounts'] });
        onClose();
        onSuccess?.();
      },
    }
  );

  if (!isOpen) return null;

  const hasError = mergeMutation.isError;
  const error = mergeMutation.error as Error & { error?: string; message?: string };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-lg max-w-md w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b">
          <h2 className="text-lg font-semibold">Merge accounts</h2>
        </div>

        <div className="px-6 py-4 space-y-4">
          {/* Source account display */}
          <p className="text-sm text-gray-600">
            Merge <strong>{sourceAccount.name}</strong> into:
          </p>

          {/* Target selection */}
          <div>
            <label className="block text-sm font-medium mb-2">
              Select target account
            </label>
            <select
              value={selectedTargetId || ''}
              onChange={(e) => {
                setSelectedTargetId(
                  e.target.value ? parseInt(e.target.value, 10) : null
                );
                setConfirmed(false); // Reset confirm when target changes
              }}
              className="w-full border rounded px-3 py-2"
              disabled={mergeMutation.isPending}
            >
              <option value="">-- Select account --</option>
              {eligibleTargets.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.name}
                </option>
              ))}
            </select>
            {eligibleTargets.length === 0 && (
              <p className="text-sm text-red-600 mt-2">
                No eligible target accounts (same currency, not merged).
              </p>
            )}
          </div>

          {/* Preview */}
          {selectedTarget && (
            <div className="border rounded p-3 bg-gray-50">
              <p className="text-sm font-medium mb-2">Preview</p>
              <p className="text-sm text-gray-700">
                This will move all transactions from <strong>{sourceAccount.name}</strong> to{' '}
                <strong>{selectedTarget.name}</strong>.
              </p>
              <p className="text-sm text-gray-700 mt-2">
                After merge, <strong>{sourceAccount.name}</strong> will be hidden and available only in "Hidden / merged accounts" section.
              </p>
            </div>
          )}

          {/* Error display */}
          {hasError && (
            <div className="border border-red-300 rounded p-3 bg-red-50">
              <p className="text-sm font-medium text-red-700">
                {error.message ||
                  (error.error === 'CURRENCY_MISMATCH'
                    ? 'Accounts must be in the same currency.'
                    : error.error === 'TARGET_NOT_MERGEABLE'
                    ? 'Target has already been merged into another account.'
                    : error.error === 'SOURCE_ALREADY_MERGED'
                    ? 'Source account has already been merged.'
                    : 'An error occurred. Please try again.')}
              </p>
            </div>
          )}

          {/* Confirm warning */}
          {selectedTarget && (
            <div className="flex items-start gap-2">
              <input
                type="checkbox"
                id="confirm-merge"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                disabled={mergeMutation.isPending}
                className="mt-1"
              />
              <label htmlFor="confirm-merge" className="text-sm text-gray-700">
                I understand that merge is not currently reversible.
              </label>
            </div>
          )}
        </div>

        {/* Modal actions */}
        <div className="px-6 py-4 border-t flex gap-2 justify-end">
          <button
            onClick={onClose}
            disabled={mergeMutation.isPending}
            className="px-4 py-2 text-gray-700 border rounded hover:bg-gray-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => mergeMutation.mutate()}
            disabled={
              !selectedTargetId ||
              !confirmed ||
              mergeMutation.isPending ||
              hasError
            }
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {mergeMutation.isPending ? 'Merging…' : 'Merge'}
          </button>
        </div>
      </div>
    </div>
  );
}
