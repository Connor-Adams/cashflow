import { AuditTokensTab } from './AuditTokensTab'
import { ReportingTokensTab } from './ReportingTokensTab'

export function ApiTokensTab() {
  return (
    <div className="flex flex-col gap-8">
      <AuditTokensTab />
      <ReportingTokensTab />
    </div>
  )
}
