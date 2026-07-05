import type { Toast } from '../useToasts';

const ICON: Record<Toast['kind'], string> = { ok: '✓', err: '✕', info: 'ℹ' };

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => onDismiss(t.id)} role="status">
          <span className="t-ic">{ICON[t.kind]}</span>
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}
