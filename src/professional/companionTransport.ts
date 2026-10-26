/** Browser transport only. The native helper owns the explicitly selected root. */
export function companionHost(): ((method: string, args: unknown[]) => Promise<unknown>) | undefined {
  if (!document.querySelector('meta[name="open-markdown-review-companion"][content="1"]')) return;
  if (location.protocol !== 'http:' || location.hostname !== '127.0.0.1') throw new Error('Open the local companion using its launcher.');
  let token = new URLSearchParams(location.hash.slice(1)).get('omr-session');
  try {
    if (token && /^[a-f0-9]{64}$/.test(token)) { sessionStorage.setItem('omr-companion-session', token); history.replaceState(null, '', '/'); }
    else token = sessionStorage.getItem('omr-companion-session');
  } catch { /* A valid fragment also works when browser storage is unavailable. */ }
  return async (method, args) => {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new Error('This local session is unavailable. Reopen the review using StartReview or VS Code.');
    let response: Response;
    try {
      response = await fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OMR-Session': token }, body: JSON.stringify({ method, args }), cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(120_000) });
    } catch { throw new Error('The local companion is unavailable or timed out. StartReview must remain running. Saved review files are unchanged; reconnect and retry any unacknowledged action.'); }
    if (response.status === 403 || response.status === 503) throw new Error('The local companion session ended or was denied. Reopen the review using its launcher.');
    if (response.status === 429) throw new Error('The local companion is busy. Wait briefly and retry.');
    return response.json();
  };
}
