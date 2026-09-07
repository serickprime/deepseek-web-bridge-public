#!/bin/sh
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
cd -- "$SCRIPT_DIR" || exit 1

if [ ! -f "$SCRIPT_DIR/START.sh" ]; then
  printf '%s\n' 'Не найден файл START.sh. Распакуйте архив полностью и повторите запуск.'
  printf '\nНажмите Enter, чтобы закрыть это окно...'
  read -r _answer
  exit 1
fi

exec /bin/sh "$SCRIPT_DIR/START.sh"
