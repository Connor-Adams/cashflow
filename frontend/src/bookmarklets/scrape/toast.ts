type ToastKind = 'success' | 'error' | 'warn';

export function showToast(message: string, kind: ToastKind): void {
  const id = '__cashflow_capture_toast__';
  const existing = document.getElementById(id);
  if (existing) existing.remove();
  const div = document.createElement('div');
  div.id = id;
  div.textContent = message;
  div.style.cssText = [
    'position:fixed',
    'right:16px',
    'bottom:16px',
    'z-index:2147483647',
    'padding:12px 16px',
    'border-radius:8px',
    'font:14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
    'color:white',
    'box-shadow:0 4px 16px rgba(0,0,0,0.25)',
    `background:${kind === 'success' ? '#16a34a' : kind === 'warn' ? '#ca8a04' : '#dc2626'}`,
  ].join(';');
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 8000);
}
