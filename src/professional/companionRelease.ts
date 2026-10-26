import sourceJson from '../../release/companion-source.json';
import { validateUpdateSource } from '../updates/source';
import { isAllowedAssetApiUrl, isAllowedAssetRedirect } from '../updates/policy';
import { githubCliToken } from '../updates/token';
import { ProtocolError } from './types';

const source = validateUpdateSource(sourceJson);
if (source.channel !== 'github-release') throw new Error('Companion distribution requires a trusted GitHub release source.');
const provider = source;
export type CompanionToken = () => Promise<string | undefined>;
export const companionReleaseBase = provider.releasesUrl;
export const companionReleaseHost = provider.host;

export function allowedCompanionRedirect(value: string): boolean {
  return isAllowedAssetRedirect(value, provider);
}

/** The installed client, never a received review folder, selects the provider. */
export function companionReleaseResolver(getToken?: CompanionToken) {
  let token: string | undefined;
  let metadata: Promise<Record<string, unknown>[]> | undefined;
  return async (version: string, filename: string, size: number, signal: AbortSignal): Promise<{ url: string; headers: Record<string, string> }> => {
    metadata ??= (async () => {
      token = await (getToken ? getToken() : process.env.OMR_GITHUB_TOKEN?.trim() || githubCliToken(provider.host));
      const api = provider.latestReleaseApiUrl.replace(/\/latest$/, `/tags/v${version}`);
      const response = await fetch(api, { redirect: 'error', signal, credentials: 'omit', headers: {
        Accept: 'application/vnd.github+json', 'User-Agent': 'Open-Markdown-Review-companion', ...(token ? { Authorization: `Bearer ${token}` } : {}),
      } });
      if ([401, 403, 404].includes(response.status)) throw new ProtocolError('permission', 'Companion release is unavailable or requires authentication. Sign in to GitHub Enterprise in VS Code, run gh auth login --hostname ' + provider.host + ', or provide OMR_GITHUB_TOKEN. Review evidence was not published.');
      if (!response.ok || !response.body) throw new ProtocolError('missing', 'Companion release metadata is unavailable.');
      const chunks: Uint8Array[] = []; let count = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        count += chunk.length;
        if (count > 1024 * 1024) throw new ProtocolError('invalid', 'Companion release metadata exceeds its limit.');
        chunks.push(chunk);
      }
      let value: Record<string, unknown>;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new ProtocolError('invalid', 'Invalid companion release metadata.'); }
      if (!value || value.tag_name !== `v${version}` || value.draft !== false || value.prerelease !== false
          || value.html_url !== `${provider.releasesUrl}/tag/v${version}` || !Array.isArray(value.assets)) {
        throw new ProtocolError('invalid', 'Companion release identity is invalid.');
      }
      return value.assets.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
    })();
    const matches = (await metadata).filter(item => item.name === filename);
    if (matches.length !== 1 || matches[0].size !== size || typeof matches[0].url !== 'string' || !isAllowedAssetApiUrl(matches[0].url, provider)) {
      throw new ProtocolError('invalid', 'Companion release asset is missing, duplicated or does not match its pinned identity.');
    }
    return { url: matches[0].url, headers: { Accept: 'application/octet-stream', 'User-Agent': 'Open-Markdown-Review-companion', ...(token ? { Authorization: `Bearer ${token}` } : {}) } };
  };
}
