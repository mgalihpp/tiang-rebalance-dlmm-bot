# Vendor LLM docs

Machine-readable documentation dumps kept locally so agents do not have to
re-fetch them on every task. Read the `*-llms.txt` index first; open
`*-llms-full.txt` only when you need the body of a specific page (they are
1 to 2.5 MB).

| File | Source | Fetched |
| --- | --- | --- |
| `helius-llms.txt` | https://www.helius.dev/docs/llms.txt | 2026-10-23 |
| `helius-llms-full.txt` | https://www.helius.dev/docs/llms-full.txt | 2026-10-23 |
| `meteora-llms.txt` | https://docs.meteora.ag/llms.txt | 2026-10-23 |
| `meteora-llms-full.txt` | https://docs.meteora.ag/llms-full.txt | 2026-10-23 |
| `jupiter-llms.txt` | https://dev.jup.ag/docs/llms.txt | 2026-10-23 |
| `jupiter-llms-full.txt` | https://dev.jup.ag/docs/llms-full.txt | 2026-10-23 |
| `effect-llms.md` | https://raw.githubusercontent.com/Effect-TS/effect/main/LLMS.md | 2026-10-23 |

## Refresh

```bash
curl -sL https://www.helius.dev/docs/llms.txt        -o docs/helius-llms.txt
curl -sL https://www.helius.dev/docs/llms-full.txt   -o docs/helius-llms-full.txt
curl -sL https://docs.meteora.ag/llms.txt            -o docs/meteora-llms.txt
curl -sL https://docs.meteora.ag/llms-full.txt       -o docs/meteora-llms-full.txt
curl -sL https://dev.jup.ag/docs/llms.txt            -o docs/jupiter-llms.txt
curl -sL https://dev.jup.ag/docs/llms-full.txt       -o docs/jupiter-llms-full.txt
curl -sL https://raw.githubusercontent.com/Effect-TS/effect/main/LLMS.md -o docs/effect-llms.md
```

## Notes

- `effect.website` serves no `llms.txt` or per-page `.md` endpoints (all 404);
  the canonical machine-readable file is `LLMS.md` in the Effect-TS/effect repo.
- Jupiter's docs live on `developers.jup.ag`; the `dev.jup.ag/docs/*` paths
  redirect there.
- Meteora also publishes a dedicated page about these endpoints:
  https://docs.meteora.ag/agents/llms-txt
