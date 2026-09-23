# Visual Studio Marketplace publication

This runbook publishes Open Markdown Review directly from a trusted local checkout. It deliberately adds no CI publication workflow and stores no publishing credential in the repository.

## One-time publisher setup

1. Sign in to the [Visual Studio Marketplace publisher manager](https://marketplace.visualstudio.com/manage/publishers/) with the Microsoft account that will own the extension.
2. Create or verify publisher ID **`mirdadusi`**. The publisher ID must exactly match `package.json`; it is permanent even if the displayed publisher name changes later.
3. Ensure the account can access an Azure DevOps organization. If necessary, create a personal organization from [Azure DevOps](https://dev.azure.com/).

## Create a short-lived publication PAT

1. Open [Azure DevOps](https://dev.azure.com/), enter the chosen organization, select the user-settings icon at the top right, and choose **Personal access tokens**. The organization-specific page is `https://dev.azure.com/<organization>/_usersSettings/tokens`.
2. Select **New Token**.
3. Use a descriptive name such as `open-markdown-review-first-publish`.
4. Select **All accessible organizations**.
5. Choose a short expiration that covers this publication session only.
6. Under **Scopes**, choose **Custom defined**, select **Show all scopes**, and enable only **Marketplace → Manage**.
7. Create the token and copy it immediately. Azure DevOps displays it only once.

Treat the PAT like a password. Do not paste it into a shell command, issue, chat, file, Git credential, `.env` file, or repository secret. Supply it only at the interactive `vsce login` prompt and revoke it as soon as publication and verification are complete.

The PAT route is appropriate for this first local publication but is transitional: Microsoft is retiring global Azure DevOps PATs on 1 December 2026. Revisit Microsoft Entra authentication before a later publication rather than creating a long-lived PAT.

## Qualify and package

Use Node.js 22 or newer from a clean checkout of the intended release commit:

```sh
npm ci
npm test
npm run test:browser
npm run test:extension
npm audit --omit=dev --audit-level=high
npm run verify:marketplace
npm run package:marketplace -- portable
npm run package:marketplace -- win32-x64
```

The two packaging commands create:

```text
open-markdown-review-0.5.5-portable.vsix
open-markdown-review-0.5.5-portable.vsix.sha256
open-markdown-review-0.5.5-win32-x64.vsix
open-markdown-review-0.5.5-win32-x64.vsix.sha256
```

Create and verify the matching GitHub tag/release before Marketplace publication so hosted README release links resolve. The repository release and both VSIX manifests must all report version 0.5.5.

## Publish locally

Authenticate interactively from the repository root:

```sh
npx @vscode/vsce login mirdadusi
```

Paste the PAT only when `vsce` asks for it. Then publish both packages with the same version:

```sh
npx @vscode/vsce publish --packagePath open-markdown-review-0.5.5-portable.vsix
npx @vscode/vsce publish --packagePath open-markdown-review-0.5.5-win32-x64.vsix
```

Do not add `--pre-release`; 0.5.5 is a regular release with explicitly documented limitations. Publish the public Marketplace packages before creating the enterprise tag. The enterprise release workflow verifies that `mirdadusi.open-markdown-review` already exposes the matching version and refuses an out-of-order publication.

After both publication commands complete, wait for the listing to converge and verify both target variants:

```sh
npm run verify:published-marketplace
```

## Verify and revoke

1. Open `https://marketplace.visualstudio.com/items?itemName=mirdadusi.open-markdown-review` in a signed-out browser and check the icon, screenshots, links, version, license, support links, and limitations statement.
2. Search for **Open Markdown Review** in a fresh VS Code profile and install it from the Marketplace.
3. On Windows x64, confirm the installed extension resolves to the targeted Windows package; on another supported desktop, confirm the portable package installs.
4. Create a small disposable review, reconnect it, add one comment, and open its HTML launcher in a supported browser.
5. Return to Azure DevOps **Personal access tokens** and revoke the PAT immediately.

Also run the extension's **Check for Updates** action and confirm it hands control to VS Code's Marketplace update UI. Marketplace installations deliberately use VS Code's native updater rather than the enterprise GitHub-release downloader.

If publication fails, do not create multiple broad or long-lived tokens. Preserve the exact `vsce` error, verify publisher membership and token scope, and retry only after correcting the cause.
