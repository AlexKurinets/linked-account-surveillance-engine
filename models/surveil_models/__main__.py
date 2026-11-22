"""Command line and long-lived worker for the modelling jobs.

    python -m surveil_models coactivity --as-of 2026-03-15T06:00:00Z
    python -m surveil_models train-anomaly --as-of ...
    python -m surveil_models train-scorer --as-of ...
    python -m surveil_models serve          # JSON commands on stdin, one result per line

The replay keeps one `serve` process open so it pays the scipy/scikit-learn
import cost once instead of on every six-hourly job.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime

import psycopg

from . import anomaly, coactivity, scorer
from .config import database_url, load_engine, load_rules


def _seconds(iso: str) -> float:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def dispatch(conn, cmd: str, as_of: float) -> dict:
    engine = load_engine()
    if cmd == "coactivity":
        return coactivity.run(conn, as_of, engine["linking"]["coactivity"])
    if cmd == "train-anomaly":
        return anomaly.run(conn, as_of, engine)
    if cmd == "train-scorer":
        return scorer.run(conn, as_of, engine, load_rules())
    raise ValueError(f"unknown command {cmd}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="surveil_models")
    ap.add_argument("cmd", choices=["coactivity", "train-anomaly", "train-scorer", "serve"])
    ap.add_argument("--as-of", help="event time to run as of (ISO 8601)")
    args = ap.parse_args(argv)
    with psycopg.connect(database_url(), autocommit=True) as conn:
        if args.cmd != "serve":
            print(json.dumps(dispatch(conn, args.cmd, _seconds(args.as_of))))
            return 0
        for line in sys.stdin:
            if not line.strip():
                continue
            req = json.loads(line)
            try:
                out = {"ok": True, "result": dispatch(conn, req["cmd"], _seconds(req["as_of"]))}
            except Exception as exc:  # report and keep serving
                conn.rollback() if not conn.autocommit else None
                out = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
            sys.stdout.write(json.dumps(out) + "\n")
            sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
