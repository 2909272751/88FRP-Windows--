#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="88frp-web"
SERVICE_UNIT="${SERVICE_NAME}.service"
MANAGER_CMD_PATH="/usr/local/bin/88frpm"
SERVICE_FILE_PATH="/etc/systemd/system/${SERVICE_UNIT}"

log() {
  printf '[88frp-install] %s\n' "$1"
}

fail() {
  printf '[88frp-install] 错误: %s\n' "$1" >&2
  exit 1
}

require_root() {
  if [ "${EUID:-$(id -u)}" -ne 0 ]; then
    fail "请使用 root 或 sudo 执行该脚本。"
  fi
}

find_target_dir() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local repo_root
  repo_root="$(cd "${script_dir}/.." && pwd)"

  if [ -x "${repo_root}/dist/88frp-web-linux-amd64" ] || [ -x "${repo_root}/dist/88frp-web-linux-arm64" ]; then
    printf '%s\n' "${repo_root}/dist"
    return
  fi

  printf '%s\n' "$(pwd)"
}

detect_executable() {
  local target_dir="$1"
  local candidates=(
    "${target_dir}/88frp-web-linux-amd64"
    "${target_dir}/88frp-web-linux-arm64"
    "${target_dir}/88frp-web"
  )

  local candidate
  for candidate in "${candidates[@]}"; do
    if [ -f "${candidate}" ]; then
      printf '%s\n' "${candidate}"
      return
    fi
  done

  fail "未找到 Linux 可执行程序，请将脚本放在产物目录执行，或确保 dist 中存在 88frp-web-linux-amd64/arm64。"
}

build_exec_start() {
  local executable_path="$1"
  local env_file_path="$2"

  if [ -f "${env_file_path}" ]; then
    printf '%s --env-file %s\n' "${executable_path}" "${env_file_path}"
    return
  fi

  printf '%s\n' "${executable_path}"
}

trim_wrapping_quotes() {
  local value="$1"
  local first_char="${value:0:1}"
  local last_char="${value: -1}"

  if [ "${#value}" -ge 2 ] && {
    [ "${first_char}" = '"' ] && [ "${last_char}" = '"' ];
  }; then
    printf '%s\n' "${value:1:${#value}-2}"
    return
  fi

  if [ "${#value}" -ge 2 ] && {
    [ "${first_char}" = "'" ] && [ "${last_char}" = "'" ];
  }; then
    printf '%s\n' "${value:1:${#value}-2}"
    return
  fi

  printf '%s\n' "${value}"
}

get_env_value_from_file() {
  local file_path="$1"
  local key="$2"

  if [ ! -f "${file_path}" ]; then
    printf '%s\n' ""
    return
  fi

  local raw_value
  raw_value="$(awk -F= -v search_key="${key}" '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*$/ { next }
    {
      current_key=$1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", current_key)
      if (current_key == search_key) {
        value=substr($0, index($0, "=") + 1)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
        print value
      }
    }
  ' "${file_path}" | tail -n 1)"

  trim_wrapping_quotes "${raw_value}"
}

get_default_app_base_dir() {
  local home_dir="${HOME:-/root}"
  printf '%s\n' "${home_dir}/.local/share/88frp-node"
}

is_dangerous_delete_path() {
  local target_path="$1"

  case "${target_path}" in
    ""|/|/root|/home|/usr|/usr/local|/etc|/var|/opt)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

remove_path_if_exists() {
  local target_path="$1"

  if [ -z "${target_path}" ]; then
    return
  fi

  if is_dangerous_delete_path "${target_path}"; then
    fail "检测到危险路径，已拒绝删除: ${target_path}"
  fi

  if [ -e "${target_path}" ] || [ -L "${target_path}" ]; then
    rm -rf "${target_path}"
    log "已删除: ${target_path}"
  fi
}

remove_dir_if_empty() {
  local target_dir="$1"

  if [ -z "${target_dir}" ] || [ ! -d "${target_dir}" ]; then
    return
  fi

  if is_dangerous_delete_path "${target_dir}"; then
    return
  fi

  if [ -z "$(find "${target_dir}" -mindepth 1 -maxdepth 1 2>/dev/null)" ]; then
    rmdir "${target_dir}" 2>/dev/null || true
  fi
}

cleanup_related_paths() {
  local target_dir="$1"
  local env_file_path="$2"

  local app_base_dir
  app_base_dir="$(get_env_value_from_file "${env_file_path}" "APP_BASE_DIR")"
  if [ -z "${app_base_dir}" ]; then
    app_base_dir="$(get_default_app_base_dir)"
  fi

  local data_dir
  data_dir="$(get_env_value_from_file "${env_file_path}" "DATA_DIR")"
  if [ -z "${data_dir}" ]; then
    data_dir="${app_base_dir}/data"
  fi

  local runtime_dir
  runtime_dir="$(get_env_value_from_file "${env_file_path}" "APP_RUNTIME_DIR")"
  if [ -z "${runtime_dir}" ]; then
    runtime_dir="${app_base_dir}/runtime"
  fi

  remove_path_if_exists "${target_dir}/88frp-web-linux-amd64"
  remove_path_if_exists "${target_dir}/88frp-web-linux-arm64"
  remove_path_if_exists "${target_dir}/88frp-web"
  remove_path_if_exists "${target_dir}/.env"
  remove_path_if_exists "${target_dir}/bin/amd64/88frpc"
  remove_path_if_exists "${target_dir}/bin/arm64/88frpc"
  remove_path_if_exists "${data_dir}"
  remove_path_if_exists "${runtime_dir}"

  remove_dir_if_empty "${target_dir}/bin/amd64"
  remove_dir_if_empty "${target_dir}/bin/arm64"
  remove_dir_if_empty "${target_dir}/bin"
  remove_dir_if_empty "${app_base_dir}"
}

write_service_file() {
  local working_dir="$1"
  local exec_start="$2"

  cat > "${SERVICE_FILE_PATH}" <<EOF
[Unit]
Description=88FRP Web Service
After=network.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${working_dir}
ExecStart=${exec_start}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
}

write_manager_command() {
  cat > "${MANAGER_CMD_PATH}" <<EOF
#!/usr/bin/env bash
set -euo pipefail

SERVICE_UNIT="${SERVICE_UNIT}"

show_help() {
  cat <<'HELP'
88frpm 用法:
  88frpm           进入交互菜单
  88frpm status    查看服务状态
  88frpm start     启动服务
  88frpm stop      暂停服务
  88frpm restart   重启服务
  88frpm logs      查看服务日志
  88frpm enable    设置开机自启
  88frpm disable   取消开机自启
  88frpm uninstall 卸载服务并删除相关文件、目录和命令
HELP
}

get_installed_working_dir() {
  if [ ! -f "${SERVICE_FILE_PATH}" ]; then
    printf '%s\n' ""
    return
  fi

  awk -F= '/^WorkingDirectory=/{print \$2}' "${SERVICE_FILE_PATH}" | tail -n 1
}

trim_wrapping_quotes() {
  local value="\$1"
  local first_char="\${value:0:1}"
  local last_char="\${value: -1}"

  if [ "\${#value}" -ge 2 ] && {
    [ "\${first_char}" = '"' ] && [ "\${last_char}" = '"' ];
  }; then
    printf '%s\n' "\${value:1:\${#value}-2}"
    return
  fi

  if [ "\${#value}" -ge 2 ] && {
    [ "\${first_char}" = "'" ] && [ "\${last_char}" = "'" ];
  }; then
    printf '%s\n' "\${value:1:\${#value}-2}"
    return
  fi

  printf '%s\n' "\${value}"
}

get_env_value_from_file() {
  local file_path="\$1"
  local key="\$2"

  if [ ! -f "\${file_path}" ]; then
    printf '%s\n' ""
    return
  fi

  local raw_value
  raw_value="\$(awk -F= -v search_key="\${key}" '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*$/ { next }
    {
      current_key=\$1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", current_key)
      if (current_key == search_key) {
        value=substr(\$0, index(\$0, "=") + 1)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
        print value
      }
    }
  ' "\${file_path}" | tail -n 1)"

  trim_wrapping_quotes "\${raw_value}"
}

get_default_app_base_dir() {
  local home_dir="\${HOME:-/root}"
  printf '%s\n' "\${home_dir}/.local/share/88frp-node"
}

is_dangerous_delete_path() {
  local target_path="\$1"

  case "\${target_path}" in
    ""|/|/root|/home|/usr|/usr/local|/etc|/var|/opt)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

remove_path_if_exists() {
  local target_path="\$1"

  if [ -z "\${target_path}" ]; then
    return
  fi

  if is_dangerous_delete_path "\${target_path}"; then
    printf '检测到危险路径，已拒绝删除: %s\n' "\${target_path}" >&2
    exit 1
  fi

  if [ -e "\${target_path}" ] || [ -L "\${target_path}" ]; then
    rm -rf "\${target_path}"
    printf '已删除: %s\n' "\${target_path}"
  fi
}

remove_dir_if_empty() {
  local target_dir="\$1"

  if [ -z "\${target_dir}" ] || [ ! -d "\${target_dir}" ]; then
    return
  fi

  if is_dangerous_delete_path "\${target_dir}"; then
    return
  fi

  if [ -z "\$(find "\${target_dir}" -mindepth 1 -maxdepth 1 2>/dev/null)" ]; then
    rmdir "\${target_dir}" 2>/dev/null || true
  fi
}

cleanup_related_paths() {
  local target_dir="\$1"
  local env_file_path="\$2"

  local app_base_dir
  app_base_dir="\$(get_env_value_from_file "\${env_file_path}" "APP_BASE_DIR")"
  if [ -z "\${app_base_dir}" ]; then
    app_base_dir="\$(get_default_app_base_dir)"
  fi

  local data_dir
  data_dir="\$(get_env_value_from_file "\${env_file_path}" "DATA_DIR")"
  if [ -z "\${data_dir}" ]; then
    data_dir="\${app_base_dir}/data"
  fi

  local runtime_dir
  runtime_dir="\$(get_env_value_from_file "\${env_file_path}" "APP_RUNTIME_DIR")"
  if [ -z "\${runtime_dir}" ]; then
    runtime_dir="\${app_base_dir}/runtime"
  fi

  remove_path_if_exists "\${target_dir}/88frp-web-linux-amd64"
  remove_path_if_exists "\${target_dir}/88frp-web-linux-arm64"
  remove_path_if_exists "\${target_dir}/88frp-web"
  remove_path_if_exists "\${target_dir}/.env"
  remove_path_if_exists "\${target_dir}/bin/amd64/88frpc"
  remove_path_if_exists "\${target_dir}/bin/arm64/88frpc"
  remove_path_if_exists "\${data_dir}"
  remove_path_if_exists "\${runtime_dir}"

  remove_dir_if_empty "\${target_dir}/bin/amd64"
  remove_dir_if_empty "\${target_dir}/bin/arm64"
  remove_dir_if_empty "\${target_dir}/bin"
  remove_dir_if_empty "\${app_base_dir}"
}

uninstall_all() {
  local target_dir
  target_dir="\$(get_installed_working_dir)"
  local env_file_path="\${target_dir}/.env"

  systemctl stop "\${SERVICE_UNIT}" >/dev/null 2>&1 || true
  systemctl disable "\${SERVICE_UNIT}" >/dev/null 2>&1 || true
  rm -f "${SERVICE_FILE_PATH}"
  systemctl daemon-reload >/dev/null 2>&1 || true

  cleanup_related_paths "\${target_dir}" "\${env_file_path}"
  rm -f "${MANAGER_CMD_PATH}"

  printf '卸载完成。\\n'
  if [ -n "\${target_dir}" ]; then
    printf '已按清单清理目录中的相关文件: %s\\n' "\${target_dir}"
  fi
}

run_command() {
  local cmd="\$1"

  case "\${cmd}" in
    status)
      systemctl status "\${SERVICE_UNIT}" --no-pager
      ;;
    start)
      systemctl start "\${SERVICE_UNIT}"
      systemctl status "\${SERVICE_UNIT}" --no-pager
      ;;
    stop)
      systemctl stop "\${SERVICE_UNIT}"
      systemctl status "\${SERVICE_UNIT}" --no-pager || true
      ;;
    restart)
      systemctl restart "\${SERVICE_UNIT}"
      systemctl status "\${SERVICE_UNIT}" --no-pager
      ;;
    logs)
      journalctl -u "\${SERVICE_UNIT}" -n 200 --no-pager
      ;;
    enable)
      systemctl enable "\${SERVICE_UNIT}"
      ;;
    disable)
      systemctl disable "\${SERVICE_UNIT}"
      ;;
    uninstall)
      uninstall_all
      ;;
    help|-h|--help)
      show_help
      ;;
    *)
      printf '不支持的命令: %s\n\n' "\${cmd}" >&2
      show_help >&2
      exit 1
      ;;
  esac
}

show_menu() {
  while true; do
    cat <<'MENU'

================ 88frpm 管理菜单 ================
1. 查看服务状态
2. 启动服务
3. 暂停服务
4. 重启服务
5. 查看服务日志
6. 设置开机自启
7. 取消开机自启
8. 卸载服务并删除相关文件
0. 退出
=================================================
MENU

    read -r -p "请输入选项编号: " choice
    case "\${choice}" in
      1)
        run_command status
        ;;
      2)
        run_command start
        ;;
      3)
        run_command stop
        ;;
      4)
        run_command restart
        ;;
      5)
        run_command logs
        ;;
      6)
        run_command enable
        ;;
      7)
        run_command disable
        ;;
      8)
        read -r -p "确认卸载服务并删除相关文件/目录吗？输入 yes 继续: " confirm
        if [ "\${confirm}" = "yes" ]; then
          run_command uninstall
        else
          printf '已取消卸载。\\n'
        fi
        ;;
      0)
        printf '已退出 88frpm 菜单。\n'
        exit 0
        ;;
      *)
        printf '无效选项，请重新输入。\n'
        ;;
    esac
  done
}

if [ "\$#" -eq 0 ]; then
  show_menu
else
  run_command "\$1"
fi
EOF

  chmod 755 "${MANAGER_CMD_PATH}"
}

main() {
  if [ "\${1:-}" = "--uninstall" ]; then
    require_root
    if ! command -v systemctl >/dev/null 2>&1; then
      fail "当前系统未检测到 systemctl，脚本仅支持 systemd。"
    fi

    if [ ! -f "${SERVICE_FILE_PATH}" ]; then
      fail "未找到已安装的服务文件：${SERVICE_FILE_PATH}"
    fi

    local installed_target_dir
    installed_target_dir="$(awk -F= '/^WorkingDirectory=/{print $2}' "${SERVICE_FILE_PATH}" | tail -n 1)"
    local installed_env_file_path="${installed_target_dir}/.env"
    if [ -n "${installed_target_dir}" ]; then
      log "准备卸载服务并清理相关文件: ${installed_target_dir}"
    fi

    systemctl stop "${SERVICE_UNIT}" >/dev/null 2>&1 || true
    systemctl disable "${SERVICE_UNIT}" >/dev/null 2>&1 || true
    rm -f "${SERVICE_FILE_PATH}"
    systemctl daemon-reload >/dev/null 2>&1 || true

    cleanup_related_paths "${installed_target_dir}" "${installed_env_file_path}"

    rm -f "${MANAGER_CMD_PATH}"
    log "已删除命令文件: ${MANAGER_CMD_PATH}"
    log "卸载完成"
    exit 0
  fi

  require_root

  if ! command -v systemctl >/dev/null 2>&1; then
    fail "当前系统未检测到 systemctl，脚本仅支持 systemd。"
  fi

  local target_dir
  target_dir="$(find_target_dir)"
  local executable_path
  executable_path="$(detect_executable "${target_dir}")"
  local env_file_path="${target_dir}/.env"
  local exec_start
  exec_start="$(build_exec_start "${executable_path}" "${env_file_path}")"

  chmod 755 "${executable_path}"
  if [ -f "${target_dir}/bin/amd64/88frpc" ]; then
    chmod 755 "${target_dir}/bin/amd64/88frpc"
  fi
  if [ -f "${target_dir}/bin/arm64/88frpc" ]; then
    chmod 755 "${target_dir}/bin/arm64/88frpc"
  fi

  write_service_file "${target_dir}" "${exec_start}"
  write_manager_command

  systemctl daemon-reload
  systemctl enable "${SERVICE_UNIT}"
  systemctl restart "${SERVICE_UNIT}"

  log "服务已安装: ${SERVICE_UNIT}"
  log "工作目录: ${target_dir}"
  log "主程序: ${executable_path}"
  if [ -f "${env_file_path}" ]; then
    log "已使用配置文件: ${env_file_path}"
  else
    log "未找到 ${env_file_path}，服务将使用程序默认配置。"
  fi
  log "管理命令已安装: ${MANAGER_CMD_PATH}"
  log "可执行命令: 88frpm status | start | stop | restart | logs"
}

main "$@"
