"""Exercise the downloadable shell entrypoint without real accounts or downloads."""

import contextlib
import io
import json
import os
from pathlib import Path
import pty
import select
import shlex
import signal
import subprocess
import tempfile
import time
import types
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[3] / "public" / "download-reel.sh"
SOURCE = SCRIPT.read_text().split("<<'PYTHON'\n", 1)[1].rsplit("\nPYTHON", 1)[0]
reel = types.ModuleType("download_reel")
exec(compile(SOURCE, str(SCRIPT), "exec"), reel.__dict__)
FACEBOOK_URL = "https://www.facebook.com/reel/28447394274902429"
TIKTOK_URL = "https://www.tiktok.com/@example/video/1234567890"
MEDIA_URL = "https://video.example.fbcdn.net/clip.mp4?token=public&test=1"
MP4 = b"\x00\x00\x00\x18ftypisom" + b"\x00" * 32


def response(body, length=None):
    stream = io.BytesIO(body)
    stream.headers = {"Content-Length": str(len(body) if length is None else length)}
    return stream


def run_in_terminal(command, answer, timeout=10):
    """Run a real pipe with a controlling terminal, paste only after the prompt."""
    pid, terminal = pty.fork()
    if pid == 0:
        os.execv("/bin/bash", ["bash", "-c", command])
    transcript = bytearray()
    sent = False
    finished = False
    deadline = time.monotonic() + timeout
    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select([terminal], [], [], 0.1)
            if ready:
                try:
                    chunk = os.read(terminal, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                transcript.extend(chunk)
                if not sent and b"then press Enter: " in transcript:
                    os.write(terminal, answer)
                    sent = True
            child, status = os.waitpid(pid, os.WNOHANG)
            if child:
                finished = True
                return os.waitstatus_to_exitcode(status), transcript.decode(), sent
        child, status = os.waitpid(pid, os.WNOHANG)
        if child:
            finished = True
            return os.waitstatus_to_exitcode(status), transcript.decode(), sent
        raise AssertionError("Terminal command did not finish: " + transcript.decode())
    finally:
        os.close(terminal)
        if not finished:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)


class DownloadReelTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="hub-reel-")
        self.addCleanup(self.directory.cleanup)
        self.folder = Path(self.directory.name).resolve()

    def test_shell_entrypoint_works_as_file_and_piped_script(self):
        for command, source in ((["bash", str(SCRIPT), "--help"], None),
                                (["bash", "-s", "--", "--help"], SCRIPT.read_text())):
            with self.subTest(command=command):
                result = subprocess.run(command, input=source, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("--platform {tiktok,facebook}", result.stdout)

    def test_omitted_url_prompts_and_validates_terminal_input(self):
        with mock.patch("builtins.open", mock.mock_open(read_data="  " + FACEBOOK_URL + "  \n")) as terminal:
            args = reel.parse_args(["--platform=facebook"])
        self.assertEqual(args.url, FACEBOOK_URL)
        self.assertIn(mock.call("/dev/tty", "r", encoding="utf-8"), terminal.call_args_list)
        self.assertIn(mock.call("/dev/tty", "w", encoding="utf-8"), terminal.call_args_list)
        terminal().write.assert_any_call("Paste facebook video URL, then press Enter: ")
        terminal().flush.assert_called()

    def test_explicit_url_never_opens_terminal(self):
        for arguments in ([FACEBOOK_URL], ["--url=" + FACEBOOK_URL], ["--url", FACEBOOK_URL]):
            with self.subTest(arguments=arguments), mock.patch("builtins.open") as terminal:
                self.assertEqual(reel.parse_args(["--platform=facebook"] + arguments).url, FACEBOOK_URL)
            terminal.assert_not_called()

    def test_url_option_rejects_empty_mismatched_and_conflicting_links_without_prompt(self):
        for arguments in (["--url="], ["--url=" + TIKTOK_URL],
                          ["--url=" + FACEBOOK_URL, FACEBOOK_URL]):
            with self.subTest(arguments=arguments), contextlib.redirect_stderr(io.StringIO()):
                with mock.patch.object(reel, "prompt_url") as prompt:
                    with self.assertRaises(SystemExit) as error:
                        reel.parse_args(["--platform=facebook"] + arguments)
                    self.assertEqual(error.exception.code, 2)
                    prompt.assert_not_called()

    def test_piped_script_accepts_url_option_without_a_terminal(self):
        result = subprocess.run(
            ["bash", "-s", "--", "--platform=facebook", "--url=" + TIKTOK_URL],
            input=SCRIPT.read_text(), capture_output=True, text=True, start_new_session=True,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("matching --platform", result.stderr)
        self.assertNotIn("interactive terminal", result.stderr)

    def test_no_terminal_explains_how_to_supply_url(self):
        with mock.patch("builtins.open", side_effect=OSError("no tty")):
            with contextlib.redirect_stderr(io.StringIO()) as output:
                with self.assertRaises(SystemExit) as error:
                    reel.parse_args(["--platform=facebook"])
        self.assertEqual(error.exception.code, 2)
        self.assertIn("Pass the video URL with --url='VIDEO_URL'", output.getvalue())

    def test_piped_shell_reads_pasted_url_blank_and_interrupt_from_real_terminal(self):
        command = "cat %s | bash -s -- --platform=facebook" % shlex.quote(str(SCRIPT))
        for answer, expected_status, message in (
            (b"https://www.tiktok.com/@example/video/1234567890\n", 2, "matching --platform"),
            (b"\n", 2, "No URL entered"),
            (b"\x04", 2, "No URL entered"),
            (b"\x03", 130, "Download canceled"),
        ):
            with self.subTest(answer=answer):
                status, transcript, sent = run_in_terminal(command, answer)
                self.assertTrue(sent, transcript)
                self.assertEqual(status, expected_status, transcript)
                self.assertIn(message, transcript)

    def test_prompt_remains_visible_when_stderr_is_redirected(self):
        error_file = self.folder / "errors.txt"
        command = "cat %s | bash -s -- --platform=facebook 2>%s" % (
            shlex.quote(str(SCRIPT)), shlex.quote(str(error_file)),
        )
        status, transcript, sent = run_in_terminal(command, b"\n")
        self.assertTrue(sent, transcript)
        self.assertEqual(status, 2, transcript)
        self.assertIn("No URL entered", error_file.read_text())

    def test_rejects_invalid_platform_mismatch_and_profiles_before_download(self):
        cases = [
            ["--platform=youtube", TIKTOK_URL],
            ["--platform=tiktok", FACEBOOK_URL],
            ["--platform=facebook", "https://facebook.com.evil.example/reel/123"],
            ["--platform=facebook", "https://user:password@facebook.com/reel/123"],
            ["--platform=facebook", "http://facebook.com/reel/123"],
            ["--platform=facebook", "https://facebook.com/profile"],
            ["--platform=tiktok", "https://www.tiktok.com/@example"],
        ]
        for args in cases:
            with self.subTest(args=args), contextlib.redirect_stderr(io.StringIO()):
                with mock.patch.object(reel, "yt_dlp_command") as command:
                    with self.assertRaises(SystemExit) as error:
                        reel.main(args)
                    self.assertEqual(error.exception.code, 2)
                    command.assert_not_called()

    def test_accepts_supported_video_and_share_links(self):
        for platform, url in [
            ("tiktok", TIKTOK_URL),
            ("tiktok", "https://vm.tiktok.com/abc123/"),
            ("tiktok", "https://vt.tiktok.com/abc123/"),
            ("tiktok", "https://www.tiktok.com/t/abc123/"),
            ("facebook", FACEBOOK_URL),
            ("facebook", "https://www.facebook.com/watch/?v=123"),
            ("facebook", "https://www.facebook.com/name/videos/123/"),
            ("facebook", "https://www.facebook.com/share/r/abc123/"),
            ("facebook", "https://fb.watch/abc123/"),
        ]:
            with self.subTest(url=url):
                self.assertEqual(reel.parse_args(["--platform", platform, url]).url, url)

    def test_tiktok_passes_literal_url_and_output_path_without_user_config(self):
        url = TIKTOK_URL + "?caption=$(touch%20oops)&test=1"
        folder = self.folder / "space and % in folder"
        with mock.patch.object(reel, "yt_dlp_command", return_value=["yt-dlp"]):
            with mock.patch.object(reel.subprocess, "run", return_value=types.SimpleNamespace(returncode=0)) as run:
                self.assertEqual(reel.main(["--platform=tiktok", "--output-dir", str(folder), "--url=" + url]), 0)
        command = run.call_args.args[0]
        self.assertEqual(command[-2:], ["--", url])
        self.assertEqual(command[command.index("--paths") + 1], str(folder))
        self.assertIn("--ignore-config", command)
        self.assertIn("--no-overwrites", command)
        self.assertIn("--no-playlist", command)
        self.assertIn("[acodec!=none]", command[command.index("--format") + 1])

    def test_missing_tiktok_dependency_does_not_create_output_folder(self):
        folder = self.folder / "not-created"
        with mock.patch.object(reel, "yt_dlp_command", return_value=None):
            with contextlib.redirect_stderr(io.StringIO()) as output:
                self.assertEqual(reel.main(["--platform=tiktok", "--output-dir", str(folder), TIKTOK_URL]), 1)
        self.assertIn("brew install yt-dlp", output.getvalue())
        self.assertFalse(folder.exists())

    def test_tiktok_failure_is_not_reported_as_success(self):
        with mock.patch.object(reel, "yt_dlp_command", return_value=["yt-dlp"]):
            with mock.patch.object(reel, "download_with_yt_dlp", return_value=7):
                with contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(reel.main(["--platform=tiktok", "--output-dir", str(self.folder), TIKTOK_URL]), 7)

    def test_facebook_falls_back_when_extractor_fails_or_is_missing(self):
        for command in (None, ["yt-dlp"]):
            with self.subTest(command=command), contextlib.redirect_stdout(io.StringIO()):
                with mock.patch.object(reel, "yt_dlp_command", return_value=command):
                    with mock.patch.object(reel, "download_with_yt_dlp", return_value=1):
                        with mock.patch.object(reel, "download_facebook") as fallback:
                            self.assertEqual(reel.main(["--platform=facebook", "--output-dir", str(self.folder), FACEBOOK_URL]), 0)
                            fallback.assert_called_once_with(FACEBOOK_URL, self.folder)

    def test_facebook_embed_downloads_hd_and_preserves_existing_file(self):
        html = json.dumps({"sd_src": MEDIA_URL.replace("clip", "sd"), "hd_src": MEDIA_URL})
        destination = self.folder / "facebook-28447394274902429.mp4"
        with mock.patch.object(reel, "request", side_effect=[response(html.encode()), response(MP4)]) as request:
            with contextlib.redirect_stdout(io.StringIO()):
                reel.download_facebook(FACEBOOK_URL, self.folder)
                reel.download_facebook(FACEBOOK_URL, self.folder)
        self.assertEqual(destination.read_bytes(), MP4)
        self.assertEqual(request.call_count, 2)
        self.assertEqual(request.call_args.args[0], MEDIA_URL)
        self.assertEqual(list(self.folder.iterdir()), [destination])

    def test_facebook_unavailable_page_and_foreign_media_are_not_downloaded(self):
        for source in ("Log in to continue", '{"hd_src":null}',
                       '{"hd_src":"https://fbcdn.net.evil.example/video.mp4"}'):
            with self.subTest(source=source), mock.patch.object(reel, "request", return_value=response(source.encode())):
                with self.assertRaisesRegex(ValueError, "did not expose a public video"):
                    reel.download_facebook(FACEBOOK_URL, self.folder)
        self.assertEqual(list(self.folder.iterdir()), [])

    def test_failed_or_truncated_media_leaves_no_video_or_partial_file(self):
        for body, length in ((b"<html>Login</html>", None), (MP4, len(MP4) + 100)):
            with self.subTest(body=body), mock.patch.object(reel, "request", return_value=response(body, length)):
                with self.assertRaises(ValueError):
                    reel.save_facebook_video(MEDIA_URL, self.folder / "reel.mp4")
            self.assertEqual(list(self.folder.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
