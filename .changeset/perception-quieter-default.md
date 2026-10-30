---
"@reinsjs/brain": minor
---

perception: the default render no longer reports session tokens used or unfolded turns (both stay in `meta.reading` and are available to a custom `render`). Session tokens counted cache reads, so a fresh session crossed several tiers within a few steps and each crossing appended another note the model could not act on. The compactions line keeps its "what was folded" note. compact: the default rules no longer name the perception note's title, so they hold when the host renders its own status notes or does not install perception.
