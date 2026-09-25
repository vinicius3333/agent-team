# Payments and domains: spec

Generated apps cannot take money today, and agents cannot buy anything for a project. This spec adds both, driven by agents:

- **Receive:** a payments agent picks a provider, integrates checkout and webhooks into the app, sets up the provider account, and watches revenue after launch.
- **Pay:** agents find what the project needs, such as a domain, and prepare the purchase. A person pays. The harness stores no card, wallet, or registrar balance.
- **Domain:** the person either buys a new domain through that flow or brings one they already own.

Read `src/deploy.ts` (`deployProject`, `posthogEnv`), `src/access.ts`, `src/config.ts`, `src/lead-actions.ts`, `src/store.ts`, `src/operate/agents.ts`, `prompts/architect.md`, `prompts/planner.md`, and `docs/operate.md` first.

Rules for all items: match the repo style (no semicolons, double quotes, erasable TS, `.ts` imports); use `fetch` and `node:crypto` only, no provider SDKs in the harness; add tests with stubbed `fetch`; keep `npx tsc --noEmit`, `npm test`, and `npm run build:ui` passing.

## Approach

Agents decide and act. Code sets the limits.

- **Tools are the only door to money.** Agents reach providers through a harness MCP server (`src/money/mcp.ts`). The server holds the keys, checks each call, and logs it. An agent never sees a key, and a prompt cannot raise a limit.
- **Money out always needs a person.** No agent tool can spend money. `request_purchase` creates a request. The person pays it on the vendor's own page and marks it done.
- **Sandbox first.** Only the `payments_live` approval gives the payments agent the tool that changes the app to live.

Rejected:
- Stored cards, virtual cards, or a prepaid registrar balance. They need secure storage and spending caps. A person paying each purchase is simpler, and purchases are rare.
- Fixed harness code for every provider. Agents read the provider docs and adapt to each project.

## Group A: config

### A1. `pipeline.yaml`

```yaml
payments:
  enabled: false          # true when the product charges users
  provider: null          # null = the payments agent proposes one in the architecture phase
  mode: sandbox           # sandbox | live. Only the "payments_live" approval sets live
  keys:                   # names of env vars on the host, never the keys
    sandboxSecret: PAYMENTS_SANDBOX_KEY
    liveSecret: PAYMENTS_LIVE_KEY

domain:
  mode: none              # none | buy | own
  name: null              # own: the person's domain. buy: null until the purchase is done
```

Validation follows `operateProblems`. Known providers are `asaas`, `stripe`, and `mercadopago`. Key fields must look like env var names.

### A2. Form

The **New project** form gets **Take payments** (provider: agent chooses, or a fixed one) and **Domain** (none, buy one, or use mine plus a name field).

## Group B: the money MCP server

New folder `src/money/`. The server starts per agent call, like the other harness tools, and only for the roles below.

| Tool | Roles | What the code checks |
| --- | --- | --- |
| `provider_docs(provider, topic)` | payments | Read-only. Fetches the provider's docs pages |
| `provider_call(method, path, body)` | payments | Sandbox base URL only, unless `mode` is `live`. An allowlist of paths per provider. No payout, transfer, or withdrawal paths |
| `register_webhook(url)` | payments | The URL must be the project's deploy URL. Live mode refuses `*.trycloudflare.com` |
| `revenue_summary(days)` | payments, analyst | Read-only |
| `domain_search(query)` | treasurer | Read-only availability and price lookup |
| `request_purchase(item, vendorUrl, amount, reason)` | treasurer, lead | Creates a request. Spends nothing |
| `configure_domain(name)` | treasurer | Only the name in `domain.name`. Sets DNS to the project's tunnel |

Every call goes to a new `money_log` table: role, tool, arguments without secrets, result, and time.

## Group C: roles

### C1. Payments agent (`payments`)

- **Architecture phase:** proposes a provider and a pricing model in `architecture.md`, with the reasons. The person sees it at the architecture gate.
- **Build:** the planner gives it the payment tasks. It writes the checkout and webhook code. The reviewer checks webhook signature verification against a fixed checklist in `prompts/reviewer.md`, since that is the easiest part to get wrong.
- **After deploy:** it registers the webhook and runs a sandbox checkout end to end. QA confirms it.
- **Operate:** a new insight agent on the Operate schedule. It reads `revenue_summary` and failed webhooks, and writes findings such as "12 Pix charges expired unpaid this week".

### C2. Treasurer agent (`treasurer`)

- Runs when `domain.mode` is `buy`, or when another agent needs something paid.
- For a domain: proposes up to 3 names with prices using `domain_search`, then calls `request_purchase` for the one the person picks.
- For `own`: calls `configure_domain` and tells the person which DNS records to add at their registrar if the domain is not on Cloudflare.

### C3. Prompts

New `prompts/payments.md` and `prompts/treasurer.md`. Changes to `architect.md`, `planner.md`, `reviewer.md`, and `qa.md`.

## Group D: paying

### D1. Purchase requests

New table `purchases`: `id, item, vendorUrl, amount, currency, reason, requestedBy, status (open | paid | rejected), createdAt, paidAt`.

The flow:

1. An agent calls `request_purchase`.
2. The harness notifies the person on the dashboard and on the configured channels (`src/notify/`).
3. The person opens the vendor link, pays there, and clicks **Paid** (or **Reject**).
4. The run that waits for it goes on. For a domain, the person also enters the final name if it differs.

The run stops on an open request, the same way it stops at an approval gate.

## Group E: receiving

### E1. Env injection

`paymentsEnv(config)` next to `posthogEnv` in `deployProject`:

| Var | Value |
| --- | --- |
| `PAYMENTS_PROVIDER` | The chosen provider |
| `PAYMENTS_MODE` | `sandbox` or `live` |
| `PAYMENTS_SECRET_KEY` | The key for the current mode, read from the host env |
| `PAYMENTS_WEBHOOK_SECRET` | From `register_webhook`, stored in the state DB like `demo.access` |
| `PUBLIC_URL` | The deploy URL |

The deployed app must hold its key to charge customers. That key lives only in the host env and the app container, never in git or the state DB.

### E2. Going live

New gate `payments_live`. It opens after the sandbox checkout passes and the project has a domain. On approval, the harness sets `mode: live` and redeploys. The payments agent then registers the live webhook and runs a small live check that creates a charge and does not pay it.

## Group F: stable URL

Webhooks and domains need a URL that does not change. A quick tunnel changes when it restarts and cannot use a custom domain. With a domain, `deployProject` runs a named Cloudflare tunnel with a token from `CLOUDFLARE_TUNNEL_TOKEN`. Without a domain, deploy works as it does today, and payments stay in sandbox.

## Group G: UI

- A **Money** view on the project page: provider, mode, recent webhook events, revenue, purchase requests, and `money_log`.
- Open purchase requests and the `payments_live` gate show in the approvals list.

## Group H: tests

- `provider_call` refuses a live URL in sandbox mode, a path outside the allowlist, and every payout path.
- `register_webhook` refuses a foreign URL, and a trycloudflare URL in live mode.
- `configure_domain` refuses any name other than `domain.name`.
- No tool output contains a key.
- A run stops on an open purchase request and goes on when it is marked paid.
- `paymentsEnv` never returns the live key in sandbox mode.

## Implementation order

1. Config (A1) and the `purchases` and `money_log` tables.
2. The MCP server with `provider_call`, `provider_docs`, and `register_webhook` for Asaas (B).
3. The payments agent in the build and deploy phases (C1), plus reviewer and QA changes.
4. Purchase requests and notifications (D1), then the treasurer agent (C2).
5. The named tunnel and `own` domains (F).
6. The `payments_live` gate (E2) and the Operate insight agent.
7. Stripe and Mercado Pago path allowlists.
8. UI (G) and README.

## Open questions

1. **Cloudflare.** Domains and live payments need a named tunnel, so a Cloudflare account, with the domain's DNS on Cloudflare. Is that OK, or should apps deploy somewhere else, such as Quave Cloud?
2. **Whose account receives the money?** One provider account for all projects, or one subaccount per project (Asaas creates subaccounts through its API)?
3. **Porkbun for lookups.** `domain_search` needs a registrar API key for availability and prices, but no balance. Is Porkbun fine?
