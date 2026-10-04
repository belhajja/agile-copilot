{{- define "agile.fullname" -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}

{{- define "agile.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* Selector labels of one component: web, worker, mcp-atlassian, mcp-atlassian-readonly. */}}
{{- define "agile.selector" -}}
app.kubernetes.io/name: {{ .root.Chart.Name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* An image reference: repository:tag, plus @digest when one is set. */}}
{{- define "agile.image" -}}
{{- .repository }}{{ with .tag }}:{{ . }}{{ end }}{{ with .digest }}@{{ . }}{{ end -}}
{{- end -}}

{{/*
TRUSTED_PROXY_HOPS: config.trustedProxyHops when set; otherwise 1 behind the chart's ingress (the
ingress controller appends the client address to X-Forwarded-For) and 0 without it.
*/}}
{{- define "agile.trustedProxyHops" -}}
{{- $hops := .Values.config.trustedProxyHops -}}
{{- if or (kindIs "invalid" $hops) (eq (toString $hops) "") -}}
{{- ternary 1 0 .Values.ingress.enabled -}}
{{- else -}}
{{- $hops -}}
{{- end -}}
{{- end -}}

{{- define "agile.secret" -}}
{{- required "secrets.existingSecret is required (a Secret you create; see values.yaml)" .Values.secrets.existingSecret -}}
{{- end -}}

{{/* One env var from the Secret. */}}
{{- define "agile.secretEnv" -}}
- name: {{ .key }}
  valueFrom:
    secretKeyRef:
      name: {{ include "agile.secret" .root }}
      key: {{ .key }}
      {{- if .optional }}
      optional: true
      {{- end }}
{{- end -}}

{{/*
Settings and secrets shared by web and worker (never DATABASE_OWNER_URL). The worker also gets the
web-only secrets (OIDC client secret, Stripe keys, BETTER_AUTH_SECRET): its env checks are the web
app's (packages/config/src/worker-env.ts), which require them together. Accepted residual (L16).
*/}}
{{- define "agile.appEnv" -}}
- { name: DEPLOYMENT_MODE, value: {{ .Values.config.deploymentMode | quote }} }
- { name: BETTER_AUTH_URL, value: {{ .Values.config.betterAuthUrl | quote }} }
- { name: ALLOWED_PRIVATE_HOSTS, value: {{ .Values.config.allowedPrivateHosts | quote }} }
- { name: OIDC_PROVIDER, value: {{ .Values.config.oidc.provider | quote }} }
- { name: OIDC_ISSUER, value: {{ .Values.config.oidc.issuer | quote }} }
- { name: OIDC_CLIENT_ID, value: {{ .Values.config.oidc.clientId | quote }} }
- { name: OIDC_DISPLAY_NAME, value: {{ .Values.config.oidc.displayName | quote }} }
- { name: PASSWORD_LOGIN, value: {{ .Values.config.passwordLogin | quote }} }
- { name: BREAK_GLASS_EMAILS, value: {{ .Values.config.breakGlassEmails | quote }} }
- { name: ATLASSIAN_OAUTH_CLIENT_ID, value: {{ .Values.config.atlassianOAuthClientId | quote }} }
- { name: SKILL_RUNS_DAILY_LIMIT, value: {{ .Values.config.skillRunsDailyLimit | quote }} }
- { name: MCP_RATE_LIMIT_PER_MINUTE, value: {{ .Values.config.mcpRateLimitPerMinute | quote }} }
- { name: TRUSTED_PROXY_HOPS, value: {{ include "agile.trustedProxyHops" . | quote }} }
- { name: LANGFUSE_BASE_URL, value: {{ .Values.config.langfuseBaseUrl | quote }} }
- { name: STRIPE_PRICE_TEAM, value: {{ .Values.config.stripePriceTeam | quote }} }
{{- if .Values.mcpAtlassian.enabled }}
# Skill runs and previews read Jira through the read-only twin only.
- { name: MCP_ATLASSIAN_READONLY_URL, value: {{ printf "http://%s-mcp-atlassian-readonly:8000/mcp" (include "agile.fullname" .) | quote }} }
{{- end }}
{{ include "agile.secretEnv" (dict "root" . "key" "DATABASE_URL") }}
{{ include "agile.secretEnv" (dict "root" . "key" "BETTER_AUTH_SECRET") }}
{{ include "agile.secretEnv" (dict "root" . "key" "ENCRYPTION_KEYS") }}
{{ include "agile.secretEnv" (dict "root" . "key" "OIDC_CLIENT_SECRET" "optional" true) }}
{{ include "agile.secretEnv" (dict "root" . "key" "ATLASSIAN_OAUTH_CLIENT_SECRET" "optional" true) }}
{{ include "agile.secretEnv" (dict "root" . "key" "STRIPE_SECRET_KEY" "optional" true) }}
{{ include "agile.secretEnv" (dict "root" . "key" "STRIPE_WEBHOOK_SECRET" "optional" true) }}
{{ include "agile.secretEnv" (dict "root" . "key" "LANGFUSE_PUBLIC_KEY" "optional" true) }}
{{ include "agile.secretEnv" (dict "root" . "key" "LANGFUSE_SECRET_KEY" "optional" true) }}
{{- end -}}
