# 1. Empirical failure analysis

All numbers below come from the live device `192.168.68.115`, meter **"main"** — a rolling gas meter that reads `0XXXX.XX` (5 integer digits, leading digit normally `0`, 2 decimals), sampled every ~5 minutes.

- **Readings analysed:** 8 297 rows across `data_2026-05-08.csv … data_2026-06-06.csv` (30 days).
- **Normal value range:** the true meter rose monotonically from ≈ 9700.16 to ≈ 9786 over the month (a slow gas meter).
- **Committed `Value` range in the log:** **1.62 … 99 700.14** — i.e. the system reported values from `1.62` up to `99700`, neither of which the meter ever showed.

## 1.1 The headline symptom: very low / stuck values

The data CSV columns are:
`timestamp, name, RawValue(CNN), Value(committed), PreValue, Rate, ChangeAbs, ErrorMsg, digit1..digit7`.

There are **287 rows where the committed `Value` dropped >50 units below the recent trajectory.** The unambiguous ones (value < 3000 while the meter was ≈ 9700+):

| Date | Stuck `Value` | CNN `RawValue` at the time | Duration |
|------|--------------|----------------------------|----------|
| 2026-05-13 15:37 → 22:36 | drifted 1080–1884 | (raw not logged / None) | ~7 h |
| 2026-05-17 13:59 → 15:56 | **209.00** | raw = **9723.90** (correct!) | ~2 h |
| 2026-05-18 19:55 → 21:50 | **1.65 → 9.72** | raw = **9725.16–9725.58** (correct!) | ~2 h |
| 2026-05-22 12:37 | 6973.00 | None | spot |
| 2026-05-22 20:49 | 1201.00 | raw = 9731.90 (correct!) | spot |
| 2026-06-01 18:41 | 2.99 | raw = 9762.29 (correct!) | spot |
| 2026-06-03 14:27 | 1.62 | raw = 9769.16 (correct!) | spot |

**The CNN was right and the system still reported garbage.** This is the most important observation in the whole analysis: the failures are *downstream of recognition*.

### The seed transition (exact rows)

`data_2026-05-18.csv`:

```
19:50:46  raw=09725.16  Value=9725.16  Pre=9725.16  chg=0.04    no error   digits 0,9,7,2,5,1,6
19:55:46  raw=09725.16  Value=1.65     Pre=1.65     chg=-9723.51 no error  digits 0,9,7,2,5,1,6   ← COLLAPSE
20:00:46  raw=09725.19  Value=1.92     Pre=1.92     chg=0.27     no error  digits 0,9,7,2,5,1,9
```

`data_2026-05-17.csv`:

```
13:54:21  raw=09723.90  Value=9723.90  Pre=9723.90  no error   digits 0,9,7,2,3,9,0
13:59:21  raw=09723.90  Value=209.00   Pre=209.00   chg=-9514.90 no error digits 0,9,7,2,3,9,0  ← COLLAPSE
14:04:22  raw=09727.20  Value=209.00   Pre=209.00   chg=0.00    no error  digits 0,9,7,2,7,2,0
```

Note three things about the collapse rows:

1. **The raw digits are identical to the previous good row** — the CNN did not change its mind.
2. The change is enormous and negative (−9723, −9515) yet the status is **`no error`** — the rate guard did not reject this commit.
3. `PreValue` is immediately overwritten with the garbage, so the next cycle is anchored to it.

After the seed, the meter is *pinned*: each later raw (~9725) is now a negative-rate violation vs the poisoned `PreValue` (1.65), so it is clamped to `PreValue` and the logged `Value` creeps up by tiny consistency adjustments (1.65 → 1.92 → 2.59 → 3.59 → 9.62 → …) instead of jumping back to reality.

## 1.2 The mirror image: stuck *high* (the live 06-06 state)

On 06-06 the device was stuck the other way. From the 3-day message log (`PostProcessing` commit lines):

```
main: Raw: 09774.56, Value: 9784.56, Status: no error     (committed 103×)
```

The CNN reads ≈ **9774.56**; the committed value is pinned at **9784.56** — `PreValue` had been poisoned **+10.00 too high**. Distinct committed values on 06-06:

```
103×  Value: 9784.56     ← stuck (true meter ~9774.5)
 15×  Value: 9785.90
 14×  Value: 9785.98
  …
```

So for most of 06-06 the device reported a value 10 units above the real meter, every reading marked `no error`.

## 1.3 Arbiter behaviour (the "runs too often / never helps" complaint)

From the 3 full days of message logs (06-04/05/06):

| Event (message log) | Count (3 days) |
|---------------------|---------------|
| `LLM arbiter (pre-consistency) - before encode` (arbiter invoked) | **314** |
| `LLM arbiter (neg-rate)` invoked | 0 |
| `LLM arbiter (rate-too-high)` invoked | 0 |
| **`arbiter … accepted`** (arbiter result committed) | **0** |
| `LLM: HTTP request failed … TIMEOUT after 170000ms` | 77 |
| Per-digit `LLM queue:` (ROI sent to fallback) | 1 224 |
| `LLM fallback corrected` (digit replaced) | 1 141 |
| `LLM … returned non-digit / non-numeric content` | 23 |

Reading the cadence directly from the log, the arbiter fires on **every 5-minute cycle** (00:00:59, 00:05:29, 00:10:25, 00:15:14, …). That is the "executed quite a lot of times": it is literally once per reading, because the meter is stuck and *every* reading violates the rate guard.

**It accepted 0 of those 314 calls.** Two failure modes:

- **Timeout — and this is an *infrastructure* cause, not a model one.** The arbiter model (`qwen3-vl`) runs on the operator's work PC behind a LiteLLM proxy at `http://192.168.68.111:4000`; that PC / Ollama is **not always powered on**, so calls hang until `TimeoutMs` (set to `170000` = 170 s) expires. When the PC is up, qwen3-vl is normally a good reader. The defect here is that a 170 s timeout **blocks the whole 5-minute cycle**, and that the arbiter has no "endpoint unavailable → skip fast" path. (A cloud fallback for when the PC is off was considered but deferred until the arbiter *call rate* is under control — see doc 04.)
- **Echo, not read — and this is a *prompt* cause, not a model one** (verified live, see §1.3.1). A successful arbiter transcript (`llm_2026-05-07.txt`):

  ```
  Context:  arbiter pre=9709.02 raw=9708.02 elapsed=4.5min maxRate=0.70
  Prompt:   … The previous accepted reading was 9709.02 … a model just read 9708.02 …
            reply with the actual current meter value …
  Response: {"…","content":"9709.02",…}
  Result:   9709.02
  ```

  The model `qwen3-vl` returned **`9709.02` — verbatim the `PreValue` from the prompt.** It cannot resolve a ~25 KB photo of a small gas-meter dial to 1/100; it just pattern-matches a number in the text. So even when the arbiter "works", it re-pins to whatever `PreValue` already is — including a poisoned one.

  Across the two days of arbiter transcripts that exist (`llm_2026-05-07/08.txt`, before `LogConversations` was turned off): **175 arbiter calls, 60 timed out/failed, 115 parsed.** Of those 115: **40 (35 %) returned exactly the `PreValue` from the prompt, 2 returned exactly the `raw`, and 73 (63 %) were independent reads** (neither). So the model *does* read the dial most of the time — but a large minority of answers are simply one of the two numbers we handed it, and in this poisoned case (true ≈ 9700, `PreValue` = 9709) the echo was wrong.

### 1.3.1 Live probe — the echo is caused by the prompt, not the model

I replayed the saved arbiter JPEGs against a local Ollama vision model (`granite3.2-vision`, 2.5 B — qwen3-vl wasn't on the local host) at `temperature=0`. Ground truth for the first image, read by eye: **09700.026**.

| Prompt | Result | Verdict |
|--------|--------|---------|
| **Production arbiter prompt** (states `pre=9709.02`, `raw=9708.02`) | `9708.02` | **echoed a leaked number** (wrong) |
| **Clean digit-by-digit** ("black digits then red decimal, reply only the number") | `097026` (×3, deterministic) | **correct** |
| **Forced-choice** (`A=9709.02` / `B=9700.0x`) | `A` | **anchored to the listed number** (wrong) |

A second image (true `09700.032`): the clean prompt returned `097083` — **integer part `09700` exactly right**, only the last (blurry, rolling) decimal jittered.

Conclusions, all directly actionable in doc 04:
- The model can read the high-order digits reliably; **leaking candidate numbers into the prompt makes it parrot them instead.**
- **Forced-choice is *not* immune** — listing plausible numbers still anchors the model. Prefer "read it cold" or a single-digit crop, with **no numbers in the prompt**.
- The integer/high-order digits (the part that matters for catching gross errors) are read accurately; last-decimal jitter is benign.

## 1.4 CNN raw vs committed value divergence

`|RawValue − Value| > 50` in **1 189 of 8 297 rows (14 %)**. Most are the stuck-cascade rows above (raw correct, value pinned wrong). This quantifies how often the *committed* number disagreed with what the camera actually saw.

## 1.5 CNN error signature (when the CNN *is* wrong)

When the raw genuinely misreads, it is almost always the **leading/most-significant digit**, e.g.:

```
2026-05-08  raw=69780.37   (true 09700) — leading 0 read as 6
2026-05-08  raw=99700.14   (true 09700) — leading 0 read as 9
2026-06-04  raw=09774.92   (true 09771) — 4th digit 1 read as 4
```

These high-order misreads are exactly the ones that cause *large* value errors, and exactly what the rate guard / arbiter are supposed to catch. The low-order digit noise (last 1–2 digits) is harmless and self-corrects.

## 1.6 Summary of what the data proves

- The dominant defect is **PreValue poisoning + clamp-to-PreValue**, which converts a *single* bad commit into a *multi-hour* stuck wrong reading. → doc 02, 03.
- The arbiter's call frequency is a **symptom** of that stuck state, not independent load. → doc 04.
- The arbiter, as built, **cannot read the dial and is not re-validated**, so it provides zero protection today. → doc 04.
- The CNN's harmful errors are **high-order-digit** errors; its low-order noise is benign. → doc 05.
