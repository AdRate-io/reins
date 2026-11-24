---
"@reinsjs/brain": patch
---

The perception reading now counts the threshold compaction that the projection creates in the current turn. Before, it counted only the timeline snapshot taken at the start of the turn, so on the turn where the fallback folded the oldest turns the note still said `Compactions so far: 0 (nothing has been folded; everything above is verbatim)` while the folded summary sat at the top of the same view, and every later count lagged by one. The session token total uses the same up-to-date timeline.
