export type CategoryErrorCode =
  | 'not_found'
  | 'parent_not_found'
  | 'cycle'
  | 'sibling_conflict'
  | 'has_children'
  | 'has_references'
  | 'invalid_name';

export class CategoryError extends Error {
  code: CategoryErrorCode;
  constructor(code: CategoryErrorCode, message: string) {
    super(message);
    this.name = 'CategoryError';
    this.code = code;
  }
}
