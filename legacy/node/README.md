# Legacy Node companion

Retained for interoperability, regression comparison and explicit legacy use.
It is not a default/fallback runtime and is not bundled in 0.6.2 authoring VSIXs.
Go is required for all three default companion platforms. The protocol, browser
toolbox and PDF exporter are shared; this is not a second source of review state.

Source: `src/professional/companion.ts`, `companionCli.ts` and `companionAssets.ts`.
Build explicitly with `npm run package:companion:legacy -- darwin-arm64` (or
`linux-x64` / `win32-x64`). Outputs go to `dist/legacy-node/{target}`.
The Node script is `dist/companion-node-legacy.js`; it requires Node.js 22+ when
run without an explicitly packaged legacy executable. Authoring remains in
VS Code or the Node-based authoring CLI; reviewers running Go need neither Node
nor Go installed. A received review package cannot choose the extension's host.
