import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(projectRoot, "node_modules", "pdfkit", "js", "data");
const destination = path.join(projectRoot, "dist", "data");

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true, force: true });
