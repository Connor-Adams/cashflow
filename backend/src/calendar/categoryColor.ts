/**
 * Type → presentational color mapping for calendar events. Exported as a
 * plain Record so the frontend can mirror the same palette without an
 * import cycle (frontend duplicates the constant — they're never out of
 * sync because the test suite asserts every type has a mapping).
 *
 * Color names are Tailwind palette keys without the shade modifier, so
 * the frontend can compose final classes (`bg-${color}-100`,
 * `text-${color}-700`, etc.) from a lookup table — JIT needs literal
 * class names, so the frontend stores fully qualified strings.
 */
import {
  PLANNED_EVENT_TYPES,
  type PlannedEventType,
} from '../models/PlannedEvent';

export const EVENT_CATEGORY_COLOR: Record<PlannedEventType, string> = {
  income: 'emerald',
  expense: 'rose',
  transfer: 'sky',
  settlement: 'amber',
  debt_payment: 'orange',
  savings: 'violet',
};

// Defense: at module load time, verify we covered every type. If a new
// type is added to PLANNED_EVENT_TYPES without updating this mapping the
// build still passes but the calendar route would silently emit
// undefined; this throws loudly instead.
for (const t of PLANNED_EVENT_TYPES) {
  if (!(t in EVENT_CATEGORY_COLOR)) {
    throw new Error(
      `categoryColor mapping missing for planned event type '${t}'`,
    );
  }
}

/**
 * Look up a color for an event type. Returns 'zinc' as a defensive
 * fallback if the type is somehow not in the mapping at runtime (should
 * be unreachable thanks to the module-load assertion above).
 */
export function categoryColorForType(type: PlannedEventType): string {
  return EVENT_CATEGORY_COLOR[type] ?? 'zinc';
}
