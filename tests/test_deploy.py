import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import deploy


class DeployTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.original_deploy_file = deploy.DEPLOY_FILE
        deploy.DEPLOY_FILE = Path(self.temp.name) / "deploy.toml"
        deploy.DEPLOY_FILE.write_text(
            '[dev]\nserver="10.0.0.5"\nusername="games"\n'
            'host_bind_ip="127.0.0.1"\nhost_port=4000\n'
            'repos_root="/home/games/game-managers"\n',
            encoding="utf-8",
        )

    def tearDown(self):
        deploy.DEPLOY_FILE = self.original_deploy_file
        self.temp.cleanup()

    def target(self):
        return deploy.load_target("dev")

    def test_target_paths_are_stable_and_user_scoped(self):
        target = self.target()
        self.assertEqual("/home/games/.local/share/game-servers-hub/data", target.data_root)
        self.assertEqual(
            "/home/games/.config/containers/systemd/game-servers-hub.container",
            target.quadlet_file,
        )
        self.assertEqual("/home/games/.local/share/game-server-managers", target.manager_state_root)

    def test_repositories_path_must_be_absolute_and_whitespace_free(self):
        deploy.DEPLOY_FILE.write_text(
            '[dev]\nserver="host"\nusername="games"\nrepos_root="relative path"\n',
            encoding="utf-8",
        )
        with self.assertRaisesRegex(SystemExit, "absolute path"):
            deploy.load_target("dev")

    def test_quadlet_uses_rootless_socket_secret_and_same_absolute_paths(self):
        target = self.target()
        text = deploy.quadlet(target, "localhost/game-servers-hub:release", "abc123", "date")
        self.assertIn("Requires=podman.socket", text)
        self.assertIn("Volume=%t/podman/podman.sock:/run/podman/podman.sock", text)
        self.assertIn("Secret=game-servers-hub-secrets,type=mount,target=manager.secrets.toml,mode=0600", text)
        self.assertIn(f"Volume={target.data_root}:{target.data_root}:rw", text)
        self.assertIn(f"Volume={target.arma_root}:{target.arma_root}:ro", text)
        self.assertIn('Environment="CONTAINER_HOST=unix:///run/podman/podman.sock"', text)
        self.assertNotIn("password", text.lower())

    @patch.object(deploy, "remote")
    @patch.object(deploy, "remote_python", return_value="/usr/lib/systemd/system-generators/podman-system-generator")
    @patch.object(deploy, "atomic_remote_write")
    def test_quadlet_is_validated_in_isolated_remote_directory(self, write, remote_python, remote):
        target = self.target()
        deploy.validate_quadlet(target, "[Container]\nImage=test\n", "/remote/release")
        write.assert_called_once_with(
            target,
            "/remote/release/quadlet-validation/game-servers-hub.container",
            b"[Container]\nImage=test\n",
        )
        command = remote.call_args.args[1]
        self.assertEqual("env", command[0])
        self.assertIn("QUADLET_UNIT_DIRS=/remote/release/quadlet-validation", command)
        self.assertEqual(["--user", "--dryrun"], command[-2:])
        remote_python.assert_called_once()

    def test_container_config_binds_inside_container_only(self):
        text = deploy.manager_config(self.target())
        self.assertIn('bind_ip = "0.0.0.0"', text)
        self.assertIn("port = 4000", text)
        self.assertNotIn("password", text.lower())

    @patch.object(deploy, "remote")
    @patch.object(deploy, "secret_exists", return_value=False)
    def test_new_secret_is_sent_through_stdin_not_arguments(self, _exists, remote):
        password = deploy.ensure_secret(self.target())
        self.assertIsNotNone(password)
        args = remote.call_args.args[1]
        payload = remote.call_args.kwargs["input_data"]
        self.assertEqual(["podman", "secret", "create", deploy.SECRET_NAME, "-"], args)
        self.assertNotIn(password, " ".join(args))
        self.assertIn(password.encode(), payload)

    @patch.object(deploy, "remote")
    @patch.object(deploy, "secret_exists", return_value=True)
    def test_existing_secret_is_never_replaced(self, _exists, remote):
        self.assertIsNone(deploy.ensure_secret(self.target()))
        remote.assert_not_called()

    def test_container_context_excludes_private_and_mutable_state(self):
        ignored = (deploy.ROOT / ".containerignore").read_text(encoding="utf-8")
        for entry in (".git", "node_modules", "data", "config/manager.secrets.toml", "deploy.toml"):
            self.assertIn(entry, ignored)

    def test_every_containerfile_stage_has_project_label(self):
        lines = (deploy.ROOT / "Containerfile").read_text(encoding="utf-8").splitlines()
        stages = [index for index, line in enumerate(lines) if line.startswith("FROM ")]
        self.assertEqual(2, len(stages))
        for index in stages:
            self.assertEqual("LABEL project=game-servers-hub", lines[index + 1])
        containerfile = "\n".join(lines)
        self.assertIn("org.opencontainers.image.revision", containerfile)
        self.assertIn("org.opencontainers.image.created", containerfile)

    def test_deploy_file_and_python_cache_are_ignored(self):
        ignored = (deploy.ROOT / ".gitignore").read_text(encoding="utf-8")
        self.assertIn("deploy.toml", ignored)
        self.assertIn("__pycache__/", ignored)


if __name__ == "__main__":
    unittest.main()
