#!/usr/bin/env python3
"""Build and deploy Server Hub through SSH, rootless Podman and Quadlet."""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import secrets
import shlex
import shutil
import subprocess
import sys
import time
import tomllib
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
DEPLOY_FILE = ROOT / "deploy.toml"
CONTAINER_NAME = "game-servers-hub"
SERVICE_NAME = "game-servers-hub.service"
SECRET_NAME = "game-servers-hub-secrets"
IMAGE_REPOSITORY = "localhost/game-servers-hub"
PROJECT_LABEL = "project=game-servers-hub"
INTERNAL_PORT = 4000
HEALTH_TIMEOUT_SECONDS = 120


@dataclass(frozen=True)
class Target:
    environment: str
    server: str
    username: str
    host_bind_ip: str
    host_port: int
    repos_root: str
    legacy_hub_root: str | None = None

    @property
    def ssh(self) -> str:
        return f"{self.username}@{self.server}"

    @property
    def home(self) -> str:
        return "/root" if self.username == "root" else f"/home/{self.username}"

    @property
    def hub_root(self) -> str:
        return f"{self.home}/.local/share/game-servers-hub"

    @property
    def releases_root(self) -> str:
        return f"{self.hub_root}/releases"

    @property
    def data_root(self) -> str:
        return f"{self.hub_root}/data"

    @property
    def backups_root(self) -> str:
        return f"{self.hub_root}/backups"

    @property
    def deployment_root(self) -> str:
        return f"{self.hub_root}/deployment"

    @property
    def deployment_file(self) -> str:
        return f"{self.deployment_root}/deployment.json"

    @property
    def history_root(self) -> str:
        return f"{self.deployment_root}/history"

    @property
    def operation_file(self) -> str:
        return f"{self.deployment_root}/operation.json"

    @property
    def config_file(self) -> str:
        return f"{self.home}/.config/game-servers-hub/manager.toml"

    @property
    def quadlet_file(self) -> str:
        return f"{self.home}/.config/containers/systemd/game-servers-hub.container"

    @property
    def manager_state_root(self) -> str:
        return f"{self.home}/.local/share/game-server-managers"

    @property
    def arma_root(self) -> str:
        return f"{self.home}/.local/share/arma3-manager"


_SSH_SOCKETS: dict[str, str] = {}


def _ssh_opts(target: Target) -> list[str]:
    if target.ssh not in _SSH_SOCKETS:
        safe_server = "".join(ch if ch.isalnum() else "-" for ch in target.server)
        # A process-specific control socket lets recovery distinguish its own
        # SSH connection from a deploy process that is still alive.
        _SSH_SOCKETS[target.ssh] = f"/tmp/hub-deploy-{safe_server}-{os.getpid()}.sock"
    return [
        "-o", "ControlMaster=auto",
        "-o", f"ControlPath={_SSH_SOCKETS[target.ssh]}",
        "-o", "ControlPersist=60s",
        "-o", "BatchMode=yes",
    ]


def run(
    args: list[str],
    *,
    check: bool = True,
    input_data: bytes | None = None,
    capture_output: bool = False,
) -> subprocess.CompletedProcess:
    print("+", shlex.join(args))
    return subprocess.run(
        args,
        cwd=ROOT,
        check=check,
        input=input_data,
        capture_output=capture_output,
    )


def capture(args: list[str], *, check: bool = True, input_data: bytes | None = None) -> str:
    result = subprocess.run(
        args,
        cwd=ROOT,
        check=check,
        input=input_data,
        capture_output=True,
    )
    return result.stdout.decode("utf-8", errors="replace").strip()


def remote(
    target: Target,
    args: list[str],
    *,
    check: bool = True,
    input_data: bytes | None = None,
) -> subprocess.CompletedProcess:
    return run(
        ["ssh", *_ssh_opts(target), target.ssh, shlex.join(args)],
        check=check,
        input_data=input_data,
    )


def remote_capture(
    target: Target,
    args: list[str],
    *,
    check: bool = True,
    input_data: bytes | None = None,
) -> str:
    return capture(
        ["ssh", *_ssh_opts(target), target.ssh, shlex.join(args)],
        check=check,
        input_data=input_data,
    )


def remote_python(
    target: Target,
    source: str,
    *args: str,
    check: bool = True,
    input_data: bytes | None = None,
) -> str:
    return remote_capture(target, ["python3", "-c", source, *args], check=check, input_data=input_data)


def validate_remote_path(value: str, field: str) -> str:
    if not value.startswith("/") or any(ch.isspace() for ch in value) or "\0" in value:
        raise SystemExit(f"{field} must be an absolute path without whitespace")
    return value.rstrip("/")


def load_target(environment: str) -> Target:
    if not DEPLOY_FILE.exists():
        raise SystemExit(f"Missing {DEPLOY_FILE.name}; copy deploy.example.toml to deploy.toml")
    data = tomllib.loads(DEPLOY_FILE.read_text(encoding="utf-8"))
    section = data.get(environment)
    if not isinstance(section, dict):
        raise SystemExit(f"Missing [{environment}] in {DEPLOY_FILE.name}")
    server = str(section.get("server", "")).strip()
    username = str(section.get("username", "")).strip()
    bind_ip = str(section.get("host_bind_ip", "127.0.0.1")).strip()
    port = section.get("host_port", INTERNAL_PORT)
    repos_root = validate_remote_path(str(section.get("repos_root", "")), "repos_root")
    legacy_value = section.get("legacy_hub_root")
    legacy_root = validate_remote_path(str(legacy_value), "legacy_hub_root") if legacy_value else None
    if not server or not username:
        raise SystemExit(f"[{environment}] must define server and username")
    try:
        ipaddress.ip_address(server)
    except ValueError:
        if not all(part and part.replace("-", "").isalnum() for part in server.split(".")):
            raise SystemExit(f"Invalid server address: {server}")
    if not username.replace("-", "").replace("_", "").isalnum():
        raise SystemExit(f"Invalid username: {username}")
    try:
        ipaddress.ip_address(bind_ip)
    except ValueError as error:
        raise SystemExit("host_bind_ip must be an IP address") from error
    if not isinstance(port, int) or not 1 <= port <= 65535:
        raise SystemExit("host_port must be an integer between 1 and 65535")
    return Target(environment, server, username, bind_ip, port, repos_root, legacy_root)


def verify_local_tools() -> None:
    for binary in ("ssh", "tar"):
        if shutil.which(binary) is None:
            raise SystemExit(f"Required local command not found: {binary}")


def git_commit() -> str:
    try:
        return capture(["git", "rev-parse", "HEAD"])
    except (subprocess.CalledProcessError, FileNotFoundError):
        return "unknown"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def manager_config(target: Target) -> str:
    return f'''# Generated by deploy.py. Secrets are provided by a Podman secret.

[web]
port = {INTERNAL_PORT}
bind_ip = "0.0.0.0"
username = "admin"

[podman]
repos_dir = "{target.repos_root}"

[ports]
web_base = 9000

[runtime]
timezone = "UTC"
'''


def quadlet(target: Target, image: str, commit: str, build_date: str) -> str:
    environments = {
        "HOME": target.home,
        "CONTAINER_HOST": "unix:///run/podman/podman.sock",
        "HUB_CONFIG_FILE": target.config_file,
        "HUB_SECRETS_FILE": "/run/secrets/manager.secrets.toml",
        "HUB_DATA_DIR": target.data_root,
        "HUB_REPOS_DIR": target.repos_root,
        "HUB_COMMIT": commit,
        "HUB_BUILD_DATE": build_date,
        "GSM_STATE_ROOT": target.manager_state_root,
        "ARMA3_DRIVER_ROOT": f"{target.arma_root}/releases",
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    environment_lines = "\n".join(f'Environment="{key}={value}"' for key, value in environments.items())
    return f'''[Unit]
Description=Game Servers Manager Hub
Requires=podman.socket
After=podman.socket network-online.target

[Container]
Image={image}
Pull=never
ContainerName={CONTAINER_NAME}
PublishPort={target.host_bind_ip}:{target.host_port}:{INTERNAL_PORT}
Secret={SECRET_NAME},type=mount,target=manager.secrets.toml,mode=0600
Volume=%t/podman/podman.sock:/run/podman/podman.sock
Volume={target.data_root}:{target.data_root}:rw
Volume={target.manager_state_root}:{target.manager_state_root}:rw
Volume={target.arma_root}:{target.arma_root}:ro
Volume={target.repos_root}:{target.repos_root}:rw
Volume={target.config_file}:{target.config_file}:ro
SecurityLabelDisable=true
NoNewPrivileges=true
LogDriver=journald
{environment_lines}

[Service]
Restart=on-failure
RestartSec=5
TimeoutStartSec=180
TimeoutStopSec=90

[Install]
WantedBy=default.target
'''


def atomic_remote_write(target: Target, path: str, content: bytes, mode: int = 0o600) -> None:
    script = r'''
import os, sys, tempfile
path, mode = sys.argv[1], int(sys.argv[2], 8)
parent = os.path.dirname(path)
os.makedirs(parent, mode=0o700, exist_ok=True)
fd, temporary = tempfile.mkstemp(prefix=".deploy-", dir=parent)
try:
    os.fchmod(fd, mode)
    with os.fdopen(fd, "wb") as handle:
        handle.write(sys.stdin.buffer.read())
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    os.chmod(path, mode)
    directory = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try: os.fsync(directory)
    finally: os.close(directory)
except Exception:
    try: os.unlink(temporary)
    except FileNotFoundError: pass
    raise
'''
    remote_python(target, script, path, f"{mode:o}", input_data=content)


def remote_json(target: Target, path: str) -> dict[str, Any] | None:
    script = r'''
import json, os, sys
path = sys.argv[1]
if not os.path.exists(path):
    print("null")
else:
    with open(path, encoding="utf-8") as handle: print(json.dumps(json.load(handle)))
'''
    value = json.loads(remote_python(target, script, path))
    return value if isinstance(value, dict) else None


def begin_operation(target: Target, operation_id: str, kind: str) -> None:
    payload = json.dumps({"operationId": operation_id, "kind": kind, "startedAt": utc_now()}).encode()
    script = r'''
import os, sys
path = sys.argv[1]
os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
try: fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
except FileExistsError:
    print("another deployment operation is active", file=sys.stderr)
    raise SystemExit(3)
with os.fdopen(fd, "wb") as handle:
    handle.write(sys.stdin.buffer.read())
    handle.flush(); os.fsync(handle.fileno())
os.chmod(path, 0o600)
'''
    remote_python(target, script, target.operation_file, input_data=payload)


def end_operation(target: Target, operation_id: str, *, check: bool = True) -> None:
    script = r'''
import json, os, sys
path, expected = sys.argv[1:3]
try:
    with open(path, encoding="utf-8") as handle: current = json.load(handle)
except FileNotFoundError:
    if sys.argv[3] == "optional": raise SystemExit(0)
    raise
if current.get("operationId") != expected:
    print("operationId does not own the active deployment", file=sys.stderr)
    raise SystemExit(3)
os.unlink(path)
'''
    remote_python(target, script, target.operation_file, operation_id, "required", check=check)


def recover_operation(target: Target, operation_id: str) -> None:
    if len(operation_id) != 32 or any(ch not in "0123456789abcdef" for ch in operation_id):
        raise SystemExit("operation id must be 32 lowercase hexadecimal characters")
    script = r'''
import os, sys

def ancestors(pid):
    result = set()
    while pid > 1:
        result.add(pid)
        try:
            with open(f"/proc/{pid}/stat", encoding="utf-8") as handle:
                pid = int(handle.read().split(")", 1)[1].split()[1])
        except (FileNotFoundError, PermissionError, ValueError, IndexError):
            break
    return result

own_chain = ancestors(os.getpid())
active = []
for name in os.listdir("/proc"):
    if not name.isdigit() or int(name) in own_chain:
        continue
    try:
        command = open(f"/proc/{name}/cmdline", "rb").read().replace(b"\0", b" ").decode(errors="replace")
    except (FileNotFoundError, PermissionError):
        continue
    if "sshd:" in command and "@notty" in command:
        active.append(name)
if active:
    print("another non-interactive SSH session is active; recovery is unsafe", file=sys.stderr)
    raise SystemExit(3)
'''
    remote_python(target, script)
    end_operation(target, operation_id)
    print("Deployment operation recovered. Confirm no other deploy process is still running before redeploying.")


def remote_path_checks(target: Target, paths: list[str]) -> None:
    script = r'''
import os, sys
missing = [path for path in sys.argv[1:] if not os.path.isdir(path)]
if missing:
    print("missing required directories: " + ", ".join(missing), file=sys.stderr)
    raise SystemExit(2)
'''
    remote_python(target, script, *paths)


def preflight(target: Target, *, require_free_port: bool = False) -> None:
    verify_local_tools()
    remote(target, ["podman", "info"])
    cgroups = remote_capture(target, ["podman", "info", "--format", "{{.Host.CgroupsVersion}}"])
    if cgroups.strip().lower() != "v2":
        raise SystemExit(f"Quadlet requires cgroup v2; remote Podman reports {cgroups or 'unknown'}")
    remote(target, ["systemctl", "--user", "is-active", "podman.socket"])
    quadlet_generator(target)
    lingering = remote_capture(target, ["loginctl", "show-user", target.username, "-p", "Linger", "--value"])
    if lingering.strip().lower() != "yes":
        raise SystemExit(f"lingering is not enabled for {target.username}; run: loginctl enable-linger {target.username}")
    remote_path_checks(
        target,
        [
            target.repos_root,
            f"{target.repos_root}/arma_server",
            f"{target.repos_root}/proyect_zomboid",
            target.manager_state_root,
            target.arma_root,
        ],
    )
    if require_free_port:
        host = "127.0.0.1" if target.host_bind_ip == "0.0.0.0" else target.host_bind_ip
        script = r'''
import socket, sys
with socket.socket() as sock:
    sock.settimeout(1)
    if sock.connect_ex((sys.argv[1], int(sys.argv[2]))) == 0:
        print("hub port is already in use; stop the legacy process before migration", file=sys.stderr)
        raise SystemExit(2)
'''
        remote_python(target, script, host, str(target.host_port))


def quadlet_generator(target: Target) -> str:
    script = r'''
import os
for candidate in (
    "/usr/lib/systemd/system-generators/podman-system-generator",
    "/usr/libexec/podman/quadlet",
):
    if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
        print(candidate)
        break
else:
    raise SystemExit("Podman Quadlet generator was not found")
'''
    return remote_python(target, script)


def validate_quadlet(target: Target, content: str, remote_dir: str) -> None:
    candidate_dir = f"{remote_dir}/quadlet-validation"
    candidate_file = f"{candidate_dir}/game-servers-hub.container"
    atomic_remote_write(target, candidate_file, content.encode())
    remote(
        target,
        [
            "env",
            f"QUADLET_UNIT_DIRS={candidate_dir}",
            quadlet_generator(target),
            "--user",
            "--dryrun",
        ],
    )


def upload_release(target: Target, release: str) -> str:
    remote_dir = f"{target.releases_root}/{release}"
    remote(target, ["mkdir", "-p", remote_dir])
    archive = subprocess.Popen(
        [
            "tar", "-czf", "-",
            "--exclude=.git", "--exclude=node_modules", "--exclude=backend/dist",
            "--exclude=frontend/dist", "--exclude=data", "--exclude=deploy.toml",
            "--exclude=manager.secrets.toml", "--exclude=._*", ".",
        ],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        env={**os.environ, "COPYFILE_DISABLE": "1"},
    )
    assert archive.stdout is not None
    extract = subprocess.run(
        ["ssh", *_ssh_opts(target), target.ssh, shlex.join(["tar", "-xzf", "-", "-C", remote_dir])],
        stdin=archive.stdout,
    )
    archive.stdout.close()
    archive_code = archive.wait()
    if archive_code or extract.returncode:
        raise SystemExit("Hub release transfer failed")
    return remote_dir


def build_image(target: Target, remote_dir: str, image: str, commit: str, build_date: str) -> None:
    remote(
        target,
        [
            "podman", "build",
            "--build-arg", f"GIT_COMMIT={commit}",
            "--build-arg", f"BUILD_DATE={build_date}",
            "--label", PROJECT_LABEL,
            "--file", f"{remote_dir}/Containerfile",
            "--tag", image,
            remote_dir,
        ],
    )


def secret_exists(target: Target) -> bool:
    return bool(remote_capture(target, ["podman", "secret", "inspect", "--format", "{{.ID}}", SECRET_NAME], check=False))


def validate_legacy_secret(target: Target, path: str) -> None:
    script = r'''
import os, stat, sys
path = sys.argv[1]
value = os.lstat(path)
if stat.S_ISLNK(value.st_mode) or not stat.S_ISREG(value.st_mode):
    print("legacy manager.secrets.toml must be a regular file", file=sys.stderr); raise SystemExit(2)
if stat.S_IMODE(value.st_mode) & 0o077:
    print("legacy manager.secrets.toml must have mode 0600", file=sys.stderr); raise SystemExit(2)
'''
    remote_python(target, script, path)


def ensure_secret(target: Target) -> str | None:
    if secret_exists(target):
        return None
    if target.legacy_hub_root:
        legacy_secret = f"{target.legacy_hub_root}/config/manager.secrets.toml"
        validate_legacy_secret(target, legacy_secret)
        remote(target, ["podman", "secret", "create", SECRET_NAME, legacy_secret])
        return None
    password = secrets.token_urlsafe(24)
    session_secret = secrets.token_hex(32)
    content = f'[web]\npassword = "{password}"\nsession_secret = "{session_secret}"\n'.encode()
    remote(target, ["podman", "secret", "create", SECRET_NAME, "-"], input_data=content)
    return password


def migrate_legacy_data(target: Target) -> None:
    if not target.legacy_hub_root:
        return
    source = f"{target.legacy_hub_root}/data"
    script = r'''
import os, shutil, sys
source, destination = sys.argv[1:3]
if not os.path.isfile(os.path.join(source, "hub.sqlite3")):
    print("legacy data/hub.sqlite3 does not exist", file=sys.stderr); raise SystemExit(2)
if os.path.exists(os.path.join(destination, "hub.sqlite3")):
    print("destination already contains hub.sqlite3; refusing legacy migration", file=sys.stderr); raise SystemExit(2)
os.makedirs(destination, mode=0o700, exist_ok=True)
for entry in os.listdir(source):
    src, dst = os.path.join(source, entry), os.path.join(destination, entry)
    if os.path.isdir(src): shutil.copytree(src, dst, dirs_exist_ok=True)
    else: shutil.copy2(src, dst)
'''
    remote_python(target, script, source, target.data_root)


def service_exists(target: Target) -> bool:
    return remote(target, ["systemctl", "--user", "status", SERVICE_NAME, "--no-pager"], check=False).returncode == 0


def stop_service(target: Target) -> None:
    remote(target, ["systemctl", "--user", "stop", SERVICE_NAME], check=False)


def start_service(target: Target) -> None:
    remote(target, ["systemctl", "--user", "daemon-reload"])
    remote(target, ["systemctl", "--user", "enable", "--now", SERVICE_NAME])


def snapshot(target: Target, backup_root: str) -> None:
    script = r'''
import os, shutil, sys
data, quadlet, config, backup = sys.argv[1:5]
if os.path.exists(backup): raise SystemExit("backup target already exists")
os.makedirs(backup, mode=0o700)
if os.path.isdir(data): shutil.copytree(data, os.path.join(backup, "data"))
if os.path.isfile(quadlet): shutil.copy2(quadlet, os.path.join(backup, "quadlet.container"))
if os.path.isfile(config): shutil.copy2(config, os.path.join(backup, "manager.toml"))
'''
    remote_python(target, script, target.data_root, target.quadlet_file, target.config_file, backup_root)


def restore_snapshot(target: Target, backup_root: str) -> None:
    script = r'''
import os, shutil, sys
data, quadlet, config, backup = sys.argv[1:5]
source_data = os.path.join(backup, "data")
if os.path.exists(data): shutil.rmtree(data)
if os.path.isdir(source_data): shutil.copytree(source_data, data)
else: os.makedirs(data, mode=0o700)
source_quadlet = os.path.join(backup, "quadlet.container")
if os.path.isfile(source_quadlet):
    os.makedirs(os.path.dirname(quadlet), mode=0o700, exist_ok=True); shutil.copy2(source_quadlet, quadlet)
else:
    try: os.unlink(quadlet)
    except FileNotFoundError: pass
source_config = os.path.join(backup, "manager.toml")
if os.path.isfile(source_config):
    os.makedirs(os.path.dirname(config), mode=0o700, exist_ok=True); shutil.copy2(source_config, config)
'''
    remote_python(target, script, target.data_root, target.quadlet_file, target.config_file, backup_root)


def write_deployment(target: Target, deployment: dict[str, Any], history_name: str) -> None:
    content = (json.dumps(deployment, sort_keys=True, separators=(",", ":")) + "\n").encode()
    atomic_remote_write(target, target.deployment_file, content)
    atomic_remote_write(target, f"{target.history_root}/{history_name}.json", content)


def wait_healthy(target: Target, expected_commit: str, timeout: int = HEALTH_TIMEOUT_SECONDS) -> bool:
    host = "127.0.0.1" if target.host_bind_ip == "0.0.0.0" else target.host_bind_ip
    script = r'''
import json, sys, urllib.request
with urllib.request.urlopen(f"http://{sys.argv[1]}:{sys.argv[2]}/api/health", timeout=3) as response:
    print(json.dumps(json.load(response)))
'''
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            result = json.loads(remote_python(target, script, host, str(target.host_port), check=False) or "{}")
            if result.get("status") == "ok" and result.get("commit") == expected_commit:
                return True
        except (json.JSONDecodeError, OSError):
            pass
        time.sleep(3)
    return False


def image_exists(target: Target, image: str) -> bool:
    return remote(target, ["podman", "image", "exists", image], check=False).returncode == 0


def prune_images(target: Target, keep: set[str]) -> None:
    output = remote_capture(
        target,
        ["podman", "images", "--filter", f"label={PROJECT_LABEL}", "--format", "{{.Repository}}:{{.Tag}}"],
        check=False,
    )
    for image in {line.strip() for line in output.splitlines() if line.strip()} - keep:
        remote(target, ["podman", "image", "rm", image], check=False)


def confirm_production(target: Target, yes: bool, action: str) -> None:
    if target.environment != "prod" or yes:
        return
    if input(f"Type DEPLOY to {action} production: ") != "DEPLOY":
        raise SystemExit("Cancelled")


def deploy(target: Target, yes: bool) -> int:
    confirm_production(target, yes, "deploy")
    previous = remote_json(target, target.deployment_file)
    preflight(target, require_free_port=previous is None and target.legacy_hub_root is not None)
    release = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S-%f")
    commit = git_commit()
    build_date = utc_now()
    image = f"{IMAGE_REPOSITORY}:{release}"
    operation_id = secrets.token_hex(16)
    begin_operation(target, operation_id, "deploy")
    print(f"Deployment operation: {operation_id}")
    backup_root = f"{target.backups_root}/{release}-before-deploy"
    initial_password: str | None = None
    service_was_present = previous is not None or service_exists(target)
    snapshot_created = False
    service_stopped = False
    quadlet_replaced = False
    try:
        remote_dir = upload_release(target, release)
        build_image(target, remote_dir, image, commit, build_date)
        candidate_quadlet = quadlet(target, image, commit, build_date)
        validate_quadlet(target, candidate_quadlet, remote_dir)
        initial_password = ensure_secret(target)
        if initial_password:
            print("Initial hub username: admin")
            print(f"Initial hub password: {initial_password}")
            print("Save this password now; it will not be displayed again.")
        remote(target, ["mkdir", "-p", target.data_root, target.backups_root, target.history_root])
        if previous is None:
            migrate_legacy_data(target)
        if service_was_present:
            stop_service(target)
            service_stopped = True
        snapshot(target, backup_root)
        snapshot_created = True
        atomic_remote_write(target, target.config_file, manager_config(target).encode())
        atomic_remote_write(target, target.quadlet_file, candidate_quadlet.encode())
        quadlet_replaced = True
        start_service(target)
        service_stopped = False
        if not wait_healthy(target, commit):
            raise RuntimeError("new hub image did not pass its commit-aware health check")
        previous_summary = None
        if previous:
            previous_summary = {key: previous.get(key) for key in ("release", "image", "commit", "buildDate")}
        deployment = {
            "release": release,
            "image": image,
            "commit": commit,
            "buildDate": build_date,
            "deployedAt": utc_now(),
            "previous": previous_summary,
            "rollbackBackup": backup_root if previous else None,
        }
        write_deployment(target, deployment, release)
        keep = {image}
        if previous and isinstance(previous.get("image"), str):
            keep.add(previous["image"])
        prune_images(target, keep)
        print(f"Hub deployment {release} completed: http://{target.host_bind_ip}:{target.host_port}")
        return 0
    except Exception as error:
        print(f"Deployment failed: {error}", file=sys.stderr)
        if quadlet_replaced:
            stop_service(target)
        if service_was_present and snapshot_created:
            restore_snapshot(target, backup_root)
            start_service(target)
            if previous and isinstance(previous.get("commit"), str) and not wait_healthy(target, previous["commit"]):
                print("Rollback was restored but the previous hub did not become healthy", file=sys.stderr)
        elif service_was_present and service_stopped:
            start_service(target)
        elif snapshot_created:
            restore_snapshot(target, backup_root)
            remote(target, ["systemctl", "--user", "daemon-reload"], check=False)
        raise
    finally:
        end_operation(target, operation_id, check=False)


def find_rollback_record(target: Target, requested: str) -> tuple[dict[str, Any], dict[str, Any]]:
    script = r'''
import glob, json, os, sys
deployment_file, history_root, requested = sys.argv[1:4]
with open(deployment_file, encoding="utf-8") as handle: current = json.load(handle)
target_release = (current.get("previous") or {}).get("release") if requested == "previous" else requested
if not target_release: raise SystemExit("no previous release is recorded")
records = [current]
for path in glob.glob(os.path.join(history_root, "*.json")):
    try:
        with open(path, encoding="utf-8") as handle: records.append(json.load(handle))
    except (OSError, json.JSONDecodeError): pass
for record in records:
    previous = record.get("previous") or {}
    if previous.get("release") == target_release and record.get("rollbackBackup"):
        print(json.dumps({"current": current, "target": previous, "backup": record["rollbackBackup"]})); break
else: raise SystemExit(f"no compatible backup is recorded for release {target_release}")
'''
    result = json.loads(remote_python(target, script, target.deployment_file, target.history_root, requested))
    return result, result["target"]


def rollback(target: Target, requested: str, yes: bool) -> int:
    confirm_production(target, yes, "rollback")
    preflight(target)
    record, rollback_target = find_rollback_record(target, requested)
    operation_id = secrets.token_hex(16)
    begin_operation(target, operation_id, "rollback")
    print(f"Deployment operation: {operation_id}")
    now = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    rescue_backup = f"{target.backups_root}/{now}-before-rollback"
    current = record["current"]
    snapshot_created = False
    service_stopped = False
    quadlet_replaced = False
    try:
        image = str(rollback_target["image"])
        release = str(rollback_target["release"])
        commit = str(rollback_target["commit"])
        build_date = str(rollback_target.get("buildDate") or "unknown")
        if not image_exists(target, image):
            build_image(target, f"{target.releases_root}/{release}", image, commit, build_date)
        candidate_quadlet = quadlet(target, image, commit, build_date)
        validate_quadlet(target, candidate_quadlet, f"{target.releases_root}/{release}")
        stop_service(target)
        service_stopped = True
        snapshot(target, rescue_backup)
        snapshot_created = True
        restore_snapshot(target, str(record["backup"]))
        atomic_remote_write(target, target.config_file, manager_config(target).encode())
        atomic_remote_write(target, target.quadlet_file, candidate_quadlet.encode())
        quadlet_replaced = True
        start_service(target)
        service_stopped = False
        if not wait_healthy(target, commit):
            raise RuntimeError("rollback target did not pass health check")
        deployment = {
            "release": release,
            "image": image,
            "commit": commit,
            "buildDate": build_date,
            "deployedAt": utc_now(),
            "previous": {key: current.get(key) for key in ("release", "image", "commit", "buildDate")},
            "rollbackBackup": rescue_backup,
        }
        write_deployment(target, deployment, f"rollback-{now}")
        prune_images(target, {image, str(current.get("image", ""))})
        print(f"Rolled back to release {release}")
        return 0
    except Exception:
        if quadlet_replaced:
            stop_service(target)
        if snapshot_created:
            restore_snapshot(target, rescue_backup)
            start_service(target)
            if isinstance(current.get("commit"), str):
                wait_healthy(target, current["commit"])
        elif service_stopped:
            start_service(target)
        raise
    finally:
        end_operation(target, operation_id, check=False)


def status(target: Target) -> int:
    return remote(target, ["systemctl", "--user", "status", SERVICE_NAME, "--no-pager"]).returncode


def logs(target: Target) -> int:
    return remote(target, ["journalctl", "--user", "-u", SERVICE_NAME, "-n", "200", "--no-pager"]).returncode


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("environment", choices=("dev", "prod"))
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--check", action="store_true")
    actions.add_argument("--status", action="store_true")
    actions.add_argument("--logs", action="store_true")
    actions.add_argument("--rollback", nargs="?", const="previous", metavar="RELEASE")
    actions.add_argument("--recover-operation", metavar="OPERATION_ID")
    parser.add_argument("--yes", action="store_true", help="skip the production confirmation")
    args = parser.parse_args()
    target = load_target(args.environment)
    if args.check:
        preflight(target, require_free_port=target.legacy_hub_root is not None and remote_json(target, target.deployment_file) is None)
        print(f"Deployment preflight OK: {target.ssh}")
        return 0
    if args.status:
        return status(target)
    if args.logs:
        return logs(target)
    if args.recover_operation:
        recover_operation(target, args.recover_operation)
        return 0
    if args.rollback:
        return rollback(target, args.rollback, args.yes)
    return deploy(target, args.yes)


if __name__ == "__main__":
    raise SystemExit(main())
