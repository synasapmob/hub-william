# Infrastructure

Deployment ownership is documented here before provider-specific configuration
is introduced:

- `frontend/` builds for GitHub Pages.
- `backend/` is the future Railway service.
- PostgreSQL will be provisioned beside the backend when persistent pool and
  order data is implemented.
- SePay and Telegram will call authenticated HTTP webhooks on the backend.
- Provider-bound gateway traffic will leave through the backend runtime.

No Terraform, Docker, or Railway manifest is committed yet because the current
bootstrap does not deploy backend infrastructure. Add provider configuration
only with the first deployment that consumes it, and keep secrets in the
provider secret store.
