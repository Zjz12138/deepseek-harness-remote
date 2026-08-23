/**
 * dsh-client-ui-open-dir — host side.
 *
 * Pure UI plugin: the empty apply exists so the plugin appears in the host
 * cordis.yml / Loader tree (load and lifecycle follow the host); the browser
 * half ships via exports["./client"] and is discovered through the
 * package.json `dsh.client` declaration. Mirrors the upstream
 * dsh-client-ui-workspace node half.
 */

export function apply() {}
