"""Prepare an exact published payload in a disposable, approved contract checkout.

Git publication belongs to Super Schema. This command only prepares and validates files.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path, PurePosixPath


def run(root: Path, args: list[str]) -> None:
    try:
        subprocess.run(args, cwd=root, check=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=600)
    except subprocess.CalledProcessError as error:
        # The child receives no publishing credentials. Keep just the bounded validator diagnostic.
        raise ValueError(f"Repository gate {' '.join(args[:3])} failed: {(error.stdout or '')[-1500:]}") from error


def prepare(root: Path, request: dict) -> dict:
    sys.path.insert(0, str(root))
    # Fail closed on the old contract/toolkit instead of guessing filename conventions.
    try:
        from event_schema_central_action.scaffold import scaffold_topic, scaffold_entity
        from event_schema_central_action.model import EventContract, SchemaVersion
    except ImportError as error:
        raise ValueError("The destination needs the event_schema_central_action contract/tooling migration") from error
    import yaml

    bundle, settings = request["bundle"], request["settings"]
    identity = bundle["entity"]
    version = settings["contractVersion"]
    if not version.endswith("_snapshot"):
        raise ValueError("Git delivery prepares snapshots; promote released versions through the repository release workflow")
    if bundle["format"] not in {"avro", "json-schema"}:
        raise ValueError("Event contracts require Avro or JSON Schema payloads")
    if not settings["example"].strip():
        raise ValueError("A valid contract example is required")

    # The baseline reproduces the destination tree for its evolution check. Never use the user's checkout/index.
    run(root, ["git", "init", "-q"])
    run(root, ["git", "config", "user.name", "Super Schema validator"])
    run(root, ["git", "config", "user.email", "validator@superschema.invalid"])
    run(root, ["git", "add", "--", "."])
    run(root, ["git", "commit", "-qm", "Destination base for isolated validation"])

    tenant, domain, product, name = (identity[k] for k in ("tenant", "domain", "product", "schema"))
    unit = root / "schemas" / tenant / domain / product / name
    directory = unit / version
    exists = unit.exists()
    if settings["change"] == "create":
        if exists:
            raise ValueError("Contract exists; choose a new version or an explicit snapshot update")
        if settings["contractKind"] == "Entity":
            scaffold_entity(root, tenant=tenant, domain=domain, product=product, name=name, description=identity["name"], version=version)
        else:
            scaffold_topic(root, tenant=tenant, domain=domain, product=product, topic=name, description=identity["name"], version=version)
    elif not exists:
        raise ValueError("The existing contract was not found")
    elif settings["change"] == "new-version":
        if directory.exists():
            raise ValueError("Contract version exists; choose an explicit snapshot update")
        directory.mkdir()
    elif not directory.is_dir():
        raise ValueError("The snapshot to update does not exist")

    contract = EventContract.from_path(unit, root)
    if contract.kind != settings["contractKind"]:
        raise ValueError("The existing contract kind differs from the workflow")
    expected = "json" if bundle["format"] == "json-schema" else "avro"
    if contract.payload_format.format_id != expected:
        raise ValueError("The artifact format differs from inherited product policy")
    schema_version = SchemaVersion(contract, version, directory)
    if settings.get("expectedPayloadHash") and schema_version.schema_path.exists():
        old_hash = "sha256:" + hashlib.sha256(schema_version.schema_path.read_bytes()).hexdigest()
        if old_hash != settings["expectedPayloadHash"]:
            raise ValueError("The existing snapshot payload changed; review a new preview")
    primary = next(f for f in bundle["files"] if f["path"] == bundle["primaryFile"])
    # Keep file names and relative reference relationships. The canonical payload can also be an alias of its original name.
    primary_dir = PurePosixPath(bundle["primaryFile"]).parent
    for file in bundle["files"]:
        try:
            relative = PurePosixPath(file["path"]).relative_to(primary_dir)
        except ValueError as error:
            raise ValueError("This closure needs an explicit reusable-entity mapping before it can be represented faithfully") from error
        destination = directory / str(relative)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(file["content"], encoding="utf-8")
    schema_version.schema_path.write_text(primary["content"], encoding="utf-8")
    if schema_version.schema_path.read_text(encoding="utf-8") != primary["content"]:
        raise ValueError("Pinned payload content changed during preparation")
    metadata = yaml.safe_load(settings["metadata"]) or {}
    if not isinstance(metadata, dict):
        raise ValueError("Contract metadata must be a YAML object")
    schema_version.metadata_path.write_text(yaml.safe_dump(metadata, sort_keys=False), encoding="utf-8")
    example = yaml.safe_load(settings["example"])
    schema_version.example_path.write_text(yaml.safe_dump(example, sort_keys=False), encoding="utf-8")
    if settings["topicConfig"].strip():
        config = yaml.safe_load(settings["topicConfig"])
        if not isinstance(config, dict) or config.get("kind") != contract.kind:
            raise ValueError("Topic/entity configuration must declare the correct kind")
        contract.topic_config_path.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")

    fqn = f"{tenant}.{domain}.{product}.{name}:{version}"
    python = sys.executable
    if contract.kind == "Topic":
        run(root, [python, "-m", "event_schema_central_action", "generate", fqn])
        run(root, [python, "-m", "tools.render_sdk", fqn])
    run(root, [python, "-m", "tools.generate_product_manifest", "--out", "product-manifest.json"])
    run(root, ["make", f"VENV_PYTHON={python}", "check"])
    run(root, ["git", "add", "--", str(unit.relative_to(root)), "product-manifest.json"])
    run(root, [python, "-m", "tools.check_evolution", "--base-ref", "HEAD", "--head-ref", subprocess.check_output(["git", "write-tree"], cwd=root, text=True).strip()])
    changed = subprocess.check_output(["git", "diff", "--cached", "--name-only", "-z"], cwd=root).decode().split("\0")
    files = []
    for item in filter(None, changed):
        if item != "product-manifest.json" and not item.startswith(str(unit.relative_to(root)) + "/"):
            raise ValueError("Preparation attempted to stage an unrelated path")
        file = root / item
        if not file.is_file() or file.is_symlink():
            raise ValueError("Contract preparation cannot delete or follow symlinked artifacts")
        files.append({"path": item, "content": file.read_text(encoding="utf-8")})
    if not files:
        # A repeated intent can still submit the same reviewed contract without making up a schema change.
        files = [{"path": str(schema_version.schema_path.relative_to(root)), "content": primary["content"]}]
    return {"files": files, "validation": ["Pinned payload bytes preserved", "Destination make check passed", "Prospective-tree evolution check passed", "Only contract and product-manifest changes included"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    output = Path(os.environ["DEPLOYMENT_OUTPUT"])
    try:
        result = prepare(args.root.resolve(), json.loads(Path(os.environ["DEPLOYMENT_INPUT"]).read_text()))
    except Exception as error:
        output.write_text(json.dumps({"error": str(error)[:2000]}))
        raise SystemExit(1) from error
    output.write_text(json.dumps(result))
