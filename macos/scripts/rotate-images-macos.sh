#!/bin/bash

# Persistent image-folder rotation, ticked by SwiftBar every 10 seconds.

set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd -P)/common-macos.sh"

ROTATION_DIR="$STATE_ROOT/rotation"
IMAGES_DIR="$STATE_ROOT/images"
ENABLED_PATH="$ROTATION_DIR/enabled"
INTERVAL_PATH="$ROTATION_DIR/interval-seconds"
CURRENT_PATH="$ROTATION_DIR/current-image"
LAST_PATH="$ROTATION_DIR/last-change"
ERROR_PATH="$ROTATION_DIR/last-error"
LOCK_DIR="$STATE_ROOT/.rotation-tick.lock"

ensure_rotation_root() {
  ensure_state_root
  /bin/mkdir -p "$ROTATION_DIR" "$IMAGES_DIR"
  /bin/chmod 700 "$ROTATION_DIR"
}

validate_interval() {
  case "$1" in ''|*[!0-9]*) fail "Rotation interval must be an integer number of seconds." ;; esac
  [ "$1" -ge 10 ] || fail "Rotation interval must be at least 10 seconds."
}

read_interval() {
  local value="60"
  [ -f "$INTERVAL_PATH" ] && value="$(/usr/bin/head -n1 "$INTERVAL_PATH" 2>/dev/null || true)"
  case "$value" in ''|*[!0-9]*) value="60" ;; esac
  [ "$value" -ge 10 ] 2>/dev/null || value="60"
  printf '%s\n' "$value"
}

write_value() {
  local target="$1"
  local value="$2"
  local temporary="$ROTATION_DIR/.$(/usr/bin/basename "$target").$$.tmp"
  /usr/bin/printf '%s\n' "$value" > "$temporary"
  /bin/chmod 600 "$temporary"
  /bin/mv -f "$temporary" "$target"
}

safe_image_name() {
  local name="$1"
  [ -n "$name" ] && [ "$name" = "$(/usr/bin/basename "$name")" ] || return 1
  case "$name" in *'|'*|*'"'*|*'\'*|*$'\n'*|*$'\r'*|*$'\t'*) return 1 ;; esac
  return 0
}

list_images() {
  local image name
  for image in "$IMAGES_DIR"/*; do
    [ -f "$image" ] || continue
    case "$image" in
      *.png|*.PNG|*.jpg|*.JPG|*.jpeg|*.JPEG|*.webp|*.WEBP) ;;
      *) continue ;;
    esac
    name="$(/usr/bin/basename "$image")"
    safe_image_name "$name" && /usr/bin/printf '%s\n' "$name"
  done | LC_ALL=C /usr/bin/sort -f
}

status_rotation() {
  local enabled="false"
  local current=""
  [ -f "$ENABLED_PATH" ] && enabled="true"
  [ -f "$CURRENT_PATH" ] && current="$(/usr/bin/head -n1 "$CURRENT_PATH" 2>/dev/null || true)"
  safe_image_name "$current" || current=""
  printf 'enabled=%s\n' "$enabled"
  printf 'interval=%s\n' "$(read_interval)"
  printf 'current=%s\n' "$current"
  printf 'error=%s\n' "$([ -f "$ERROR_PATH" ] && /usr/bin/head -n1 "$ERROR_PATH" 2>/dev/null || true)"
}

set_interval() {
  validate_interval "$1"
  ensure_rotation_root
  write_value "$INTERVAL_PATH" "$1"
}

start_rotation() {
  ensure_rotation_root
  [ "$#" -eq 0 ] || set_interval "$1"
  local count
  count="$(list_images | /usr/bin/wc -l | /usr/bin/tr -d ' ')"
  [ "$count" -ge 2 ] || fail "Add at least two PNG, JPEG, or WebP files to the images folder."
  : > "$ENABLED_PATH"
  /bin/chmod 600 "$ENABLED_PATH"
  write_value "$LAST_PATH" "$(/bin/date '+%s')"
}

stop_rotation() {
  ensure_rotation_root
  /bin/rm -f "$ENABLED_PATH"
  local deadline=$((SECONDS + 30))
  while [ -d "$LOCK_DIR" ] && [ "$SECONDS" -lt "$deadline" ]; do /bin/sleep 0.1; done
  [ ! -d "$LOCK_DIR" ] || fail "Timed out waiting for the current image rotation to stop."
}

tick_rotation() {
  [ -f "$ENABLED_PATH" ] || return 0
  if ! /bin/mkdir "$LOCK_DIR" 2>/dev/null; then return 0; fi
  trap '/bin/rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

  local interval now last count current index name offset candidate start_index
  local images=()
  interval="$(read_interval)"
  now="$(/bin/date '+%s')"
  last="0"
  [ -f "$LAST_PATH" ] && last="$(/usr/bin/head -n1 "$LAST_PATH" 2>/dev/null || true)"
  case "$last" in ''|*[!0-9]*) last="0" ;; esac
  [ $((now - last)) -ge "$interval" ] || return 0

  while IFS= read -r name; do images+=("$name"); done < <(list_images)
  count="${#images[@]}"
  if [ "$count" -lt 2 ]; then
    write_value "$LAST_PATH" "$now"
    return 0
  fi
  current=""
  [ -f "$CURRENT_PATH" ] && current="$(/usr/bin/head -n1 "$CURRENT_PATH" 2>/dev/null || true)"
  start_index="0"
  for ((index = 0; index < count; index += 1)); do
    if [ "${images[$index]}" = "$current" ]; then
      start_index="$(((index + 1) % count))"
      break
    fi
  done
  for ((offset = 0; offset < count; offset += 1)); do
    candidate="${images[$(((start_index + offset) % count))]}"
    [ "$candidate" = "$current" ] && continue
    [ -f "$ENABLED_PATH" ] || return 0
    if "$SCRIPT_DIR/load-image-theme-macos.sh" --from-library "$candidate" \
      --transient --quiet --no-start >/dev/null 2>&1; then
      write_value "$CURRENT_PATH" "$candidate"
      /bin/rm -f "$ERROR_PATH"
      write_value "$LAST_PATH" "$now"
      return 0
    fi
  done
  write_value "$ERROR_PATH" "No usable image could be applied."
  write_value "$LAST_PATH" "$now"
}

prompt_interval() {
  local current answer
  current="$(read_interval)"
  answer="$(/usr/bin/osascript - "$current" <<'APPLESCRIPT'
on run argv
  display dialog "自动换图间隔（秒，最小 10）：" default answer (item 1 of argv) buttons {"取消", "保存"} default button "保存" with title "Codex Dream Skin"
  return text returned of result
end run
APPLESCRIPT
)" || exit 0
  set_interval "$answer"
}

command="${1:-status}"
shift || true
case "$command" in
  status) ensure_rotation_root; status_rotation ;;
  start) start_rotation "$@" ;;
  stop) stop_rotation ;;
  set-interval) [ "$#" -eq 1 ] || fail "Usage: $0 set-interval <seconds>"; set_interval "$1" ;;
  prompt-interval) ensure_rotation_root; prompt_interval ;;
  tick) ensure_rotation_root; tick_rotation ;;
  *) fail "Unknown rotation command: $command" ;;
esac
