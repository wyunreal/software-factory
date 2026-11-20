{{/*
Expand the name of the chart.
*/}}
{{- define "software-factory.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "software-factory.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart label.
*/}}
{{- define "software-factory.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Base selector labels.
*/}}
{{- define "software-factory.selectorLabels" -}}
app.kubernetes.io/name: {{ include "software-factory.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Common labels for a component.
Usage: include "software-factory.componentLabels" (dict "root" . "component" "web")
*/}}
{{- define "software-factory.componentLabels" -}}
helm.sh/chart: {{ include "software-factory.chart" .root }}
{{ include "software-factory.selectorLabels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- if .root.Values.image.tag }}
app.kubernetes.io/version: {{ .root.Values.image.tag | quote }}
{{- else if .root.Chart.AppVersion }}
app.kubernetes.io/version: {{ .root.Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
{{- end }}

{{/*
Name of the Secret managed outside Helm by the Sealed Secrets controller.
*/}}
{{- define "software-factory.secretName" -}}
{{- required "secrets.existingSecret is required. Run scripts/deploy-remote-k3s.sh (it seals .env) or scripts/seal-secrets.sh first." .Values.secrets.existingSecret -}}
{{- end }}

{{/*
Render one secret-backed environment variable.
Usage: include "software-factory.secretEnv" (dict "name" "DATABASE_URL" "secretName" $secret)
*/}}
{{- define "software-factory.secretEnv" -}}
- name: {{ .name }}
  valueFrom:
    secretKeyRef:
      name: {{ .secretName }}
      key: {{ default .name .key }}
      optional: {{ default false .optional }}
{{- end }}
