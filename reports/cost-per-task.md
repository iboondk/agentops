# Cost per task (regression eval)

- Date: 2026-10-13 (generated 2026-10-13T20:57:58.281Z)
- Provider: MockProvider (deterministic, offline)
- Prices for mock-* models are illustrative, from src/config/pricing.ts.
- Token counts are recorded by the runtime; cost = tokens x pricing table. Duration is wall-clock on the machine that ran the eval.
- Command: `npm run eval`

Result: 10 passed, 0 failed, 10 cases.

| case | status | pass | steps | in tok | out tok | cost (USD, 6dp) | duration ms | trace id |
|---|---|---|---|---|---|---|---|---|
| arithmetic | ok | yes | 2 | 10 | 13 | 0.000075 | 493 | `5252ee9469167ec6dd4b05ccb6771204` |
| precedence_unary | ok | yes | 2 | 13 | 13 | 0.000078 | 222 | `53563deb151c14d7a3e3b1cb4ba707fa` |
| fs_search_hit | ok | yes | 2 | 52 | 54 | 0.000322 | 249 | `6232efdb988c60dd56f2b35810fe2fbd` |
| fs_search_no_match | ok | yes | 2 | 17 | 15 | 0.000092 | 155 | `f1fb8ff4e96d8bc56b0e8ee7d5020aae` |
| http_fetch_fake | ok | yes | 2 | 32 | 28 | 0.000172 | 191 | `00b3df2c875468d87a7295fbdd504440` |
| llm_transient_retry | ok | yes | 2 | 8 | 13 | 0.000073 | 432 | `c96fc192a933551badec0289a4e9e604` |
| budget_exceeded | budget_exceeded | yes | 1 | 4 | 10 | 0.000054 | 52 | `b5fa4ca0cbc8c5879b010dca217538e3` |
| max_steps | max_steps | yes | 1 | 4 | 10 | 0.000054 | 357 | `7b001467d8de5ef8441d95cfb6ccce54` |
| mock_large_arithmetic | ok | yes | 2 | 10 | 13 | 0.000225 | 352 | `9d8d24808729c0c60d27ce2f575f2fba` |
| no_tool_summary | ok | yes | 1 | 4 | 6 | 0.000034 | 147 | `6bc0e0ccd3ac8b575e6edbcce2183cdf` |
| **total** (10) | | 10/10 | 17 | 154 | 175 | 0.001179 | 2650 | |

Mean cost per passing task: 0.000118 USD (over 10 passing cases).
