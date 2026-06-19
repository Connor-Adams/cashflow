// Public API barrel for @cashflow/ui. Primitives are added in later tasks.
export { Button, buttonVariants, type ButtonProps } from './components/button'
export { Badge, badgeVariants } from './components/badge'
export { Card, CardHeader, CardTitle, CardDescription, CardContent } from './components/card'
export { Input } from './components/input'
export { Textarea } from './components/textarea'
export { Label } from './components/label'
export { Alert } from './components/alert'
export type { AlertVariant } from './components/alert'
export { Skeleton, SkeletonText, SkeletonRow } from './components/skeleton'
export { EmptyState, EmptyTableRow } from './components/empty-state'
export { Grid } from './components/grid'
export type { GridProps } from './components/grid'
export { NativeSelect, NativeSelectOption } from './components/native-select'
export {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from './components/table'
export { Tabs, TabPanel } from './components/tabs'
export type { TabItem } from './components/tabs'
export {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
  useConfirm,
} from './components/dialog'
