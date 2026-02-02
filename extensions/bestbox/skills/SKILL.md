---
name: bestbox
description: "Enterprise agent routing via BestBox. Ask about ERP (invoices, inventory, financials), CRM (leads, opportunities, quotes), IT Ops (tickets, KB, diagnostics), or OA (leave, meetings, documents). I'll route to the right domain agent."
metadata:
  openclaw:
    emoji: "🏢"
    requires:
      config: ["plugins.entries.bestbox"]
---

# BestBox Enterprise Agent

Use the `bestbox` tool to query enterprise systems through OpenClaw's control plane.

## Domains

| Domain | Handles |
|--------|---------|
| **ERP** | Purchase orders, invoices, inventory, financial reports |
| **CRM** | Leads, opportunities, quotes, customer data |
| **IT Ops** | Tickets, knowledge base, diagnostics, system health |
| **OA** | Leave requests, meeting scheduling, document workflows |

## Examples

### ERP Query
```json
{
  "query": "Show pending purchase orders over $10,000",
  "domain": "erp"
}
```

### CRM Query
```json
{
  "query": "What opportunities are closing this month?",
  "domain": "crm"
}
```

### IT Ops Query
```json
{
  "query": "Any critical tickets in the queue?",
  "domain": "itops"
}
```

### Auto-Routed Query
```json
{
  "query": "I need to submit a leave request for next Friday"
}
```
The BestBox router will automatically classify this as OA domain.

## Configuration

Set in your OpenClaw config under `plugins.entries.bestbox.config`:

```yaml
plugins:
  entries:
    bestbox:
      enabled: true
      config:
        apiUrl: "http://localhost:8000"
        timeout: 60000
        domains: ["erp", "crm", "itops", "oa"]
```

## Architecture

```
Telegram/WhatsApp/Slack/Discord/...
           │
           ▼
   OpenClaw Gateway (control plane)
           │
           ▼
   bestbox tool → BestBox Agent API
                        │
                        ├─ Router Agent
                        ├─ ERP Agent + tools
                        ├─ CRM Agent + tools
                        ├─ IT Ops Agent + tools
                        └─ OA Agent + tools
```
