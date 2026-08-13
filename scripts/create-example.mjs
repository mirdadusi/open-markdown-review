import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSnapshot } from "../out/src/protocol/snapshot.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.join(projectRoot, "protocol", "examples");
const reviewRoot = path.join(workspaceRoot, ".review");
const manifest = JSON.parse(await readFile(path.join(reviewRoot, "manifest.json"), "utf8"));
await createSnapshot(
  workspaceRoot,
  manifest,
  { id: "mirek", displayName: "Mirek" },
  { rootDocument: "architecture.md", storageRoot: reviewRoot },
);
