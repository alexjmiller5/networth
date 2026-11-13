"""Ordering and injected commit faults, not physical power-loss experiments."""

import errno
import json
import os
import stat
from pathlib import Path

import pytest
from test_host import NAME, RUN_ID, FakeApi, run
from test_native_host import FakeCore

from networth_host import cli
from networth_host.cli import Config, HerdrError, NativeHost


def make_host(tmp_path):
    cfg = Config(url="https://networth.example", state_dir=tmp_path, runtime="core", workspace="space-example")
    core = FakeCore()
    return NativeHost(cfg, FakeApi(), core), core


def test_receipt_file_sync_precedes_rename_and_directory_commit(tmp_path, monkeypatch):
    host, _ = make_host(tmp_path)
    events = []
    sync, replace = os.fsync, os.replace

    def fsync(fd):
        events.append("directory" if stat.S_ISDIR(os.fstat(fd).st_mode) else "file")
        return sync(fd)

    def rename(*args):
        events.append("rename")
        return replace(*args)

    monkeypatch.setattr(cli.os, "fsync", fsync)
    monkeypatch.setattr(cli.os, "replace", rename)
    host.remember(RUN_ID, {"native_phase": "delivering"})
    assert "file" in events and "directory" in events
    assert events.index("file") < events.index("rename") < len(events) - 1
    assert events[-1] == "directory"


@pytest.mark.parametrize("phase", ["starting", "delivering", "cancel"])
@pytest.mark.parametrize("fault", ["file", "rename", "directory"])
def test_failed_intent_commit_never_starts_or_sends(tmp_path, monkeypatch, phase, fault):
    host, core = make_host(tmp_path)
    if phase == "cancel":
        host.launch(run())
    baseline = sum(m == "terminal.send" for m, _ in core.calls)
    sync, replace = os.fsync, os.replace
    renamed = False

    def relevant(value):
        return value.get("cancel_delivery") == "delivering" if phase == "cancel" else value.get("native_phase") == phase

    def fsync(fd):
        is_file = stat.S_ISREG(os.fstat(fd).st_mode)
        if fault == "file" and is_file and relevant(json.loads(os.pread(fd, 65536, 0))):
            raise OSError(errno.EIO, "injected receipt file sync failure")
        if fault == "directory" and renamed and stat.S_ISDIR(os.fstat(fd).st_mode):
            raise OSError(errno.EIO, "injected receipt directory commit failure")
        return sync(fd)

    def rename(src, dst):
        nonlocal renamed
        matches = relevant(json.loads(Path(src).read_text()))
        if fault == "rename" and matches:
            raise OSError(errno.EIO, "injected receipt rename failure")
        replace(src, dst)
        renamed = renamed or matches

    monkeypatch.setattr(cli.os, "fsync", fsync)
    monkeypatch.setattr(cli.os, "replace", rename)
    with pytest.raises(OSError):
        host.cancel_prompt(NAME, RUN_ID) if phase == "cancel" else host.launch(run())
    assert sum(m == "terminal.send" for m, _ in core.calls) == baseline
    assert sum(m == "terminal.run" for m, _ in core.calls) == (0 if phase == "starting" else 1)


@pytest.mark.parametrize("phase", ["initial", "cancel"])
@pytest.mark.parametrize("fault", ["file", "rename", "directory"])
def test_failed_ack_commit_keeps_no_replay_boundary(tmp_path, monkeypatch, fault, phase):
    host, core = make_host(tmp_path)
    sync, replace = os.fsync, os.replace
    renamed = False
    if phase == "cancel":
        host.launch(run())
    baseline = sum(m == "terminal.send" for m, _ in core.calls)
    field = "cancel_delivery" if phase == "cancel" else "native_phase"

    def fsync(fd):
        is_file = stat.S_ISREG(os.fstat(fd).st_mode)
        if fault == "file" and is_file and json.loads(os.pread(fd, 65536, 0)).get(field) == "delivered":
            raise OSError(errno.EIO, "injected acknowledged receipt file failure")
        if fault == "directory" and renamed and stat.S_ISDIR(os.fstat(fd).st_mode):
            raise OSError(errno.EIO, "injected acknowledged receipt commit failure")
        return sync(fd)

    def rename(src, dst):
        nonlocal renamed
        delivered = json.loads(Path(src).read_text()).get(field) == "delivered"
        if fault == "rename" and delivered:
            raise OSError(errno.EIO, "injected acknowledged receipt rename failure")
        replace(src, dst)
        renamed = renamed or delivered

    with monkeypatch.context() as patch:
        patch.setattr(cli.os, "fsync", fsync)
        patch.setattr(cli.os, "replace", rename)
        with pytest.raises(OSError):
            host.cancel_prompt(NAME, RUN_ID) if phase == "cancel" else host.launch(run())
    assert sum(m == "terminal.send" for m, _ in core.calls) == baseline + 1
    restarted = NativeHost(host.cfg, host.api, core)
    try:
        restarted.cancel_prompt(NAME, RUN_ID) if phase == "cancel" else restarted.launch(run())
    except HerdrError as error:
        assert error.code == "uncertain_delivery"
    assert sum(m == "terminal.send" for m, _ in core.calls) == baseline + 1


def test_darwin_fullsync_failure_blocks_launch(tmp_path, monkeypatch):
    import fcntl

    host, core = make_host(tmp_path)
    monkeypatch.setattr(cli.sys, "platform", "darwin")
    monkeypatch.setattr(fcntl, "F_FULLFSYNC", 51, raising=False)

    def fail(fd, operation):
        assert operation == fcntl.F_FULLFSYNC
        raise OSError(errno.EIO, "injected fullsync failure")

    monkeypatch.setattr(fcntl, "fcntl", fail)
    with pytest.raises(OSError):
        host.launch(run())
    assert not any(method in {"terminal.run", "terminal.send"} for method, _ in core.calls)


def test_report_and_receipt_removal_commit_directory(tmp_path, monkeypatch):
    host, _ = make_host(tmp_path)
    directories = []
    sync = cli._sync_receipt_directory

    def record(directory):
        directories.append(directory)
        sync(directory)

    monkeypatch.setattr(cli, "_sync_receipt_directory", record)
    path = cli.queue_report(tmp_path, RUN_ID, "done", "Synthetic result")
    assert directories[-1] == path.parent
    host.remember(RUN_ID, {})
    host.forget()
    assert directories[-1] == tmp_path
    assert not host._active_path.exists()
