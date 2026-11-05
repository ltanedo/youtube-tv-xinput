#!/usr/bin/env python3
"""Start or inspect the manual Android TV Codemagic build without logging secrets."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
APP_ID = "6ae16c0cf2ec2b2a22c3fee2"
WORKFLOW = "android-tv-debug"


def api(path, payload=None):
    token = os.environ.get("CODEMAGIC_API_TOKEN")
    if not token:
        path_to_token = Path(os.environ.get("CODEMAGIC_TOKEN_FILE", "~/.config/codemagic/api-token")).expanduser()
        if not path_to_token.is_file():
            raise RuntimeError("Set CODEMAGIC_API_TOKEN or CODEMAGIC_TOKEN_FILE to an existing private credential")
        token = path_to_token.read_text().strip()
    request = urllib.request.Request(
        "https://api.codemagic.io/" + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"x-auth-token": token, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Codemagic API returned HTTP {error.code}") from None


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--status", metavar="BUILD_ID", help="Inspect an existing build without starting another")
    parser.add_argument("--branch", help="Build branch (default: current branch; must match local HEAD)")
    args = parser.parse_args()
    if args.status:
        if not all(c in "0123456789abcdef" for c in args.status) or len(args.status) != 24:
            raise ValueError("Expected a 24-character Codemagic build ID")
        data = api("builds/" + args.status)
        build = data.get("build", data)
        print(json.dumps({"id": args.status, "status": build.get("status"),
            "artifacts": [a.get("name") for a in build.get("artefacts", build.get("artifacts", []))]}, indent=2))
        return
    if git("status", "--porcelain"):
        raise RuntimeError("Commit intended changes before starting a build")
    branch = args.branch or git("branch", "--show-current")
    if not branch:
        raise RuntimeError("Select a branch; detached HEAD cannot be built")
    git("check-ref-format", "--branch", branch)
    commit = git("rev-parse", "HEAD")
    remote = git("ls-remote", "origin", "refs/heads/" + branch).split()
    if not remote or remote[0] != commit:
        raise RuntimeError("Push the branch first; remote HEAD must match this checkout")
    result = api("builds", {"appId": APP_ID, "workflowId": WORKFLOW, "branch": branch,
        "labels": ["android-tv", commit[:12]]})
    build_id = result["buildId"]
    print(json.dumps({"buildId": build_id, "commit": commit,
        "url": f"https://codemagic.io/app/{APP_ID}/build/{build_id}"}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, OSError) as error:
        raise SystemExit(str(error)) from None
