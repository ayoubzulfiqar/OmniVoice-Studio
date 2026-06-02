"""DB migration — boot against a copy of the checked-in omnivoice_data fixture so
alembic runs its UPGRADE path on existing user data (backward-compat constraint).
Subprocess-isolated; the model load is short-circuited."""

from __future__ import annotations

import os

from . import env
from . import spec as probe_spec

_SPEC = os.path.join(os.path.dirname(__file__), "specs", "migration.probe.yaml")


def test_migration_upgrades_existing_data(probe_report):
    spec = probe_spec.load_spec(_SPEC)
    with env.seeded_data_dir() as data_dir:
        context = env.capture_first_run(data_dir)
        db_ok = context["db_created"]
    results = probe_spec.run_judges(spec, context)
    probe_report.record(spec, results)
    assert probe_spec.blocking_failures(results) == [], "\n".join(str(r) for r in results)
    # Migrations ran cleanly on existing data and the DB is intact.
    assert db_ok
