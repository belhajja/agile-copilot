#!/bin/sh
# Lints the chart and validates what it renders against the Kubernetes schemas (kubeconform), for
# the default values and for the variants a deployment may use. Uses helm v4.3.0 and kubeconform
# v0.8.0: when the one on PATH is missing or another version, the pinned release is downloaded,
# checked against its sha256 and installed into $HELM_TOOLS_DIR (default: a temporary directory),
# which is put first on PATH.
set -eu
CHART="$(dirname "$0")/agile-copilot"
K8S="${KUBERNETES_VERSION:-1.31.0}"
HELM_VERSION=v4.3.0
KUBECONFORM_VERSION=v0.8.0

# sha256 of the release archives (helm: get.helm.sh/*.sha256sum; kubeconform: release CHECKSUMS).
helm_sha256() {
  case "$1" in
    linux-amd64) echo 86584a54def73570558f66f5111cc53dfed56689637ae32c1201205d494f54fb ;;
    linux-arm64) echo 31c5794dd55c66a51e6b7d2e2ac7a114ae8b1de41ff1d9ba51748ac973b06a08 ;;
    darwin-amd64) echo 347a784877e0e20eac865e8d1c36a80f6bb0861d6f29abd34defb6570ef95d92 ;;
    darwin-arm64) echo d3870437e1e95b67f8edbde964156c84a26503f560821d40c542441658934fba ;;
    *) return 1 ;;
  esac
}
kubeconform_sha256() {
  case "$1" in
    linux-amd64) echo 9bc2bffbf71f261128533edaf912153948b7ff238f9a531ae6d34466ec287883 ;;
    linux-arm64) echo 1f53fc8e81258197a35e8603054162a5af1de8c5af13746c71ab680d9534ed87 ;;
    darwin-amd64) echo 71dbc87ac9f24099a62b93570e65aa06312ba6ac8aea63b7f86e9d999edf5a92 ;;
    darwin-arm64) echo f84f4dfbebf4a6b0b230385fa065a39ea35e02608c2b50d025dcf64775a69d67 ;;
    *) return 1 ;;
  esac
}

platform() {
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  case "$(uname -m)" in
    x86_64 | amd64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) arch=unknown ;;
  esac
  echo "$os-$arch"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

download() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$2" "$1"; else wget -qO "$2" "$1"; fi
}

# install <tool> <url> <sha256> <path of the binary inside the archive>
install_tool() {
  archive="$TOOLS/$1.tar.gz"
  download "$2" "$archive"
  actual=$(sha256_of "$archive")
  if [ "$actual" != "$3" ]; then
    echo "$1: sha256 mismatch (expected $3, got $actual)" >&2
    exit 1
  fi
  tar xzf "$archive" -C "$TOOLS" "$4"
  if [ "$4" != "$1" ]; then
    mv "$TOOLS/$4" "$TOOLS/$1"
    rmdir "$TOOLS/$(dirname "$4")"
  fi
  rm -f "$archive"
}

# The tool on PATH counts only when it is the pinned version; otherwise the pinned release is
# installed into $HELM_TOOLS_DIR (or a temporary directory), which goes first on PATH.
helm_pinned() { helm version --short 2>/dev/null | grep -q "^$HELM_VERSION+"; }
kubeconform_pinned() { [ "$(kubeconform -v 2>/dev/null)" = "$KUBECONFORM_VERSION" ]; }

if [ -n "${HELM_TOOLS_DIR:-}" ]; then PATH="$HELM_TOOLS_DIR:$PATH"; fi
if ! helm_pinned || ! kubeconform_pinned; then
  if [ -n "${HELM_TOOLS_DIR:-}" ]; then
    TOOLS="$HELM_TOOLS_DIR"
  else
    TOOLS=$(mktemp -d)
    trap 'rm -rf "$TOOLS"' EXIT
  fi
  mkdir -p "$TOOLS"
  PATH="$TOOLS:$PATH"
  export PATH
  PLATFORM=$(platform)
  if ! helm_pinned; then
    sum=$(helm_sha256 "$PLATFORM") || { echo "no pinned helm for $PLATFORM" >&2; exit 1; }
    install_tool helm "https://get.helm.sh/helm-$HELM_VERSION-$PLATFORM.tar.gz" "$sum" "$PLATFORM/helm"
  fi
  if ! kubeconform_pinned; then
    sum=$(kubeconform_sha256 "$PLATFORM") || { echo "no pinned kubeconform for $PLATFORM" >&2; exit 1; }
    install_tool kubeconform \
      "https://github.com/yannh/kubeconform/releases/download/$KUBECONFORM_VERSION/kubeconform-$PLATFORM.tar.gz" \
      "$sum" kubeconform
  fi
  helm_pinned && kubeconform_pinned || { echo "helm or kubeconform is not the pinned version" >&2; exit 1; }
fi
echo "using $(helm version --short) and kubeconform $(kubeconform -v)"

render() { helm template agile "$CHART" --set secrets.existingSecret=agile-secrets "$@"; }
validate() { kubeconform -strict -summary -kubernetes-version "$K8S" -; }

helm lint "$CHART" --strict --set secrets.existingSecret=agile-secrets
render | validate
render --set ingress.enabled=true --set ingress.tlsSecretName=agile-tls \
  --set 'networkPolicy.jiraPrivateCidrs[0]=10.20.0.0/16' \
  --set 'networkPolicy.dns.cidrs[0]=169.254.20.10/32' \
  --set image.web.digest=sha256:0000000000000000000000000000000000000000000000000000000000000000 \
  --set 'networkPolicy.webIngressFrom[0].namespaceSelector.matchLabels.name=ingress' \
  --set 'networkPolicy.appEgress.extraCIDRs[0]=10.30.0.0/16' \
  --set 'networkPolicy.appEgress.postgres.to[0].ipBlock.cidr=10.0.12.5/32' \
  --set 'networkPolicy.appEgress.extraRules[0].to[0].podSelector.matchLabels.app=keycloak' \
  --set 'networkPolicy.appEgress.extraRules[0].ports[0].port=8080' | validate
render --set networkPolicy.webIngressFrom=null --set networkPolicy.appEgress.enabled=false | validate
render --set mcpAtlassian.enabled=false --set networkPolicy.enabled=false | validate
# Without a Secret name the chart refuses to render.
if helm template agile "$CHART" >/dev/null 2>&1; then
  echo "expected rendering without secrets.existingSecret to fail" >&2
  exit 1
fi
echo "helm chart OK"
