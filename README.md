# Ledger — local-first Excel data agent (Google ADK)

An intelligent data agent that accepts an Excel file and a natural-language
request, inspects the real columns, applies a **deterministic** filter plan
(the model never writes pandas), and returns a clean CSV. It then answers
follow-ups — column meaning, summaries, anomalies (with the actual formulas),
and which distribution fits which shape of data.

Daily use is **fully local**: Ollama + LiteLLM. Gemini is optional.

A browser companion (same inspect → filter → CSV → anomaly / distribution
engines, no Ollama required) ships in `src/` so you can try the workflow
immediately. The production agent is the Python package + `adk web`.


```
Excel / prompt  →  inspect  →  reason  →  FilterGroup JSON  →  pandas  →  CSV
                                         ↳ ask if ambiguous
```

## Project layout

```
excel_data_agent/
  agent.py              # LlmAgent + LiteLlm / Gemini  (adk web entry)
  config.py             # env-driven model + I/O limits
  prompts.py            # system instruction
  .env.example
  core/                 # deterministic engines (no LLM)
    inspect_engine.py
    filter_engine.py    # FilterGroup → pandas, AND ordered by selectivity
    hierarchy.py        # AND vs OR, which cut to apply first
    anomalies.py        # IQR / z / modified-z / rare labels + formulas
    distributions.py    # Poisson / Normal / Lognormal / Exp / Gamma / Uniform
    column_semantics.py
    excel_io.py
    types.py
  tools/                # ADK FunctionTools
    inspect.py          # inspect_excel
    filter.py           # filter_excel, preview_filter
    analyze.py          # analyze_data, detect_anomalies, explain_distribution
    files.py            # list_available_files, export_to_csv
  ui/                   # optional Streamlit / Gradio
  cli.py
samples/generate_sample.py
tests/
```

The companion web app in `src/` is the same workflow in the browser
(inspect → filter → CSV → anomalies / distributions) so you can try it
without Ollama. The production agent is the Python package + `adk web`.

---

## 1. Install Ollama and a small tool-calling model

```bash
# macOS
brew install ollama

# Linux
curl -fsSL https://ollama.com/install.sh | sh

# start the daemon (usually automatic after install)
ollama serve
```

Pull a **tool-capable** small model. Confirm tools with `ollama show`:

```bash
ollama pull llama3.2:3b          # laptop default (~2 GB)
# better tool-calling, still local:
ollama pull qwen2.5:7b
ollama pull gemma2:9b
ollama pull llama3.1:8b
ollama pull mistral-small3.1

ollama show llama3.2:3b          # look for  tools  under Capabilities
```

Use `ollama_chat/<tag>` — **not** `ollama/<tag>`. The chat API is the one
that supports tools and keeps conversation context. The default template on
some models can loop on tool calls; if that happens, edit the Modelfile
(`ollama show --modelfile llama3.2 > mf`, adjust the “Given the following
functions…” line, `ollama create llama3.2-tools -f mf`).

Set the base URL (ADK / LiteLLM read this):

```bash
export OLLAMA_API_BASE=http://localhost:11434
```

### Context-length note (important on 3B–8B models)

Inspect payloads (column stats + sample rows) already consume a lot of
tokens. **Inspect once, then filter.** Do not paste the whole sheet into
chat. If the model starts dropping columns, raise the context window:

```bash
export ADK_NUM_CTX=8192          # or 16384 on 16 GB+ machines
```

---

## 2. Install Python dependencies

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Requires Python 3.10+. `litellm>=1.84` is pinned because LiteLLM 1.82.7 and
1.82.8 were a supply-chain incident (March 2026).

Copy env defaults:

```bash
cp excel_data_agent/.env.example excel_data_agent/.env
```

Generate the demo workbook:

```bash
python samples/generate_sample.py     # → samples/employees.xlsx
```

---

## 3. Run with `adk web` (primary interface)

From the **repository root** (the parent of `excel_data_agent/`):

```bash
export OLLAMA_API_BASE=http://localhost:11434
adk web --port 8000
```

Open the ADK Web UI, select **excel_data_agent**, then:

1. Upload `samples/employees.xlsx` (ADK Web already supports file uploads).
2. Say: *Please inspect this file.*
3. Ask for a slice of the data.

The agent will tell you: **“Please upload your Excel file, then describe the data you need.”**

### Example prompts

```
Inspect the file I just uploaded.

Where Age is between 25 and 40 and Department is Sales.

Only records from 2024 where Status is Active.

Employees in Sales or Marketing with Salary above 90000.

What does the Performance column mean?

Summarize the filtered data.

Are there any anomalies? Which formula did you use and why?

Explain the distribution of Salary. Why not normal?
```

### Deterministic tools (no LLM required)

```bash
python -m excel_data_agent.cli inspect samples/employees.xlsx
python -m excel_data_agent.cli filter samples/employees.xlsx \
  '{"logic":"and","conditions":[{"column":"Age","op":"between","value":[25,40]},{"column":"Department","op":"eq","value":"Sales"}]}'
python -m excel_data_agent.cli anomalies samples/employees.xlsx
python -m excel_data_agent.cli dist samples/employees.xlsx --column Salary
```

```bash
pytest
```

---

## 4. Switch models

| Want | Env |
| --- | --- |
| Local 3B (default) | `ADK_MODEL_PROVIDER=ollama` `ADK_MODEL=ollama_chat/llama3.2:3b` |
| Local 7B, better tools | `ADK_MODEL=ollama_chat/qwen2.5:7b` |
| Local Gemma | `ADK_MODEL=ollama_chat/gemma2:9b` |
| Gemini (cloud, optional) | `ADK_MODEL_PROVIDER=gemini` `GEMINI_MODEL=gemini-2.0-flash` `GOOGLE_API_KEY=...` |
| Any LiteLLM provider | `ADK_MODEL_PROVIDER=litellm` `ADK_MODEL=openai/gpt-4o-mini` |

`OLLAMA_API_BASE` defaults to `http://localhost:11434`. Extra knobs:
`ADK_TEMPERATURE`, `ADK_MAX_TOKENS`, `ADK_TOP_P`, `ADK_NUM_CTX`, `ADK_TIMEOUT`,
`ADK_LITELLM_DEBUG=true`.

---

## 5. Optional UIs

```bash
streamlit run excel_data_agent/ui/streamlit_app.py
python -m excel_data_agent/ui/gradio_app
```

Both expose upload + JSON filter + CSV download + model label. Natural-language
translation still lives in the ADK agent (`adk web`).

---

## How filtering actually works

The LLM is **not** allowed to generate pandas. It emits a `FilterGroup`:

```json
{
  "logic": "and",
  "conditions": [
    {"column": "Age", "op": "between", "value": [25, 40]},
    {"column": "Department", "op": "eq", "value": "Sales"}
  ]
}
```

`filter_excel` resolves names against the real header (it will refuse unknown
columns), then applies **AND children in selectivity order** — categorical
equality before numeric ranges — so the returned `trace` shows which predicate
hid the rows. That is the hierarchy of data visibility:

- **AND** = different dimensions (`Department` and `Age` and `Status`).
- **OR / `in`** = several acceptable values of the *same* column.
- `Department = Sales AND Department = Marketing` is always empty; the agent
  is instructed to ask, or to rewrite as `in: ["Sales","Marketing"]`.

If the request is ambiguous, the agent **asks** instead of guessing.

### Anomaly formulas

| Method | Formula | When |
| --- | --- | --- |
| Tukey IQR | `IQR = Q3−Q1`; fences `Q1−1.5·IQR`, `Q3+1.5·IQR` (`k=3` extreme) | Default, small *n*, unknown shape |
| Z-score | `z = (x−μ)/σ`, flag `\|z\|>3` | Bulk looks normal |
| Modified z | `M = 0.6745·(x−median)/MAD`, flag `\|M\|>3.5` | Skewed / already contaminated |
| Rare label | `p̂ = n_j/n`, flag `p̂<0.01` or `n_j=1` | Categorical |

Chooser: *n*<12 → IQR; \|skew\|<0.5 and \|excess kurtosis\|<1 → z; else modified z.

### Distribution chooser

| Shape | Family | Density / mass |
| --- | --- | --- |
| Counts, var ≈ mean | Poisson | `e^{−λ} λ^k / k!` |
| Flat, platykurtic | Uniform | `1/(b−a)` |
| Positive, CV ≈ 1 | Exponential | `λ e^{−λx}` |
| Positive, ln *x* closer to normal | Lognormal | `ln X ~ N(μ,σ²)` |
| Other positive skew | Gamma | method-of-moments *k*, *θ* |
| \|skew\|<0.5 | Normal | `1/(σ√2π) exp(−(x−μ)²/2σ²)` |
| Mixed / tiny *n* | Empirical | sample quantiles |

---

## Safety limits

- 50 MB / 500 000 rows (override with `EXCEL_AGENT_MAX_FILE_BYTES`, `EXCEL_AGENT_MAX_ROWS`)
- Paths resolve only under `data/uploads`, `data/outputs`, `samples/`
- Tools return `{status, error_message}` on failure — the agent surfaces them

Uploads land in `data/uploads/`; CSVs in `data/outputs/`.
