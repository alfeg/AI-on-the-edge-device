# Prompt

The text prompt sent alongside each digit image to the LLM.

Leave empty to use the built-in default:

> *This image shows a single digit on a utility meter display. It's a rolling meter. Some parts of other numbers maybe visible. Reply with ONLY the single digit (0-9) you see. If you cannot determine the digit, reply with the letter N.*

You can customize this to improve recognition for your specific meter type.

**Important:** The prompt must instruct the model to reply with a single digit (0-9) or the letter N. Other response formats will be treated as unrecognized.

| | |
|---|---|
| Default | *(built-in prompt)* |
| Type | Expert |
