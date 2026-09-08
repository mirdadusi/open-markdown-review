import { readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const root = new URL("../", import.meta.url);
const [shell, css, script, notices] = await Promise.all([
  readFile(new URL("media/professional-shell.html", root), "utf8"),
  readFile(new URL("media/professional.css", root), "utf8"),
  readFile(new URL("dist/portable-browser.js", root), "utf8"),
  readFile(new URL("dist/toolbox-NOTICES.txt", root), "utf8"),
]);
if (!shell.includes("/*__PORTABLE_CSS__*/") || !shell.includes("/*__PORTABLE_JS__*/")) {
  throw new Error("Portable browser shell placeholders are missing.");
}
// HTML parsing terminates an inline script at a literal closing-script token,
// including one inside a JavaScript string owned by a bundled dependency.
const inlineSafeScript = script.replace(/<\/script/gi, "<\\/script");
// Replacer functions preserve `$&`, `$'`, and `$`` sequences that legitimately
// occur in minified third-party JavaScript; string replacements would expand
// those sequences and silently corrupt the bundle.
const artifact = shell
  .replace('__SCRIPT_HASH__', `'sha256-${createHash('sha256').update(inlineSafeScript).digest('base64')}'`)
  .replace("/*__PORTABLE_CSS__*/", () => css)
  .replace('<!--__NOTICES__-->', () => `<details class="notices"><summary>Software, font and data licenses</summary><pre>${notices.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre></details>`)
  .replace("/*__PORTABLE_JS__*/", () => inlineSafeScript);
await writeFile(new URL("dist/OpenMarkdownReview.html", root), artifact, "utf8");
await rm(new URL("dist/portable-browser.js", root), { force: true });
