/**
 * First-run install setup screen.
 *
 * Rendered by BootstrapSplash while the Rust side is parked in the
 * `awaiting_setup` stage — nothing has been downloaded or installed yet.
 * The user picks install mode (installed/portable), storage locations,
 * compute variant, network mirrors and update channel; every chosen
 * directory is live-checked for free space against the minimum the install
 * needs (Rust re-validates on submit — the UI gate is a mirror, not the
 * authority). "Start installation" is the only thing that kicks off the
 * bootstrap.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n, { LANGUAGES } from '../i18n';
import { useAppStore } from '../store';
import './FirstRunSetup.css';

const APP_VERSION = __APP_VERSION__ || '0.0.0';
const GIB = 1024 * 1024 * 1024;

const fmtGB = (bytes) =>
  bytes == null ? '—' : `${(bytes / GIB).toFixed(bytes < 10 * GIB ? 1 : 0)} GB`;

const invoke = async (...args) => {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
  return tauriInvoke(...args);
};

/** Debounced live probe of one install target (free space / writability). */
function useTargetCheck(path) {
  const [check, setCheck] = useState(null);
  useEffect(() => {
    if (!path) { setCheck(null); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await invoke('check_install_target', { path });
        if (!cancelled) setCheck(res);
      } catch { if (!cancelled) setCheck(null); }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [path]);
  return check;
}

/** One storage location row: label, path, Change… picker, space status. */
function StorageRow({ label, desc, path, need, check, onPick, disabled }) {
  const { t } = useTranslation();
  const lowSpace = check?.freeBytes != null && check.freeBytes < need;
  const notWritable = check && !check.writable;
  return (
    <div className={`frs-row ${lowSpace || notWritable ? 'frs-row--blocked' : ''}`}>
      <div className="frs-row__text">
        <span className="frs-row__label">{label}</span>
        <span className="frs-row__desc">{desc}</span>
        <code className="frs-row__path" title={path}>{path}</code>
      </div>
      <div className="frs-row__meta">
        <span className="frs-row__need">{t('firstrun.needs', { size: fmtGB(need), defaultValue: 'needs ~{{size}}' })}</span>
        <span className={`frs-row__free ${lowSpace ? 'is-low' : ''}`}>
          {check == null
            ? t('firstrun.checking', 'checking…')
            : notWritable
              ? t('firstrun.not_writable', 'not writable')
              : t('firstrun.free', { size: fmtGB(check.freeBytes), defaultValue: '{{size}} free' })}
        </span>
        {onPick && (
          <button type="button" className="frs-btn frs-btn--ghost" onClick={onPick} disabled={disabled}>
            {t('firstrun.change', 'Change…')}
          </button>
        )}
      </div>
    </div>
  );
}

export default function FirstRunSetup() {
  const { t } = useTranslation();
  const locale = useAppStore((s) => s.locale);
  const setLocale = useAppStore((s) => s.setLocale);

  const [setup, setSetup] = useState(null);   // get_setup_state payload
  const [plan, setPlan] = useState(null);     // user's editable choices
  const [mirrorsOpen, setMirrorsOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    (async () => {
      try {
        const s = await invoke('get_setup_state');
        if (!mounted.current) return;
        setSetup(s);
        setPlan({
          installMode: s.portable.available && s.defaults.installMode === 'portable' ? 'portable' : 'installed',
          envDir: s.defaults.envDir,
          dataDir: s.defaults.dataDir,
          modelsDir: s.defaults.modelsDir,
          region: s.defaults.region,
          updateChannel: s.defaults.updateChannel,
          torchVariant: s.defaults.torchVariant,
          mirrors: { pypiIndex: '', hfEndpoint: '', pythonDownloads: '' },
        });
      } catch (e) {
        if (mounted.current) setServerError(String(e));
      }
    })();
  }, []);

  const portable = plan?.installMode === 'portable';
  const req = setup?.requirements;
  const combinedNeed = req ? req.envBytes + req.modelsBytes + req.dataBytes : 0;

  // Live target probes — in portable mode only the anchor folder matters.
  const portableBase = setup?.portable?.baseDir || '';
  const envCheck = useTargetCheck(portable ? null : plan?.envDir);
  const dataCheck = useTargetCheck(portable ? null : plan?.dataDir);
  const modelsCheck = useTargetCheck(portable ? null : plan?.modelsDir);
  const portableCheck = useTargetCheck(portable ? portableBase : null);

  // Mirror of the Rust gate: group targets by filesystem, sum requirements,
  // block when any volume falls short or isn't writable.
  const blockers = useMemo(() => {
    if (!plan || !req) return [{ key: 'loading' }];
    const targets = portable
      ? [{ check: portableCheck, need: combinedNeed, label: portableBase }]
      : [
          { check: envCheck, need: req.envBytes, label: plan.envDir },
          { check: dataCheck, need: req.dataBytes, label: plan.dataDir },
          { check: modelsCheck, need: req.modelsBytes, label: plan.modelsDir },
        ];
    if (targets.some((x) => x.check == null)) return [{ key: 'loading' }];
    const out = [];
    for (const { check, label } of targets) {
      if (!check.writable) out.push({ key: 'not_writable', label });
    }
    const byFs = new Map();
    for (const { check, need } of targets) {
      const k = check.fsKey || check.path;
      const cur = byFs.get(k) || { need: 0, free: check.freeBytes };
      cur.need += need;
      cur.free = Math.min(cur.free ?? Infinity, check.freeBytes ?? Infinity);
      byFs.set(k, cur);
    }
    for (const { need, free } of byFs.values()) {
      if (free != null && free < need) out.push({ key: 'space', need, free });
    }
    return out;
  }, [plan, req, portable, portableBase, combinedNeed, envCheck, dataCheck, modelsCheck, portableCheck]);

  const pickDir = useCallback(async (field) => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const dir = await open({ directory: true, defaultPath: plan?.[field] || undefined });
      if (typeof dir === 'string' && dir) setPlan((p) => ({ ...p, [field]: dir }));
    } catch (e) { console.error('folder pick failed', e); }
  }, [plan]);

  const set = useCallback((patch) => setPlan((p) => ({ ...p, ...patch })), []);

  const start = useCallback(async () => {
    if (!plan || submitting) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const clean = (s) => (s && s.trim() ? s.trim() : null);
      await invoke('complete_setup', {
        plan: {
          installMode: plan.installMode,
          envDir: clean(plan.envDir),
          dataDir: clean(plan.dataDir),
          modelsDir: clean(plan.modelsDir),
          region: plan.region,
          locale,
          updateChannel: plan.updateChannel,
          torchVariant: plan.torchVariant,
          mirrors: {
            pypiIndex: clean(plan.mirrors.pypiIndex),
            hfEndpoint: clean(plan.mirrors.hfEndpoint),
            pythonDownloads: clean(plan.mirrors.pythonDownloads),
          },
        },
      });
      // Success: the stage poll in App.jsx leaves `awaiting_setup` and the
      // normal bootstrap progress UI takes over. Nothing to do here.
    } catch (e) {
      if (mounted.current) { setServerError(String(e)); setSubmitting(false); }
    }
  }, [plan, submitting, locale]);

  if (!setup || !plan) {
    return (
      <div className="frs">
        <div className="frs__card frs__card--loading">
          {serverError
            ? <pre className="frs__error">{serverError}</pre>
            : t('firstrun.loading', 'Preparing setup…')}
        </div>
      </div>
    );
  }

  const blocked = blockers.length > 0;
  const spaceBlocker = blockers.find((b) => b.key === 'space');

  return (
    <div className="frs">
      <div className="frs__card">
        {/* Header: identity + language first so the rest re-renders translated */}
        <header className="frs__head">
          <div>
            <h1 className="frs__title">{t('firstrun.title', 'Set up OmniVoice Studio')}</h1>
            <p className="frs__subtitle">
              {t('firstrun.subtitle', 'Nothing is installed yet — review where everything goes, then start. You can change these later in Settings.')}
            </p>
          </div>
          <div className="frs__head-meta">
            <span className="frs__version">v{APP_VERSION}</span>
            <select
              className="frs-select"
              value={locale}
              onChange={(e) => { setLocale(e.target.value); i18n.changeLanguage(e.target.value); }}
              aria-label={t('firstrun.language', 'Language')}
            >
              {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
          </div>
        </header>

        {/* Install mode */}
        <section className="frs__section">
          <h2 className="frs__section-title">{t('firstrun.mode_title', 'Install mode')}</h2>
          <div className="frs__modes" role="radiogroup">
            <button
              type="button"
              role="radio"
              aria-checked={!portable}
              className={`frs-mode ${!portable ? 'is-active' : ''}`}
              onClick={() => set({ installMode: 'installed' })}
            >
              <span className="frs-mode__name">{t('firstrun.mode_installed', 'Installed')}</span>
              <span className="frs-mode__desc">{t('firstrun.mode_installed_desc', 'Uses standard system folders. Recommended for most users.')}</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={portable}
              className={`frs-mode ${portable ? 'is-active' : ''}`}
              disabled={!setup.portable.available}
              onClick={() => setup.portable.available && set({ installMode: 'portable' })}
            >
              <span className="frs-mode__name">{t('firstrun.mode_portable', 'Portable')}</span>
              <span className="frs-mode__desc">
                {setup.portable.available
                  ? t('firstrun.mode_portable_desc', 'Everything lives in one folder next to the app — move it to another disk or machine as a unit.')
                  : t('firstrun.mode_portable_unavailable', 'Unavailable: the folder next to the app is not writable.')}
              </span>
            </button>
          </div>
        </section>

        {/* Storage + space gate */}
        <section className="frs__section">
          <h2 className="frs__section-title">{t('firstrun.storage_title', 'Storage')}</h2>
          {portable ? (
            <StorageRow
              label={t('firstrun.portable_folder', 'Portable folder')}
              desc={t('firstrun.portable_folder_desc', 'App environment, models, and your voice data — one folder, fully movable.')}
              path={portableBase}
              need={combinedNeed}
              check={portableCheck}
            />
          ) : (
            <>
              <StorageRow
                label={t('firstrun.env_dir', 'App environment')}
                desc={t('firstrun.env_dir_desc', 'Python runtime and AI libraries.')}
                path={plan.envDir}
                need={req.envBytes}
                check={envCheck}
                onPick={() => pickDir('envDir')}
              />
              <StorageRow
                label={t('firstrun.data_dir', 'Voice data & projects')}
                desc={t('firstrun.data_dir_desc', 'Your voices, dubs, outputs and project database.')}
                path={plan.dataDir}
                need={req.dataBytes}
                check={dataCheck}
                onPick={() => pickDir('dataDir')}
              />
              <StorageRow
                label={t('firstrun.models_dir', 'Model cache')}
                desc={t('firstrun.models_dir_desc', 'Downloaded AI models — the largest and most relocatable part.')}
                path={plan.modelsDir}
                need={req.modelsBytes}
                check={modelsCheck}
                onPick={() => pickDir('modelsDir')}
              />
            </>
          )}
        </section>

        {/* Compute */}
        <section className="frs__section">
          <h2 className="frs__section-title">{t('firstrun.compute_title', 'Compute')}</h2>
          <div className="frs__inline-fields">
            <label className="frs-field">
              <span>{t('firstrun.compute_label', 'GPU / accelerator')}</span>
              <select
                className="frs-select"
                value={plan.torchVariant}
                onChange={(e) => set({ torchVariant: e.target.value })}
              >
                <option value="auto">{t('firstrun.compute_auto', 'Auto (NVIDIA CUDA / Apple MPS / CPU)')}</option>
                <option value="rocm">{t('firstrun.compute_rocm', 'AMD GPU (ROCm, Linux)')}</option>
              </select>
            </label>
            <label className="frs-field">
              <span>{t('firstrun.channel_label', 'Update channel')}</span>
              <select
                className="frs-select"
                value={plan.updateChannel}
                onChange={(e) => set({ updateChannel: e.target.value })}
              >
                <option value="stable">{t('firstrun.channel_stable', 'Stable')}</option>
                <option value="preview">{t('firstrun.channel_preview', 'Preview (latest main)')}</option>
              </select>
            </label>
          </div>
        </section>

        {/* Network */}
        <section className="frs__section">
          <h2 className="frs__section-title">{t('firstrun.network_title', 'Network')}</h2>
          <div className="frs__inline-fields">
            <label className="frs-field">
              <span>{t('firstrun.region_label', 'Download region')}</span>
              <select
                className="frs-select"
                value={plan.region}
                onChange={(e) => set({ region: e.target.value })}
              >
                <option value="auto">🌐 {t('bootstrap.auto_detect', 'Auto-detect')}</option>
                <option value="global">🌐 {t('bootstrap.region_global', 'Global (direct)')}</option>
                <option value="china">🇨🇳 {t('bootstrap.region_china', 'China (mirror)')}</option>
                <option value="russia">🇷🇺 {t('bootstrap.region_russia', 'Russia (mirror)')}</option>
                <option value="restricted">🌍 {t('bootstrap.region_restricted', 'Restricted (mirror)')}</option>
              </select>
            </label>
          </div>
          <details className="frs__advanced" open={mirrorsOpen} onToggle={(e) => setMirrorsOpen(e.target.open)}>
            <summary>{t('firstrun.mirrors_title', 'Custom mirrors (advanced)')}</summary>
            <div className="frs__mirror-fields">
              {[
                ['pypiIndex', t('firstrun.mirror_pypi', 'PyPI index URL'), 'https://mirrors.aliyun.com/pypi/simple/'],
                ['hfEndpoint', t('firstrun.mirror_hf', 'Hugging Face endpoint'), 'https://hf-mirror.com'],
                ['pythonDownloads', t('firstrun.mirror_python', 'Python downloads mirror'), 'https://gh-proxy.com/…'],
              ].map(([field, label, ph]) => (
                <label key={field} className="frs-field">
                  <span>{label}</span>
                  <input
                    className="frs-input"
                    type="url"
                    placeholder={ph}
                    value={plan.mirrors[field]}
                    onChange={(e) => set({ mirrors: { ...plan.mirrors, [field]: e.target.value } })}
                  />
                </label>
              ))}
            </div>
          </details>
        </section>

        {/* Footer: gate + start */}
        <footer className="frs__foot">
          {serverError && <pre className="frs__error">{serverError}</pre>}
          {spaceBlocker && (
            <p className="frs__blocker">
              ⚠ {t('firstrun.insufficient_space', {
                need: fmtGB(spaceBlocker.need),
                free: fmtGB(spaceBlocker.free),
                defaultValue: 'Not enough free space: this layout needs ~{{need}} on one disk, only {{free}} available. Pick a different location.',
              })}
            </p>
          )}
          {blockers.some((b) => b.key === 'not_writable') && (
            <p className="frs__blocker">
              ⚠ {t('firstrun.blocked_not_writable', 'A chosen folder is not writable — pick a different location.')}
            </p>
          )}
          <div className="frs__foot-row">
            <span className="frs__totals">
              {t('firstrun.total_required', {
                size: fmtGB(combinedNeed),
                defaultValue: 'Total disk needed: ~{{size}} (one-time download on first use)',
              })}
            </span>
            <button
              type="button"
              className="frs-btn frs-btn--primary"
              disabled={blocked || submitting}
              onClick={start}
            >
              {submitting
                ? t('firstrun.starting', 'Starting…')
                : t('firstrun.start', 'Start installation')}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
