---
"@reinsjs/lowering-fetch": minor
---

Chat Completions: images in tool results now reach the model. A `role: "tool"` message carries text only, so when the model takes images (`images: true`, as `deepseek()` declares) each image leaves a pointer in the tool message (`[image n attached in the next user message]`) and the images go into one `user` message right after the whole batch of tool messages, before any user message that was moved after the batch. Each result gets a line naming the tool, the call id and the image count and stating it is tool output, not the user; untrusted results keep their `<untrusted>` marking. The landing is `lossy(tool+lifted-images)`. Set `chat: { liftToolImages: false }` for an upstream that rejects this shape to get the previous placeholder text. The wire shape changes (one more `user` message when tool results carry images); the event log does not.
