/**
 * AccountsTab component for Settings (issue #287).
 *
 * Features:
 *   - List of active accounts with "Merge into…" action
 *   - Collapsible "Hidden / merged accounts" section
 *   - MergeAccountModal integration
 *   - Refetch on merge
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MergeAccountModal } from '../../../components/accounts/MergeAccountModal';

interface Account {
  id: number;
  name: string;
  accountType: string;
  defaultCurrency: string;
  owner: string;
  visibility: string;
  mergedIntoId: number | null;
  mergedAt: string | null;
  // ... other fields
}

export function AccountsTab() {
  const [showMergeModal, setShowMergeModal] = useState(false);
  const [mergeSourceId, setMergeSourceId] = useState<number | null>(null);

  // Fetch all accounts (active + merged)
  const { data: allAccounts = [], isLoading, error, refetch } = useQuery({
    queryKey: ['accounts'],
    queryFn: async () => {
      const response = await fetch('/api/accounts?includeMerged=true');
      if (!response.ok) throw new Error('Failed to fetch accounts');
      return response.json();
    },
  });

  const activeAccounts = allAccounts.filter((acc: Account) => !acc.mergedIntoId);
  const mergedAccounts = allAccounts.filter((acc: Account) => acc.mergedIntoId);

  const mergeSource = mergeSourceId
    ? allAccounts.find((a: Account) => a.id === mergeSourceId)
    : null;

  const handleMergeClick = (account: Account) => {
    setMergeSourceId(account.id);
    setShowMergeModal(true);
  };

  const handleMergeSuccess = () => {
    setShowMergeModal(false);
    setMergeSourceId(null);
    refetch();
  };

  if (isLoading) return <div className="p-4">Loading accounts…</div>;
  if (error) return <div className="p-4 text-red-600">Error loading accounts</div>;

  return (
    <div className="space-y-6 p-4">
      {/* Active accounts */}
      <div>
        <h3 className="text-lg font-semibold mb-4">Accounts</h3>
        {activeAccounts.length === 0 ? (
          <p className="text-gray-600">No accounts yet.</p>
        ) : (
          <div className="space-y-2">
            {activeAccounts.map((account: Account) => (
              <div
                key={account.id}
                className="flex items-center justify-between p-3 border rounded hover:bg-gray-50"
              >
                <div>
                  <p className="font-medium">{account.name}</p>
                  <p className="text-sm text-gray-600">
                    {account.accountType} • {account.defaultCurrency}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleMergeClick(account)}
                    className="px-3 py-1 text-sm bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
                  >
                    Merge into…
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Hidden / merged accounts */}
      {mergedAccounts.length > 0 && (
        <details className="border rounded p-3">
          <summary className="cursor-pointer font-medium text-gray-700 hover:text-gray-900">
            Hidden / merged accounts ({mergedAccounts.length})
          </summary>
          <div className="mt-3 space-y-2">
            {mergedAccounts.map((account: Account) => {
              const target = allAccounts.find(
                (a: Account) => a.id === account.mergedIntoId
              );
              return (
                <div key={account.id} className="p-3 bg-gray-50 rounded border-l-4 border-gray-300">
                  <p className="font-medium text-gray-700">{account.name}</p>
                  <p className="text-sm text-gray-600">
                    Merged into <strong>{target?.name || 'Unknown'}</strong> on{' '}
                    {new Date(account.mergedAt!).toLocaleDateString()}
                  </p>
                </div>
              );
            })}
          </div>
        </details>
      )}

      {/* Merge modal */}
      {mergeSource && (
        <MergeAccountModal
          sourceAccount={mergeSource}
          otherAccounts={activeAccounts}
          isOpen={showMergeModal}
          onClose={() => setShowMergeModal(false)}
          onSuccess={handleMergeSuccess}
        />
      )}
    </div>
  );
}
