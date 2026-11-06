---
"@reinsjs/ui-agui": patch
"@reinsjs/server": patch
---

Fix: when a single model response streamed both thinking and text, the live AG-UI stream sent each of them twice — once from the deltas (ended without `metadata.reins`) and again in full when the timeline events were committed. Every lowering hands over its drafts only after the whole response has streamed, so the encoder now keeps every streamed block open until a committed `core.model_thinking` / `core.model_text` whose text matches the streamed text claims it, and ends it with `metadata.reins`. Each streamed segment now has exactly one `_START` / `_CONTENT…` / `_END`, and a thinking block and a text block may be open at the same time (AG-UI tracks messages by id; all are ended before `RUN_FINISHED`). A committed event that matches no streamed block (for example the redacted-thinking placeholder) is sent in full as before; blocks no event claims are ended, without metadata, before any non-model event and at the end of the run.

`@reinsjs/server`: a stream that attaches to a run already in progress (`GET`) now skips deltas until the next event signal. Before, it forwarded the rest of the block being streamed at that moment, so the client got a block missing its first half.
