# BestBox Enterprise Agent Extension

This OpenClaw extension makes OpenClaw the **control plane** for BestBox's enterprise multi-agent system.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    OpenClaw (Control Plane)                      │
│  WhatsApp │ Telegram │ Slack │ Discord │ Signal │ iMessage      │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │  bestbox tool   │
                    └────────┬────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                 BestBox Agent API (:8000)                        │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐            │
│  │ Router  │→ │   ERP   │  │   CRM   │  │  IT Ops │  │   OA   ││
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘  └─────────┘│
│       ↓            ↓            ↓            ↓            ↓     │
│   LangGraph   Qdrant RAG    Domain Tools    Knowledge Base      │
└─────────────────────────────────────────────────────────────────┘
```

## Setup

1. **Start BestBox services** (in BestBox repo):
   ```bash
   source ~/BestBox/activate.sh
   docker compose up -d
   ./scripts/start-llm.sh &
   ./scripts/start-embeddings.sh &
   ./scripts/start-agent-api.sh
   ```

2. **Enable the plugin** in OpenClaw:
   ```bash
   openclaw plugins enable bestbox
   ```

3. **Configure** (optional):
   ```bash
   openclaw config set plugins.entries.bestbox.config.apiUrl "http://localhost:8000"
   ```

4. **Restart the Gateway**:
   ```bash
   openclaw gateway restart
   ```

## Usage

Once enabled, OpenClaw will automatically use the `bestbox` tool when users ask enterprise questions:

- "Show me pending invoices" → ERP agent
- "What's the status of opportunity #123?" → CRM agent  
- "Any critical tickets?" → IT Ops agent
- "Submit leave for next Friday" → OA agent

## Configuration Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `apiUrl` | string | `http://localhost:8000` | BestBox Agent API URL |
| `timeout` | number | `60000` | Request timeout (ms) |
| `domains` | string[] | `["erp","crm","itops","oa"]` | Enabled domains |

## Development

```bash
cd extensions/bestbox
pnpm install
pnpm test
```
