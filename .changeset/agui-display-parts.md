---
"@reinsjs/ui-agui": minor
---

User messages and tool results that contain images, video or audio now carry `metadata.reins.parts`: the content in its original order without bytes, with `blobId` for an image stored by reference, so a front end can show the pictures a user sent. `displayPartsOf(content)` is exported for custom encoders. A user message's `TEXT_MESSAGE_END` now carries the same full `metadata.reins` as its `TEXT_MESSAGE_START` (`provenance`, `dropped`, `parts`); AG-UI clients merge message metadata with the last write winning, so these fields used to be lost when the message was assembled. Text-only messages without `provenance` are unchanged.
