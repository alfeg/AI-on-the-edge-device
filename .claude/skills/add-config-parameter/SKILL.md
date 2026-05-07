---
name: add-config-parameter
description: Add or rename a parameter in `sd-card/config/config.ini` end-to-end so it round-trips through the firmware, the web Config page, and the in-app tooltip. Use this skill whenever the user asks to add a new config option, rename one, or report that a saved value disappears after Save.
---

# Add a parameter to config.ini end-to-end

The web Config page round-trips `config.ini` through *three* parsers that must all know about every parameter:

1. **Firmware** parses it via `ClassFlow*::ReadParameter` (per-section) when starting up.
2. **JS loader** (`readconfigparam.js` → `ParseConfig`) parses it client-side when the Config page opens.
3. **JS saver** (`edit_config_template.html` → `ReadParameterAll` → `WriteConfigININew`) rebuilds the file when the user clicks Save.

If any of these doesn't know the key, two failure modes appear:

- **Firmware ignores it.** Setting it in the on-device `config.ini` has no runtime effect.
- **The Save button silently deletes it.** The JS saver only emits keys that are in its `ParamAddValue` registry; anything else is dropped on the next round-trip.

So adding a parameter is a *checklist*, not a single-file edit.

## Checklist

### 1. `sd-card/config/config.ini`
Add the new key (commented out if disabled by default) under the matching `[Section]`:

```ini
;[LLMFallback]
;ArbitrateRateViolations = false
```

The repo file is the **template** users see for fresh installs; on-device `config.ini` is preserved across firmware updates.

### 2. Firmware: parse it in the section's `ClassFlow*::ReadParameter`
Each `[Section]` is owned by a `ClassFlow*` subclass under `code/components/jomjol_flowcontroll/`. Find the file (e.g. `ClassFlowLLMFallback.cpp` for `[LLMFallback]`, `ClassFlowPostProcessing.cpp` for `[PostProcessing]`), then add a branch to its `ReadParameter` loop:

```cpp
else if (key == "ARBITRATERATEVIOLATIONS") {
    std::string uval = toUpper(val);
    cfg.arbitrateRateViolations = (uval == "TRUE" || uval == "1" || uval == "YES" || uval == "ON");
}
```

Match the comparison style already in that file (some sections compare upper-case, some don't; some split on whitespace, some on `=`).

If the parameter belongs to a **per-NUMBER** field (under `[PostProcessing]` for example), it's stored on `NumberPost`, not the per-section config struct — see how `AllowNegativeRates` is handled.

### 3. JS loader registry: `sd-card/html/readconfigparam.js`
Find the `var catname = "<Section>";` block in `ParseConfig` and add a `ParamAddValue` call:

```js
ParamAddValue(param, catname, "ArbitrateRateViolations", 1, false, "false");
```

Signature: `ParamAddValue(param, _cat, _param, _anzParam = 1, _isNUMBER = false, _defaultValue = "", _checkRegExList = null)`. Use `_isNUMBER = true` only for per-NUMBER parameters (the loader will iterate over `main.X`, `aux.X`, etc).

> ⚠ **`ZerlegeZeile` gotcha.** The loader tokenises lines on whitespace AND `=`. Free-text values with spaces or embedded `=` (passwords, tokens, prompts, headers) are corrupted unless the key is in the special-case list. If your value can contain spaces or `=`, extend the branch in `sd-card/html/readconfigcommon.js`:
> ```js
> if (input.includes("password") || input.includes("Token") ||
>     input.includes("Prompt") || input.includes("AdditionalHeaders") ||
>     input.includes("YourNewKey")) {
> ```

### 4. Form control in `sd-card/html/edit_config_template.html`
Add a `<tr>` under the right section. For a non-optional boolean, copy the `HomeassistantDiscovery` pattern (no enable checkbox, just a select):

```html
<tr class="LLMFallbackItem expert">
    <td class="indent1">
        <label><class id="LLMFallback_ArbitrateRateViolations_text" style="color:black;">Arbitrate Rate Violations</class></label>
    </td>
    <td>
        <select id="LLMFallback_ArbitrateRateViolations_value1">
            <option value="true">enabled (true)</option>
            <option value="false" selected>disabled (false)</option>
        </select>
    </td>
    <td>$TOOLTIP_LLMFallback_ArbitrateRateViolations</td>
</tr>
```

Naming convention is rigid: id must be `<Section>_<Param>_value1` (and `<Section>_<Param>_enabled` for an optional control with checkbox). The tooltip placeholder `$TOOLTIP_<Section>_<Param>` is substituted at build time from the markdown page (step 7).

Standard control patterns to copy:

| Type | Reference example |
|---|---|
| Optional text (with enable checkbox) | `LLMFallback_AdditionalHeaders` |
| Optional textarea | `LLMFallback_Prompt` |
| Optional number | `LLMFallback_MaxTokens` |
| Optional select | `Alignment_AlignmentAlgo` |
| Non-optional boolean (always written) | `MQTT_HomeassistantDiscovery`, `LLMFallback_LogConversations` |
| Per-NUMBER value | controls inside `<tr class="PostProcessingItem">` near `AllowNegativeRates` |

> ℹ **Non-optional vs optional, in plain terms.** "Optional" means *the user can turn this parameter off entirely* (the line gets a `;` prefix in `config.ini`). It renders with an enable/disable checkbox next to its label. "Non-optional" means *the parameter is always present and active* — the value control alone is the entire UI. Use non-optional for booleans and selects whose "off" semantic is captured by a value (`enabled (true)` / `disabled (false)`), not by commenting the line out. The codebase historically had a bug (fixed in `f0dc3ef1`) where non-optional params would render as greyed-out on devices whose `config.ini` happened to be missing or have-commented those lines — see "When something goes silently wrong" below.

### 5. JS saver + JS loader hooks in `edit_config_template.html`
Add `WriteParameter` (Load → form) and `ReadParameter` (Save → param). Find the `<Section>` block in both `ReadParameterAll()` and the writer (around `WriteParameter(param, category, "LLMFallback", "Prompt", true);`):

```js
// in WriteParameter calls (initial load — populate form from parsed config):
WriteParameter(param, category, "LLMFallback", "ArbitrateRateViolations", false);

// in ReadParameter calls (Save — pull form values back):
ReadParameter(param, "LLMFallback", "ArbitrateRateViolations", false);
```

The 5th boolean argument is `_optional`: `true` for parameters with an enable checkbox, `false` for always-written ones.

For per-NUMBER parameters, both calls take an extra `NUNBERSAkt` argument; copy the surrounding `AllowNegativeRates` lines verbatim.

### 6. Documentation page in `param-docs/parameter-pages/<Section>/<Param>.md`
This is **mandatory** — CI generates the in-app tooltip from this file. Without it, the `$TOOLTIP_*` placeholder stays in the rendered HTML.

```markdown
# Parameter `ArbitrateRateViolations`
Default Value: `false`

!!! Warning
    This is an **Expert Parameter**! Only enable it if you understand what it does!

[One paragraph of intent.]

| Setting | Effect |
|---------|--------|
| `false` | … |
| `true`  | … |

!!! Note
    [Operational caveats / costs / dependencies.]
```

Match the formatting of the neighbour pages (`Provider.md`, `ConfidenceThreshold.md`, etc).

### 7. Run the doc-template generator
From the repo root:

```bash
python param-docs/generate-template-param-doc-pages.py
```

This validates that every `[Section]` key in `config.ini` has a corresponding markdown page, and creates a stub for any that doesn't. Existing pages are not modified.

### 8. (Optional) flag visibility
- Add the param name to `param-docs/expert-params.txt` to inject an "Expert Parameter" warning at the top of its tooltip *unless* the markdown already includes one.
- Add to `param-docs/hidden-in-ui.txt` if it should never be shown in the form (e.g. internal/diagnostic only). The control still has to exist in `edit_config_template.html` for round-trip safety; this flag just hides it.

## Verify locally

After changes:

1. **Round-trip test in browser** (without flashing): open `sd-card/html/edit_config_template.html` indirectly via the device, load Config, look for the new control with no `$TOOLTIP_*` placeholder, edit it, click Save, reload — the value should persist.
2. **Build firmware** (`docker build --target builder -t ai-edge-build .` from repo root) — confirms the C++ side compiles. Adding `ReadParameter` branches without the corresponding member on the config struct is a common mistake.

## When something goes silently wrong

- *Saved value disappears after clicking Save* → step 3 (or 5) is missing.
- *Setting it in `config.ini` has no runtime effect* → step 2 is missing or matches the wrong key (case mismatch, `toUpper` not applied).
- *Tooltip shows literal `$TOOLTIP_Foo_Bar`* → step 6 is missing or step 7 hasn't been run.
- *Multi-word value loads as just the first word and saving truncates it* → step 3 ZerlegeZeile gotcha — extend the special-case list in `readconfigcommon.js`.
- *Build fails with `'arbitrateRateViolations' is not a member of LLMConfig`* → you wired `ReadParameter` (step 2) before adding the field to the struct — add it to the section's config header (e.g. `LLMFallback.h`).
- *Non-optional control renders greyed-out on existing devices* → likely fixed already (`f0dc3ef1`): the JS used to gate every param's UI on the per-line "enabled" flag, which is `false` if the line is missing or commented in `config.ini`. For non-optional params there's no checkbox to flip it back, so the control was permanently dead on any device whose `config.ini` predated this parameter. The fix in `EnDisableItem` (skip the gate when `_optional` is false) and `ReadParameter` (force `enabled=true` on Save for non-optional) means a fresh non-optional control today should "just work" — but if you see this regress, that's where to look.
