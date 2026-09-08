---
theme: default
title: Local-first architecture
fonts:
  provider: none
  sans: Arial
  mono: monospace
background: /cover.svg
---

# Local-first architecture

One review package. Two clients.

<!-- Author-only talking point: remove this note when sharing with external reviewers. -->

---
layout: two-cols
---

# Shared evidence

| Evidence | Storage |
| --- | --- |
| Source | Frozen Markdown |
| Discussion | Immutable events |

::right::

```mermaid
flowchart TD
  Folder[Shared review folder] --> Browser[HTML toolbox]
  Folder --> VSCode[VS Code]
```

---
src: ./pages/details.md
---

---
src: ./pages/details.md
---
