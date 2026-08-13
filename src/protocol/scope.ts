export function documentsForPatterns(available: readonly string[], patterns: readonly string[]): string[] {
  const selected = new Set<string>();
  const normalized = available.filter((item) => item.toLowerCase().endsWith(".md"));
  for (const pattern of patterns) {
    if (normalized.includes(pattern)) {
      selected.add(pattern);
      continue;
    }
    if (pattern === "**/*.md") {
      for (const item of normalized) selected.add(item);
      continue;
    }
    if (pattern === "*.md") {
      for (const item of normalized) if (!item.includes("/")) selected.add(item);
      continue;
    }
    const recursive = /^(.*)\/\*\*\/\*\.md$/i.exec(pattern);
    if (recursive) {
      const prefix = `${recursive[1].replace(/^\.\//, "").replace(/\/$/, "")}/`;
      for (const item of normalized) if (item.startsWith(prefix)) selected.add(item);
      continue;
    }
    const direct = /^(.*)\/\*\.md$/i.exec(pattern);
    if (direct) {
      const prefix = `${direct[1].replace(/^\.\//, "").replace(/\/$/, "")}/`;
      for (const item of normalized) {
        if (item.startsWith(prefix) && !item.slice(prefix.length).includes("/")) selected.add(item);
      }
    }
  }
  return [...selected].sort();
}

export function validateDocumentSelection(
  available: readonly string[],
  documentPaths: readonly string[],
  rootDocument: string,
): string[] {
  const errors: string[] = [];
  const availableSet = new Set(available);
  if (!documentPaths.length) errors.push("Select at least one Markdown document.");
  if (new Set(documentPaths).size !== documentPaths.length) errors.push("The document selection contains duplicates.");
  for (const item of documentPaths) {
    if (!availableSet.has(item)) errors.push(`Selected document is unavailable: ${item}`);
  }
  if (!documentPaths.includes(rootDocument)) errors.push("Choose a root document from the selected files.");
  return errors;
}
