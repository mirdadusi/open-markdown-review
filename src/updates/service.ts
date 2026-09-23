import { execFile } from "node:child_process";
import * as vscode from "vscode";
import { downloadVerifiedVsix, fetchLatestGitHubRelease } from "./githubReleaseClient";
import { hasNewerRelease, isStrictSemVer } from "./policy";
import { OMR_UPDATE_SOURCE } from "./source";
import type { GitHubReleaseUpdateSource, StoredUpdateState, UpdateFetchResult, UpdateRelease } from "./types";
import { installVsixThroughWorkbench, VSIX_INSTALL_COMMANDS } from "./vsixInstaller";

const CONFIG_ENABLED = "openMarkdownReview.updateChecks.enabled";
const UPDATE_AVAILABLE_CONTEXT = "openMarkdownReview.updateAvailable";
const DAY_MS = 24 * 60 * 60 * 1_000;
const RETRY_MS = 6 * 60 * 60 * 1_000;
const INITIAL_DELAY_MS = 5 * 60 * 1_000;
const INITIAL_SPREAD_MS = 10 * 60 * 1_000;
type CheckMode = "automatic" | "manual";

export function registerUpdateService(context: vscode.ExtensionContext): void {
  let timer: NodeJS.Timeout | undefined;
  let activeAutomatic: AbortController | undefined;
  let generation = 0;
  let installing = false;
  let disposed = false;
  const stateKey = `openMarkdownReview.updateState.${OMR_UPDATE_SOURCE.channel}.${OMR_UPDATE_SOURCE.extensionId}`;
  const extensionIdentityMatches = context.extension.id.toLowerCase() === OMR_UPDATE_SOURCE.extensionId.toLowerCase();
  const currentVersion = (): string | undefined => {
    const version = (context.extension.packageJSON as { version?: unknown }).version;
    return typeof version === "string" && isStrictSemVer(version) ? version : undefined;
  };
  const enabled = () => vscode.workspace.getConfiguration().get<boolean>(CONFIG_ENABLED, true);
  const state = () => context.globalState.get<StoredUpdateState>(stateKey, {});
  const save = (value: StoredUpdateState) => context.globalState.update(stateKey, value);
  const setAvailable = (value: boolean) => vscode.commands.executeCommand("setContext", UPDATE_AVAILABLE_CONTEXT, value);
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };

  const openSource = async (): Promise<void> => {
    const url = OMR_UPDATE_SOURCE.channel === "marketplace" ? OMR_UPDATE_SOURCE.marketplaceItemUrl : OMR_UPDATE_SOURCE.releasesUrl;
    await vscode.env.openExternal(vscode.Uri.parse(url));
  };

  const openInstalledExtension = async (): Promise<void> => {
    const opened = await vscode.env.openExternal(vscode.Uri.parse(`vscode:extension/${OMR_UPDATE_SOURCE.extensionId}`));
    if (!opened) await openSource();
  };

  const checkMarketplace = async (): Promise<void> => {
    if (!extensionIdentityMatches) {
      void vscode.window.showErrorMessage("Markdown Review update configuration does not match the installed extension identity.");
      return;
    }
    try {
      await vscode.commands.executeCommand("workbench.extensions.action.checkForUpdates");
      const action = await vscode.window.showInformationMessage(
        "VS Code checked the Marketplace for Open Markdown Review updates. Enabled Marketplace extensions update automatically according to your VS Code extension settings.",
        "Open extension",
        "Update settings",
      );
      if (action === "Open extension") await openInstalledExtension();
      if (action === "Update settings") await vscode.commands.executeCommand("workbench.action.openSettings", "extensions.autoUpdate");
    } catch {
      const action = await vscode.window.showWarningMessage(
        "VS Code could not start its Marketplace update check. Open the extension page to check manually.",
        "Open extension",
      );
      if (action === "Open extension") await openInstalledExtension();
    }
  };

  if (OMR_UPDATE_SOURCE.channel === "marketplace") {
    context.subscriptions.push(
      vscode.commands.registerCommand("openMarkdownReview.checkForUpdates", checkMarketplace),
      vscode.commands.registerCommand("openMarkdownReview.installUpdate", checkMarketplace),
      vscode.commands.registerCommand("openMarkdownReview.openUpdateSource", openSource),
      { dispose: () => { disposed = true; clearTimer(); } },
    );
    void setAvailable(false);
    return;
  }

  const source: GitHubReleaseUpdateSource = OMR_UPDATE_SOURCE;

  const token = async (mode: CheckMode): Promise<string | undefined> => {
    try {
      const session = await vscode.authentication.getSession(
        "github-enterprise",
        ["repo"],
        mode === "manual" ? { createIfNone: true } : { silent: true },
      );
      if (session?.accessToken) return session.accessToken;
    } catch {
      // Manual checks can still reuse an authenticated GitHub CLI below.
    }
    if (mode !== "manual") return undefined;
    const environment = process.env.OMR_GITHUB_TOKEN?.trim();
    return environment || await githubCliToken(source.host);
  };

  const decision = (release: UpdateRelease): "available" | "current" | undefined => {
    const installed = currentVersion();
    if (!installed) return undefined;
    try { return hasNewerRelease(installed, release) ? "available" : "current"; }
    catch { return undefined; }
  };

  const schedule = (delayMs: number): void => {
    clearTimer();
    if (disposed || context.extensionMode !== vscode.ExtensionMode.Production || !enabled()) return;
    const scheduledGeneration = generation;
    timer = setTimeout(() => {
      timer = undefined;
      void runCheck("automatic").finally(() => {
        if (scheduledGeneration === generation) scheduleNext();
      });
    }, Math.max(1_000, delayMs));
  };

  const scheduleNext = (): void => {
    if (!enabled()) return clearTimer();
    const stored = state(), now = Date.now();
    const retryAt = stored.retryAfter ? Date.parse(stored.retryAfter) : Number.NaN;
    const checkedAt = stored.lastCheckedAt ? Date.parse(stored.lastCheckedAt) : Number.NaN;
    const due = Number.isFinite(retryAt) && retryAt > now ? retryAt : Number.isFinite(checkedAt) ? checkedAt + DAY_MS : now;
    schedule(due - now);
  };

  const authenticationRequired = async (install = false): Promise<void> => {
    const action = await vscode.window.showWarningMessage(
      install
        ? "The verified update could not be installed because GitHub Enterprise authentication is unavailable."
        : "Open Markdown Review could not access the enterprise release. Sign in to GitHub Enterprise or GitHub CLI.",
      "Open releases",
    );
    if (action === "Open releases") await openSource();
  };

  const install = async (release: UpdateRelease, stored: StoredUpdateState): Promise<void> => {
    if (installing) return void vscode.window.showInformationMessage("A Markdown Review update installation is already in progress.");
    installing = true;
    try {
      const accessToken = await token("manual");
      const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Downloading and verifying Open Markdown Review ${release.version}…`,
        cancellable: true,
      }, async (_progress, cancellationToken) => {
        const controller = new AbortController();
        const cancellation = cancellationToken.onCancellationRequested(() => controller.abort());
        try {
          return await downloadVerifiedVsix({ source, release, token: accessToken, signal: controller.signal });
        } finally { cancellation.dispose(); }
      });
      if (result.kind === "authentication-required") return void await authenticationRequired(true);
      if (result.kind === "unavailable") return void vscode.window.showWarningMessage("The enterprise update could not be downloaded. Check your network connection and try again.");
      if (result.kind === "invalid-metadata") return void vscode.window.showErrorMessage(`Markdown Review refused the update: ${result.detail}`);
      const directory = vscode.Uri.joinPath(context.globalStorageUri, "updates");
      const vsix = vscode.Uri.joinPath(directory, result.name);
      await vscode.workspace.fs.createDirectory(directory);
      await vscode.workspace.fs.writeFile(vsix, result.bytes);
      let installCommand: (typeof VSIX_INSTALL_COMMANDS)[number];
      try {
        installCommand = await installVsixThroughWorkbench(vsix, (command, ...args) => vscode.commands.executeCommand(command, ...args));
      } catch {
        const displayPath = vsix.scheme === "file" ? vsix.fsPath : vsix.toString(true);
        const action = await vscode.window.showErrorMessage(
          `The update was downloaded and verified, but VS Code could not install it. The VSIX remains at ${displayPath}.`,
          "Copy VSIX path",
        );
        if (action === "Copy VSIX path") await vscode.env.clipboard.writeText(displayPath);
        return;
      }
      try { await vscode.workspace.fs.delete(vsix); } catch { /* Best-effort cleanup. */ }
      stored.lastNotifiedVersion = undefined;
      stored.remindVersion = undefined;
      stored.remindAfter = undefined;
      await save(stored);
      await setAvailable(false);
      if (installCommand === VSIX_INSTALL_COMMANDS[1]) return;
      const action = await vscode.window.showInformationMessage(
        `Open Markdown Review ${release.version} was installed. Reload VS Code to use it.`,
        "Reload VS Code",
      );
      if (action === "Reload VS Code") await vscode.commands.executeCommand("workbench.action.reloadWindow");
    } finally { installing = false; }
  };

  const present = async (release: UpdateRelease, mode: CheckMode, stored: StoredUpdateState, installImmediately: boolean): Promise<void> => {
    const installed = currentVersion();
    const updateDecision = decision(release);
    await setAvailable(updateDecision === "available");
    if (!installed || !updateDecision) {
      if (mode === "manual") void vscode.window.showErrorMessage("Markdown Review could not determine the installed version.");
      return;
    }
    if (updateDecision === "current") {
      if (mode === "manual") void vscode.window.showInformationMessage(`Open Markdown Review ${installed} is up to date.`);
      return;
    }
    if (installImmediately) return install(release, stored);
    const now = Date.now();
    if (mode === "automatic" && (stored.lastNotifiedVersion === release.version ||
        (stored.remindVersion === release.version && stored.remindAfter && Date.parse(stored.remindAfter) > now))) return;
    stored.lastNotifiedVersion = release.version;
    stored.remindVersion = undefined;
    stored.remindAfter = undefined;
    await save(stored);
    const action = await vscode.window.showInformationMessage(
      `Open Markdown Review ${release.version} is available. You have ${installed}.`,
      "Install verified update",
      "View release",
      "Remind me tomorrow",
    );
    if (action === "Install verified update") await install(release, stored);
    else if (action === "View release") await vscode.env.openExternal(vscode.Uri.parse(release.releaseUrl));
    else if (action === "Remind me tomorrow") {
      stored.lastNotifiedVersion = undefined;
      stored.remindVersion = release.version;
      stored.remindAfter = new Date(Date.now() + DAY_MS).toISOString();
      await save(stored);
    }
  };

  const handle = async (result: UpdateFetchResult, mode: CheckMode, stored: StoredUpdateState, installImmediately: boolean): Promise<void> => {
    if (result.kind === "release") {
      stored.lastCheckedAt = new Date().toISOString();
      stored.retryAfter = undefined;
      stored.etag = result.etag;
      stored.cachedRelease = result.release;
      await save(stored);
      return present(result.release, mode, stored, installImmediately);
    }
    if (result.kind === "not-modified" && stored.cachedRelease) {
      stored.lastCheckedAt = new Date().toISOString();
      stored.retryAfter = undefined;
      await save(stored);
      return present(stored.cachedRelease, mode, stored, installImmediately);
    }
    stored.retryAfter = new Date(Date.now() + RETRY_MS).toISOString();
    await save(stored);
    if (mode !== "manual") return;
    if (result.kind === "authentication-required") return authenticationRequired();
    if (result.kind === "invalid-metadata") void vscode.window.showErrorMessage(`Markdown Review update metadata is invalid: ${result.detail}`);
    else void vscode.window.showWarningMessage("Markdown Review could not check for updates. Check your network connection and try again.");
  };

  const runCheck = async (mode: CheckMode, installImmediately = false): Promise<void> => {
    if (!extensionIdentityMatches) return void vscode.window.showErrorMessage("Markdown Review update configuration does not match the installed extension identity.");
    if (mode === "automatic" && !enabled()) return;
    const checkGeneration = generation, stored = state();
    const accessToken = await token(mode);
    if (mode === "automatic" && (!enabled() || checkGeneration !== generation)) return;
    const controller = mode === "automatic" ? new AbortController() : undefined;
    if (controller) activeAutomatic = controller;
    const result = await fetchLatestGitHubRelease({
      source,
      token: accessToken,
      etag: installImmediately ? undefined : stored.cachedRelease ? stored.etag : undefined,
      signal: controller?.signal,
    });
    const current = !controller || activeAutomatic === controller;
    if (controller && current) activeAutomatic = undefined;
    if (mode === "automatic" && (!enabled() || checkGeneration !== generation || !current)) return;
    await handle(result, mode, stored, installImmediately);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("openMarkdownReview.checkForUpdates", () => runCheck("manual")),
    vscode.commands.registerCommand("openMarkdownReview.installUpdate", () => runCheck("manual", true)),
    vscode.commands.registerCommand("openMarkdownReview.openUpdateSource", openSource),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration(CONFIG_ENABLED)) return;
      generation++;
      if (enabled()) schedule(1_000);
      else { clearTimer(); activeAutomatic?.abort(); activeAutomatic = undefined; }
    }),
    { dispose: () => { disposed = true; generation++; clearTimer(); activeAutomatic?.abort(); } },
  );

  const stored = state();
  void setAvailable(!!stored.cachedRelease && decision(stored.cachedRelease) === "available");
  const checkedAt = stored.lastCheckedAt ? Date.parse(stored.lastCheckedAt) : Number.NaN;
  const now = Date.now();
  if (Number.isFinite(checkedAt) && checkedAt + DAY_MS > now) schedule(checkedAt + DAY_MS - now);
  else schedule(INITIAL_DELAY_MS + Math.floor(Math.random() * INITIAL_SPREAD_MS));
}

function githubCliToken(host: string): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile("gh", ["auth", "token", "--hostname", host], { encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 },
      (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined));
  });
}
