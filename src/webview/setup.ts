declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

interface SetupData {
  initialized: boolean;
  workspaceName: string;
  title: string;
  availableDocuments: string[];
  selectedDocuments: string[];
  rootDocument?: string;
  sourceRoot: string;
  storageRoot: string;
  storageEditable: boolean;
}

interface TreeNode {
  name: string;
  path: string;
  files: string[];
  folders: Map<string, TreeNode>;
}

const vscode = acquireVsCodeApi();
const data = JSON.parse(document.querySelector<HTMLScriptElement>("#setup-data")?.textContent ?? "{}") as SetupData;
const selected = new Set(data.selectedDocuments.filter((item) => data.availableDocuments.includes(item)));
const tree = document.querySelector<HTMLElement>("#document-tree")!;
const count = document.querySelector<HTMLElement>("#selected-count")!;
const rootSelect = document.querySelector<HTMLSelectElement>("#root-document")!;
const validation = document.querySelector<HTMLElement>("#validation")!;
let storageRoot = data.storageRoot;

function updateStorageMode(insideWorkspace: boolean): void {
  const mode = document.querySelector<HTMLElement>("#storage-mode")!;
  mode.textContent = insideWorkspace ? "Inside workspace · Git-ready" : "Local or shared-drive storage";
  mode.classList.toggle("external", !insideWorkspace);
}

function makeTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: data.workspaceName, path: "", files: [], folders: new Map() };
  for (const fullPath of paths) {
    const parts = fullPath.split("/");
    const filename = parts.pop()!;
    let node = root;
    for (const part of parts) {
      const folderPath = node.path ? `${node.path}/${part}` : part;
      if (!node.folders.has(part)) node.folders.set(part, { name: part, path: folderPath, files: [], folders: new Map() });
      node = node.folders.get(part)!;
    }
    node.files.push(filename);
  }
  return root;
}

function descendants(node: TreeNode): string[] {
  const result = node.files.map((file) => node.path ? `${node.path}/${file}` : file);
  for (const child of node.folders.values()) result.push(...descendants(child));
  return result;
}

function checkbox(path: string, paths: string[], kind: "file" | "folder"): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.dataset.path = path;
  input.dataset.kind = kind;
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("change", () => {
    for (const item of paths) input.checked ? selected.add(item) : selected.delete(item);
    refresh();
  });
  return input;
}

function folderElement(node: TreeNode, isRoot = false): HTMLElement {
  const details = document.createElement("details");
  details.open = true;
  details.className = isRoot ? "tree-root" : "tree-folder";
  details.dataset.search = `${node.path} ${descendants(node).join(" ")}`.toLowerCase();
  const summary = document.createElement("summary");
  const files = descendants(node);
  const input = checkbox(node.path, files, "folder");
  const icon = document.createElement("span");
  icon.className = "folder-icon";
  icon.textContent = "▸";
  const label = document.createElement("span");
  label.className = "node-label";
  label.textContent = isRoot ? data.workspaceName : node.name;
  const badge = document.createElement("span");
  badge.className = "node-count";
  badge.textContent = String(files.length);
  summary.append(input, icon, label, badge);
  details.append(summary);
  const children = document.createElement("div");
  children.className = "tree-children";
  for (const child of [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name))) children.append(folderElement(child));
  for (const file of node.files.sort()) {
    const fullPath = node.path ? `${node.path}/${file}` : file;
    const row = document.createElement("label");
    row.className = "tree-file";
    row.dataset.search = fullPath.toLowerCase();
    const input = checkbox(fullPath, [fullPath], "file");
    const icon = document.createElement("span");
    icon.className = "file-icon";
    icon.textContent = "M↓";
    const text = document.createElement("span");
    text.className = "node-label";
    text.textContent = file;
    const pathText = document.createElement("span");
    pathText.className = "file-path";
    pathText.textContent = fullPath;
    row.append(input, icon, text, pathText);
    children.append(row);
  }
  details.append(children);
  return details;
}

function refreshCheckboxes(): void {
  document.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-kind="file"]').forEach((input) => {
    input.checked = selected.has(input.dataset.path ?? "");
  });
  document.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-kind="folder"]').forEach((input) => {
    const prefix = input.dataset.path ? `${input.dataset.path}/` : "";
    const paths = data.availableDocuments.filter((item) => item.startsWith(prefix));
    const selectedCount = paths.filter((item) => selected.has(item)).length;
    input.checked = paths.length > 0 && selectedCount === paths.length;
    input.indeterminate = selectedCount > 0 && selectedCount < paths.length;
  });
}

function refreshRoot(): void {
  const previous = rootSelect.value || data.rootDocument;
  rootSelect.replaceChildren();
  for (const path of [...selected].sort()) {
    const option = document.createElement("option");
    option.value = path;
    option.textContent = path;
    rootSelect.append(option);
  }
  if (previous && selected.has(previous)) rootSelect.value = previous;
}

function refresh(): void {
  count.textContent = String(selected.size);
  refreshCheckboxes();
  refreshRoot();
  validation.hidden = true;
  document.querySelector<HTMLButtonElement>("#submit")!.disabled = selected.size === 0;
}

tree.append(folderElement(makeTree(data.availableDocuments), true));
document.querySelector<HTMLElement>("#empty-state")!.hidden = data.availableDocuments.length > 0;
tree.hidden = data.availableDocuments.length === 0;
document.querySelector<HTMLInputElement>("#search")!.addEventListener("input", (event) => {
  const query = (event.target as HTMLInputElement).value.trim().toLowerCase();
  document.querySelectorAll<HTMLElement>(".tree-file").forEach((row) => row.hidden = Boolean(query) && !(row.dataset.search ?? "").includes(query));
  document.querySelectorAll<HTMLElement>(".tree-folder, .tree-root").forEach((folder) => {
    folder.hidden = Boolean(query) && !(folder.dataset.search ?? "").includes(query);
    if (query && !folder.hidden) (folder as HTMLDetailsElement).open = true;
  });
});
document.querySelector("#select-all")!.addEventListener("click", () => {
  for (const item of data.availableDocuments) selected.add(item);
  refresh();
});
document.querySelector("#clear-all")!.addEventListener("click", () => {
  selected.clear();
  refresh();
});
document.querySelector("#choose-storage")?.addEventListener("click", () => vscode.postMessage({ command: "chooseStorage" }));
document.querySelector("#cancel")!.addEventListener("click", () => vscode.postMessage({ command: "cancel" }));
document.querySelector("#submit")!.addEventListener("click", () => vscode.postMessage({
  command: "submit",
  title: document.querySelector<HTMLInputElement>("#review-title")!.value,
  documentPaths: [...selected].sort(),
  rootDocument: rootSelect.value,
  storageRoot,
}));
window.addEventListener("message", (event) => {
  const message = event.data as { command?: string; errors?: string[]; storageRoot?: string; insideWorkspace?: boolean };
  if (message.command === "storageSelected" && message.storageRoot) {
    storageRoot = message.storageRoot;
    document.querySelector<HTMLInputElement>("#storage-location")!.value = storageRoot;
    updateStorageMode(Boolean(message.insideWorkspace));
    validation.hidden = true;
    return;
  }
  if (message.command !== "validation") return;
  validation.textContent = (message.errors ?? ["Review setup is invalid."]).join(" ");
  validation.hidden = false;
});
updateStorageMode(storageRoot === data.sourceRoot || storageRoot.startsWith(`${data.sourceRoot}/`) || storageRoot.startsWith(`${data.sourceRoot}\\`));
refresh();
