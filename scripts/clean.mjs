import { rm } from "node:fs/promises";

await Promise.all([
  rm(new URL("../out", import.meta.url), { recursive: true, force: true }),
  rm(new URL("../dist", import.meta.url), { recursive: true, force: true }),
  rm(new URL("../media/review.js", import.meta.url), { force: true }),
  rm(new URL("../media/setup.js", import.meta.url), { force: true }),
  rm(new URL("../dist/OpenMarkdownReview.html", import.meta.url), { force: true }),
  rm(new URL("../dist/portable-browser.js", import.meta.url), { force: true }),
]);
