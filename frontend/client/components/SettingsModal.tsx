import { useState } from 'react';
import { api } from '../api';

interface Props {
  configured: boolean;
  onClose: () => void;
  onSaved: (configured: boolean) => void;
  onError: (msg: string) => void;
}

export function SettingsModal({ configured, onClose, onSaved, onError }: Props) {
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!value.trim()) return;
    setSaving(true);
    try {
      const r = await api.setProxy(value.trim());
      onSaved(r.proxyConfigured);
      setValue('');
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal">
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal-card" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="modal-head">
          <h3>Settings</h3>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        <label className="field-label" htmlFor="proxyInput">
          Residential proxy
        </label>
        <p className="field-hint">
          Bring your own. Format <code>host:port:user:pass</code> or{' '}
          <code>http://user:pass@host:port</code>. Stored only on this server, never logged.
        </p>
        <div className="field-row">
          <input
            id="proxyInput"
            type="text"
            spellCheck={false}
            placeholder="host:port:user:pass"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
          />
          <button className="primary-btn" onClick={save} disabled={saving || !value.trim()}>
            {saving ? <span className="spinner" /> : 'Save'}
          </button>
        </div>
        <p className="proxy-status">
          Current: <b>{configured ? 'Active' : 'Not set'}</b>
        </p>
      </div>
    </div>
  );
}
