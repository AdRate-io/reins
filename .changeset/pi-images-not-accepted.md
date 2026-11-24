---
"@reinsjs/lowering-pi": patch
---

Images sent to a model whose capabilities say it takes none (`images: false`, which is also what a `ModelDefinition` without `images` means) are now replaced with `[image omitted: this model does not accept images]` by this layer and the landing is declared `lossy`, with the reason in its note. Previously the image was handed to pi-ai, which silently swapped it for its own placeholder text while the landing still said `exact`. The placeholder text is the same as in `@reinsjs/lowering-fetch`, and the loss matrix declares the new case.
