# Example architecture review

The author publishes immutable review snapshots. Reviewers write independent events.

Select the second occurrence here: local-first, local-first.

```mermaid
flowchart LR
  Author[VS Code or CLI author] --> Files[Shared review folder]
  Browser[Browser participant] --> Files
  Extension[VS Code participant] --> Files
  Files --> Audit[Verified PDF and inventory]
```

| Capability | Author | Participant |
| --- | --- | --- |
| Freeze a revision | Yes | No |
| Comment, reply, decide | Yes | Yes |
| Export audited PDF | Yes | Yes |

![Captured project image](project.svg)

[Supporting evidence](evidence.txt "review:attach") is captured, not loaded from a live link during review.

[Review checklist](checklist.md) is the second document in this frozen revision.

[Protocol background](https://spec.commonmark.org/) is an ordinary external link, not archived evidence.
