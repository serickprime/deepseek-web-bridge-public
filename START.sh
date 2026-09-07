#!/bin/sh

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
cd -- "$SCRIPT_DIR" || exit 1

open_node_download() {
  case "$(uname -s 2>/dev/null)" in
    Darwin) open "https://nodejs.org/en/download" >/dev/null 2>&1 || true ;;
    *)
      if command -v xdg-open >/dev/null 2>&1; then
        xdg-open "https://nodejs.org/en/download" >/dev/null 2>&1 || true
      elif command -v gio >/dev/null 2>&1; then
        gio open "https://nodejs.org/en/download" >/dev/null 2>&1 || true
      fi
      ;;
  esac
}

pause_on_error() {
  printf '\nНажмите Enter, чтобы закрыть это окно...'
  read -r _answer
}

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Для запуска нужен Node.js 20 или новее.'
  printf '%s\n' 'Открываю официальную страницу загрузки Node.js...'
  open_node_download
  pause_on_error
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null)
case "$NODE_MAJOR" in
  ''|*[!0-9]*) NODE_MAJOR=0 ;;
esac
if [ "$NODE_MAJOR" -lt 20 ]; then
  printf '%s\n' 'Для запуска нужен Node.js 20 или новее.'
  printf '%s\n' 'Обнаружена устаревшая версия Node.js.'
  printf '%s\n' 'Открываю официальную страницу загрузки Node.js...'
  open_node_download
  pause_on_error
  exit 1
fi

node "$SCRIPT_DIR/scripts/desktopStart.mjs"
START_STATUS=$?
if [ "$START_STATUS" -ne 0 ]; then
  pause_on_error
fi
exit "$START_STATUS"
