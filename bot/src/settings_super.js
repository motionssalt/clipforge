/**
 * feature-01 (Super Series): a tiny helper module that reads/writes the
 * per-clone Super Series default. Kept separate from series.js (which is pure
 * derivation logic) so the settings screen import surface stays small.
 *
 * The setting lives at branding/super_series_settings.json alongside
 * branding/series_settings.json; both together decide the wizard's default.
 * Super Series is only meaningful when Series Mode itself is on — startJob
 * force-disables it whenever the Series Mode setting is off, so the two flags
 * cannot silently desync in a queued request.
 */

import { putTextFile, tryGetJsonFile } from './github.js';

export const SUPER_SERIES_SETTINGS_PATH = 'branding/super_series_settings.json';

export async function readSuperSeriesSettings(credentials, repo) {
  const result = await tryGetJsonFile(credentials, repo, SUPER_SERIES_SETTINGS_PATH);
  return result ? result.document : null;
}

export async function saveSuperSeriesSettings(credentials, repo, enabled) {
  const document = { version: 1, enabled: enabled === true, updated_at_epoch: Math.floor(Date.now() / 1000) };
  return putTextFile(credentials, repo, SUPER_SERIES_SETTINGS_PATH, `${JSON.stringify(document, null, 2)}\n`, 'clipforge: update Super Series setting');
}
